/**
 * The supervisor step function (U8): ties dispatch, evidence, acceptance, and
 * phase transitions together. One step = the plan's U8 approach sequence:
 *
 *   1. reconstruct state from journal + lease.lock (R42, U3 replay)
 *   2. reconcile any non-terminal dispatch intents (R37, once per session)
 *   3. evaluate budget predicates (R81: takes remaining, rework remaining,
 *      no-progress polls, cost ceiling; duration is enforced via deadlines)
 *   4. find dispatch-eligible units (R14: all dependencies terminal-accepted)
 *   5. dispatch within the concurrency cap (R75) or poll in-flight specialists
 *   6. on terminal -> harvest evidence (U6) -> grade + evaluate acceptance (U7)
 *   7. if accepted -> integration check (R54) -> integrate -> mark accepted;
 *      if not -> bounded rework or escalation (KTD13, R77-R79)
 *   8. transition phase per the FSM (KTD14); journal `phase_transition` if changed
 *
 * The step is driven by the lease-holding driver. Cross-step, per-session
 * observations (live handles, pre-dispatch usage snapshots, no-progress poll
 * streaks) live in `StepRuntime`, which is created once per driver session and
 * recreated on resume — no-progress is never claimed across a downtime gap
 * (R76, KTD12). Budget-predicate failures route to escalation or stop, never
 * silent skip (R81).
 */
import * as fs from "fs";
import * as path from "path";
import {
  defaultGitCommitReader,
  dispatchUnit,
  harvestEnvelope,
  isPastDeadline,
  isTerminalLifecycle,
  reconcileIntents,
  refusePastDeadline,
  type DispatchContext,
  type DispatchRef,
  type GitCommitReader,
  type HandleResolver,
} from "./dispatch";
import {
  harvestEvidence,
  takeContinuityRecord,
  verifyCustodyChain,
  workspaceHash,
  type CommandRunner,
  type DiffRunner,
  type UsageSnapshot,
} from "./evidence";
import { evaluateUnitAcceptance } from "./acceptance";
import { gradeCriterion, type CriterionGrade } from "./grading";
import { ensurePhase } from "./fsm";
import { raiseEscalation, type EscalationSummary } from "./escalation";
import { defaultEnvelopePath, readEnvelope, type ResultEnvelope } from "./envelope";
import type { PaseoAdapter, PaseoHandle } from "./adapter/paseo";
import type { RunStore } from "./run-store";
import type {
  Config,
  DerivedState,
  InFlightIntent,
  JournalEvent,
  PlanUnit,
  SpecialistRole,
  UnitId,
} from "./types";

/** An honest "no usage recorded" snapshot (U6: null deltas, never fabricated). */
export const EMPTY_USAGE: UsageSnapshot = {
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  costUsd: null,
};

// ---------------------------------------------------------------------------
// Contexts and outcomes
// ---------------------------------------------------------------------------

/** Everything the step function needs to act on one run. */
export interface StepContext {
  store: RunStore;
  adapter: PaseoAdapter;
  /** The canonical repo root: source of the base commit (A6). */
  repoRoot: string;
  /** The canonical worktree the accepted `creates:` files integrate into (R89). */
  canonicalWorktree: string;
  /** Thresholds (admission-time snapshot, R80). */
  config: Config;
  /** Handle lookup for intent-without-created reconciliation (R37). */
  handleResolver?: HandleResolver;
  /** Reads the worktree HEAD commit; defaults to the git CLI reader. */
  gitReader?: GitCommitReader;
  /** `~/.paseo/orchestration-preferences.json` (D8-i), injectable for tests. */
  preferencesPath?: string;
  /** Harvest diff seam (U6); injectable so tests never need git. */
  diffRunner?: DiffRunner;
  /** Verification-contract command runner (R45); injectable for tests. */
  runCommand?: CommandRunner;
  /** Unit -> verification-contract commands (R45). Defaults to none. */
  verificationCommandsFor?: (unit: PlanUnit) => string[];
  now?: () => number;
}

/** Cross-step, per-session observations the driver owns. */
export interface StepRuntime {
  /** Parsed-once units.json machine view (R24); read on the first step. */
  units: Record<UnitId, PlanUnit> | null;
  /** Reconciliation (R37) runs at most once per driver session. */
  reconciled: boolean;
  /** Live adapter handles per in-flight unit (dispatched or reconciled). */
  handlesByUnit: Map<UnitId, PaseoHandle>;
  /** Pre-dispatch usage snapshots (U6) for harvested deltas. */
  preUsageByUnit: Map<UnitId, UsageSnapshot>;
  /** Consecutive unchanged-poll count per in-flight unit (R76). */
  noProgressByUnit: Map<UnitId, number>;
  /** Last observed (lifecycle, usage) fingerprint per in-flight unit (R76). */
  noProgressFingerprintByUnit: Map<UnitId, string>;
}

/** Create an empty per-session runtime. */
export function createStepRuntime(): StepRuntime {
  return {
    units: null,
    reconciled: false,
    handlesByUnit: new Map(),
    preUsageByUnit: new Map(),
    noProgressByUnit: new Map(),
    noProgressFingerprintByUnit: new Map(),
  };
}

/** A summarized journal event describing what the step produced. */
export interface StepEventSummary {
  type: string;
  seq: number;
  unit_id: string | null;
  [key: string]: unknown;
}

/** Everything one step did, for the driver to decide its next move. */
export interface StepOutcome {
  dispatched: Array<{ unit_id: string; take: number }>;
  /** Dispatch attempts the adapter rejected (`dispatch_failed`). */
  dispatchFailed: Array<{ unit_id: string; take: number }>;
  polled: Array<{ unit_id: string; terminated: boolean }>;
  harvested: Array<{ unit_id: string; take: number; role: string }>;
  accepted: Array<{ unit_id: string }>;
  reworked: Array<{ unit_id: string; rework_cycle: number }>;
  refused: Array<{ unit_id: string; reason: string }>;
  escalated: EscalationSummary[];
  /** True when the step had nothing actionable to do. */
  idle: boolean;
}

function emptyOutcome(): StepOutcome {
  return {
    dispatched: [],
    dispatchFailed: [],
    polled: [],
    harvested: [],
    accepted: [],
    reworked: [],
    refused: [],
    escalated: [],
    idle: false,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (also used by the driver)
// ---------------------------------------------------------------------------

/** Read the parsed-once units.json machine view (R24). */
export function readUnitsFromStore(store: RunStore): Record<UnitId, PlanUnit> | null {
  if (!fs.existsSync(store.layout.unitsJsonPath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(store.layout.unitsJsonPath, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<UnitId, PlanUnit>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Units dispatch-eligible this moment (R14): not_started or rework status, no
 * in-flight intent, and every declared dependency terminal-accepted. Ordered by
 * unit number for deterministic dispatch.
 */
export function findEligibleUnits(
  state: DerivedState,
  units: Record<UnitId, PlanUnit>,
): PlanUnit[] {
  const inFlight = new Set(state.in_flight_intents.map((intent) => intent.unit_id));
  return Object.keys(units)
    .map((id) => units[id])
    .filter((unit) => {
      const s = state.units[unit.id];
      if (s === undefined) {
        return false;
      }
      if (s.status !== "not_started" && s.status !== "rework") {
        return false;
      }
      if (inFlight.has(unit.id)) {
        return false;
      }
      return (unit.dependsOn ?? []).every(
        (dep) => state.units[dep]?.status === "accepted",
      );
    })
    .sort((a, b) => a.number - b.number);
}

/** True when every unit in the plan is terminal-accepted (R14/R67). */
export function allUnitsAccepted(
  state: DerivedState,
  units: Record<UnitId, PlanUnit>,
): boolean {
  const ids = Object.keys(units);
  return ids.length > 0 && ids.every((id) => state.units[id]?.status === "accepted");
}

/** Cumulative usage deltas summed from every harvested usage-delta.json (R81). */
export function cumulativeUsageFromEvidence(store: RunStore): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let any = false;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "usage-delta.json") {
        try {
          const data = JSON.parse(fs.readFileSync(full, "utf8")) as {
            delta?: Record<string, unknown>;
          };
          const delta = data?.delta;
          if (typeof delta === "object" && delta !== null) {
            if (typeof delta.inputTokens === "number") {
              inputTokens += delta.inputTokens;
              any = true;
            }
            if (typeof delta.outputTokens === "number") {
              outputTokens += delta.outputTokens;
              any = true;
            }
            if (typeof delta.costUsd === "number") {
              costUsd += delta.costUsd;
              any = true;
            }
          }
        } catch {
          // best effort: an unreadable delta contributes nothing.
        }
      }
    }
  };
  walk(store.layout.evidenceDir);
  return any ? { inputTokens, outputTokens, costUsd } : null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function dispatchCtx(ctx: StepContext): DispatchContext {
  return {
    store: ctx.store,
    adapter: ctx.adapter,
    repoRoot: ctx.repoRoot,
    handleResolver: ctx.handleResolver,
    gitReader: ctx.gitReader ?? defaultGitCommitReader,
    preferencesPath: ctx.preferencesPath,
    now: ctx.now,
  };
}

function toRef(intent: InFlightIntent): DispatchRef {
  return {
    unit_id: intent.unit_id,
    role: intent.role as SpecialistRole,
    take: intent.take,
    idempotency_key: intent.idempotency_key,
    deadline: intent.deadline,
  };
}

function toEscalationSummary(event: JournalEvent): EscalationSummary {
  return {
    escalation_id:
      typeof event.escalation_id === "string" ? event.escalation_id : `esc-${event.seq}`,
    unit_id: typeof event.unit_id === "string" ? event.unit_id : null,
    trigger: typeof event.trigger === "string" ? event.trigger : "unknown",
    reason: typeof event.reason === "string" ? event.reason : "",
    criterion: typeof event.criterion === "string" ? event.criterion : null,
    seq: event.seq,
  };
}

function raiseEscalationSummary(
  ctx: StepContext,
  input: { unit_id?: string | null; trigger: string; reason: string; criterion?: string | null },
): EscalationSummary {
  const raised = raiseEscalation(ctx.store, input);
  return toEscalationSummary(raised.event);
}

/** Recover a handle for an in-flight intent from the recorded agent id. */
async function recoverHandle(
  ctx: StepContext,
  intent: InFlightIntent,
): Promise<PaseoHandle | null> {
  if (intent.agent_id === null || intent.agent_id === "") {
    return null;
  }
  try {
    const inspect = await ctx.adapter.inspect({
      agentId: intent.agent_id,
      cwd: null,
      workspaceId: intent.workspace_id,
    });
    return {
      agentId: intent.agent_id,
      cwd: inspect.cwd ?? null,
      workspaceId: intent.workspace_id,
    };
  } catch {
    return null;
  }
}

/** Fingerprint of (lifecycle, usage) — the no-progress change detector (R76). */
async function fingerprintOf(ctx: StepContext, handle: PaseoHandle): Promise<string> {
  const inspect = await ctx.adapter.inspect(handle);
  return JSON.stringify({ lifecycle: inspect.lifecycle, usage: inspect.usage });
}

function readEnvelopeAt(
  handle: PaseoHandle,
  unitId: UnitId,
  take: number,
): ResultEnvelope | null {
  if (handle.cwd === null) {
    return null;
  }
  return readEnvelope(path.join(handle.cwd, defaultEnvelopePath("builder", unitId, take)));
}

/** Take/rework budget exhaustion (KTD13, R77/R78). */
function budgetExhausted(
  state: DerivedState,
  unitId: UnitId,
  config: Config,
): { takes: boolean; rework: boolean } {
  const s = state.units[unitId];
  return {
    takes: s !== undefined && s.takes >= config.run.max_takes && s.last_acceptance !== "accept",
    rework:
      s !== undefined &&
      s.rework_cycles >= config.run.max_rework_cycles &&
      s.last_acceptance !== "accept",
  };
}

/** Escalate a unit whose take/rework budgets are exhausted (R77/R78). */
function escalateRepeatedlyFails(
  ctx: StepContext,
  unitId: UnitId,
  why: "takes" | "rework",
): EscalationSummary {
  const exhausted = budgetExhausted(ctx.store.stateSnapshot(), unitId, ctx.config);
  const reason =
    why === "takes" || exhausted.takes
      ? `max takes exceeded for ${unitId} (R77)`
      : `max rework cycles exceeded for ${unitId} (R78)`;
  return raiseEscalationSummary(ctx, {
    unit_id: unitId,
    trigger: "repeatedly-fails",
    reason,
  });
}

// ---------------------------------------------------------------------------
// The step function
// ---------------------------------------------------------------------------

/**
 * Run one step. The driver owns the lease; the step only appends through the
 * store (R15). Returns what happened so the driver can decide the stop
 * condition (no eligible work, all done, stop requested, escalation).
 */
export async function runStep(ctx: StepContext, runtime: StepRuntime): Promise<StepOutcome> {
  const store = ctx.store;
  const outcome = emptyOutcome();

  // (1) Reconstruct state from journal + lease.lock (R42). The replayed state
  // re-derives `blocked` statuses (computeBlocked) which the running in-memory
  // state does not recompute on append, so it is the authoritative eligibility
  // view.
  const { state } = store.replay();

  if (runtime.units === null) {
    runtime.units = readUnitsFromStore(store);
  }
  const units = runtime.units ?? {};

  // (2) Reconcile any non-terminal dispatch intents (R37), once per session.
  if (!runtime.reconciled) {
    runtime.reconciled = true;
    if (state.in_flight_intents.length > 0) {
      const results = await reconcileIntents(dispatchCtx(ctx));
      for (const result of results) {
        if (result.outcome !== "handle-found" || result.handle === null) {
          // intent-without-created with no handle (or refused): reconcile already
          // closed it via dispatch_failed / deadline-exceeded. Unit is eligible
          // again (or the budget check escalates below).
          continue;
        }
        runtime.handlesByUnit.set(result.intent.unit_id, result.handle);
        if (result.terminatedEvent !== null && !result.refused) {
          // Reconcile read the envelope and closed the dispatch; now run the full
          // evidence harvest + acceptance for the terminated attempt. The phase
          // is Implementing (a prior session dispatched the builder): freeze the
          // candidate (KTD14) before reviewing it.
          ensurePhase(store, "Reviewing");
          const envelope = readEnvelopeAt(result.handle, result.intent.unit_id, result.intent.take);
          const proc = await harvestAndAccept(ctx, runtime, result.intent, result.handle, envelope);
          mergeProc(outcome, proc);
        }
      }
    }
  }

  // (3) Budget predicates (R81). Run-level cost ceiling first.
  if (ctx.config.run.cost_ceiling_usd !== undefined) {
    const usage = cumulativeUsageFromEvidence(store);
    if (usage !== null && usage.costUsd !== null && usage.costUsd > ctx.config.run.cost_ceiling_usd) {
      outcome.escalated.push(
        raiseEscalationSummary(ctx, {
          unit_id: null,
          trigger: "cost-ceiling-exceeded",
          reason: `cumulative cost ${usage.costUsd} exceeds run ceiling ${ctx.config.run.cost_ceiling_usd} (R81/R82)`,
        }),
      );
      ensurePhase(store, "Attention");
      return outcome;
    }
  }

  const stateNow = store.replay().state;
  const inFlight = stateNow.in_flight_intents;
  const eligible = findEligibleUnits(stateNow, units);

  // Takes-exhaustion predicate (R77) evaluated synchronously before dispatch.
  for (const unit of eligible) {
    if (budgetExhausted(stateNow, unit.id, ctx.config).takes) {
      outcome.escalated.push(escalateRepeatedlyFails(ctx, unit.id, "takes"));
      ensurePhase(store, "Attention");
      return outcome;
    }
  }

  // (4)/(5) Dispatch eligible units within the concurrency cap (R14, R75).
  const cap = ctx.config.run.concurrency_cap;
  const slots = Math.max(0, cap - inFlight.length);
  if (slots > 0 && eligible.length > 0) {
    for (const unit of eligible.slice(0, slots)) {
      const s = stateNow.units[unit.id];
      const take = (s?.takes ?? 0) + 1;
      const nowMs = ctx.now ? ctx.now() : Date.now();
      const deadline = new Date(nowMs + ctx.config.dispatch.max_duration * 1000).toISOString();
      const dispatched = await dispatchUnit(dispatchCtx(ctx), {
        unit,
        role: "builder",
        take,
        deadline,
      });
      if (dispatched.status === "created") {
        runtime.handlesByUnit.set(unit.id, dispatched.handle);
        runtime.noProgressByUnit.delete(unit.id);
        runtime.noProgressFingerprintByUnit.delete(unit.id);
        const inspect = await ctx.adapter.inspect(dispatched.handle);
        runtime.preUsageByUnit.set(unit.id, inspect.usage);
        outcome.dispatched.push({ unit_id: unit.id, take });
        // Builder(s) dispatched for eligible units (KTD14). Transition now so a
        // terminal poll later in the same step can move Implementing->Reviewing.
        ensurePhase(store, "Implementing");
      } else {
        outcome.dispatchFailed.push({ unit_id: unit.id, take });
        if (budgetExhausted(store.stateSnapshot(), unit.id, ctx.config).takes) {
          // The adapter failed the max-th take: escalate in the same step (R77).
          outcome.escalated.push(escalateRepeatedlyFails(ctx, unit.id, "takes"));
          ensurePhase(store, "Attention");
          return outcome;
        }
      }
    }
  }

  // (6) Poll in-flight specialists. Budget predicates (no-progress, duration)
  // are evaluated before each poll cycle (R81).
  const liveIntents = store.replay().state.in_flight_intents;
  for (const intent of liveIntents) {
    const unit = units[intent.unit_id] ?? null;
    let handle: PaseoHandle | null = runtime.handlesByUnit.get(intent.unit_id) ?? null;
    if (handle === null) {
      handle = await recoverHandle(ctx, intent);
      if (handle !== null) {
        runtime.handlesByUnit.set(intent.unit_id, handle);
      }
    }
    if (handle === null) {
      // No observable handle: the unit stays in-flight; the driver surfaces the
      // blocking condition rather than guessing (R37/R18).
      continue;
    }

    const nowMs = ctx.now ? ctx.now() : Date.now();
    if (isPastDeadline(intent.deadline, nowMs)) {
      await refusePastDeadline(dispatchCtx(ctx), toRef(intent), handle);
      outcome.polled.push({ unit_id: intent.unit_id, terminated: true });
      outcome.refused.push({
        unit_id: intent.unit_id,
        reason: `deadline passed for take ${intent.take}; work refused (R5)`,
      });
      continue;
    }

    // No-progress predicate (R76): escalate after N unchanged polls while alive.
    const fingerprint = await fingerprintOf(ctx, handle);
    const prev = runtime.noProgressFingerprintByUnit.get(intent.unit_id);
    const count = runtime.noProgressByUnit.get(intent.unit_id) ?? 0;
    if (prev !== undefined && fingerprint === prev) {
      const next = count + 1;
      runtime.noProgressByUnit.set(intent.unit_id, next);
      if (next >= ctx.config.dispatch.no_progress_polls) {
        outcome.escalated.push(
          raiseEscalationSummary(ctx, {
            unit_id: intent.unit_id,
            trigger: "no-progress",
            reason: `no lifecycle/activity change for ${next} consecutive polls (R76)`,
          }),
        );
        ensurePhase(store, "Attention");
        return outcome;
      }
    } else {
      runtime.noProgressByUnit.set(intent.unit_id, 1);
    }
    runtime.noProgressFingerprintByUnit.set(intent.unit_id, fingerprint);

    const status = await ctx.adapter.status(handle);
    if (!isTerminalLifecycle(status)) {
      outcome.polled.push({ unit_id: intent.unit_id, terminated: false });
      continue;
    }

    outcome.polled.push({ unit_id: intent.unit_id, terminated: true });
    // Candidate frozen for testing (KTD14): Implementing -> Reviewing.
    ensurePhase(store, "Reviewing");
    const envelopeRel = defaultEnvelopePath("builder", intent.unit_id, intent.take);
    const harvest = await harvestEnvelope(dispatchCtx(ctx), toRef(intent), handle, envelopeRel);
    const proc = await harvestAndAccept(ctx, runtime, intent, handle, harvest.envelope);
    mergeProc(outcome, proc);
  }

  // (7)-(9) Phase transition per FSM (KTD14). An escalation pauses the run in
  // Attention (raised inline or by a terminated-attempt acceptance). Otherwise:
  // all done -> AwaitingApproval, in-flight work -> Implementing, a frozen
  // candidate was reviewed this step -> Reviewing.
  if (outcome.escalated.length > 0) {
    ensurePhase(store, "Attention");
  } else {
    const s = store.replay().state;
    if (allUnitsAccepted(s, units)) {
      ensurePhase(store, "AwaitingApproval");
    } else if (s.in_flight_intents.length > 0) {
      ensurePhase(store, "Implementing");
    } else if (outcome.harvested.length > 0) {
      ensurePhase(store, "Reviewing");
    }
  }

  outcome.idle =
    outcome.dispatched.length === 0 &&
    outcome.dispatchFailed.length === 0 &&
    outcome.polled.length === 0 &&
    outcome.harvested.length === 0 &&
    outcome.accepted.length === 0 &&
    outcome.reworked.length === 0 &&
    outcome.refused.length === 0 &&
    outcome.escalated.length === 0;
  return outcome;
}

// ---------------------------------------------------------------------------
// Terminated-specialist pipeline: harvest -> grade -> accept -> rework/escalate
// ---------------------------------------------------------------------------

interface HarvestProc {
  accepted: Array<{ unit_id: string }>;
  reworked: Array<{ unit_id: string; rework_cycle: number }>;
  escalated: EscalationSummary[];
  harvested: Array<{ unit_id: string; take: number; role: string }>;
}

function mergeProc(outcome: StepOutcome, proc: HarvestProc): void {
  outcome.accepted.push(...proc.accepted);
  outcome.reworked.push(...proc.reworked);
  outcome.escalated.push(...proc.escalated);
  outcome.harvested.push(...proc.harvested);
}

/**
 * For one terminated builder: harvest evidence (U6), verify custody + T2-T3
 * continuity, grade and evaluate acceptance (U7), and route the unit — accept,
 * bounded rework (KTD13), or escalation (R77/R78/R82). The dispatch itself
 * (envelope read + `dispatch_terminated`) is the caller's job, so this never
 * double-closes an intent.
 */
async function harvestAndAccept(
  ctx: StepContext,
  runtime: StepRuntime,
  intent: InFlightIntent,
  handle: PaseoHandle,
  envelope: ResultEnvelope | null,
): Promise<HarvestProc> {
  const store = ctx.store;
  const units = runtime.units ?? {};
  const unit = units[intent.unit_id];
  const proc: HarvestProc = { accepted: [], reworked: [], escalated: [], harvested: [] };
  if (unit === undefined) {
    return proc;
  }
  const role: SpecialistRole = "builder";
  const take = intent.take;
  const worktreeRoot = handle.cwd ?? "";
  const verificationCommands = ctx.verificationCommandsFor
    ? ctx.verificationCommandsFor(unit)
    : [];

  const evidence = await harvestEvidence({
    store,
    unit,
    role,
    take,
    attempt: intent.idempotency_key,
    agentId: intent.agent_id ?? "unknown",
    worktreeRoot,
    baseCommit: intent.base_commit,
    envelope,
    verificationCommands,
    preDispatchUsage: runtime.preUsageByUnit.get(intent.unit_id) ?? EMPTY_USAGE,
    postTerminationUsage: (await ctx.adapter.inspect(handle)).usage,
    diffRunner: ctx.diffRunner,
    runCommand: ctx.runCommand,
    now: ctx.now,
  });
  proc.harvested.push({ unit_id: intent.unit_id, take, role });

  // Evidence integrity gates (R45, R46): broken custody or a divergent T2-T3
  // workspace hash opens gaps that the acceptance predicate must resolve.
  verifyCustodyChain(store, evidence.chain);
  const integrationHash = workspaceHash(worktreeRoot);
  takeContinuityRecord(store, {
    unit_id: intent.unit_id,
    role,
    take,
    harvestHash: evidence.harvestWorkspaceHash,
    integrationHash,
  });

  // Grade each criterion from the harvested builder evidence. The deterministic
  // tier reads the verification-contract outcome; calibrated-judge / human
  // criteria remain ungraded and escalate (no reviewer/operator input in U8).
  const records: CriterionGrade[] = (unit.acceptance ?? []).map((criterion) =>
    gradeCriterion({
      criterion: criterion.text,
      tier: criterion.tier as CriterionGrade["tier"],
      verificationAllPassed: evidence.record.verification.all_passed,
    }),
  );

  // Acceptance transition (R51 + R54): predicate, then integration check.
  const acceptance = await evaluateUnitAcceptance({
    store,
    unit,
    records,
    openGaps: store.stateSnapshot().open_gaps,
    integration: {
      store,
      unit,
      sourceWorktree: worktreeRoot,
      canonicalWorktree: ctx.canonicalWorktree,
      verificationCommands,
      runCommand: ctx.runCommand,
    },
  });

  if (acceptance.verdict.decision === "accept") {
    proc.accepted.push({ unit_id: intent.unit_id });
    return proc;
  }

  if (acceptance.verdict.route === "escalate") {
    // applyAcceptance already appended escalation_raised (R82 trigger:
    // no-checker-profile / operator-judgment).
    if (acceptance.applied.escalationEvent !== null) {
      proc.escalated.push(toEscalationSummary(acceptance.applied.escalationEvent));
    }
    return proc;
  }

  // Route to bounded rework (KTD13) unless a budget is exhausted (R77/R78).
  const s = store.stateSnapshot().units[intent.unit_id];
  const takesExhausted = s !== undefined && s.takes >= ctx.config.run.max_takes;
  const reworkExhausted = s !== undefined && s.rework_cycles >= ctx.config.run.max_rework_cycles;
  if (takesExhausted || reworkExhausted) {
    proc.escalated.push(escalateRepeatedlyFails(ctx, intent.unit_id, takesExhausted ? "takes" : "rework"));
    return proc;
  }
  store.append("rework_started", { unit_id: intent.unit_id });
  const cycle = store.stateSnapshot().units[intent.unit_id]?.rework_cycles ?? 0;
  proc.reworked.push({ unit_id: intent.unit_id, rework_cycle: cycle });
  return proc;
}
