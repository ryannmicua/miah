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
  refFromIntent,
  resolveRoleDefaults,
  type DispatchContext,
  type GitCommitReader,
  type HandleResolver,
} from "./dispatch";
import { drivenMilliseconds } from "./driven-time";
import {
  harvestEvidence,
  takeContinuityRecord,
  verifyCustodyChain,
  workspaceHash,
  type CommandRunner,
  type DiffRunner,
  type UsageSnapshot,
} from "./evidence";
import { commitIntegrationFiles, evaluateUnitAcceptance } from "./acceptance";
import {
  gradeCriterion,
  gradesFromRefs,
  type CalibrationResolver,
  type CriterionGrade,
} from "./grading";
import { resolveCalibrationMetrics } from "./calibration";
import { resolveConfigBasePath } from "./config";
import { ensurePhase } from "./fsm";
import { raiseEscalation, summaryFromEvent, unresolvedEscalations, type EscalationSummary } from "./escalation";
import {
  defaultEnvelopePath,
  readEnvelope,
  readVerifierEnvelope,
  type ResultEnvelope,
  type VerifierEnvelope,
} from "./envelope";
import {
  composeVerifierPackage,
  harvestVerifierResult,
  readPackageManifest,
  verifyEnvelopeBinding,
  verifyEvidencePointers,
  verifyGradeCoverage,
} from "./verifier";
import type { PaseoAdapter, PaseoHandle } from "./adapter/paseo";
import { readUnitsJson, type RunStore } from "./run-store";
import {
  hasValidContract,
  verificationCommandsFor as contractVerificationCommandsFor,
} from "./verification-contract";
import type { VerifierPackageManifest } from "./verifier";
import type { VerifierPacketContext } from "./packet";
import {
  AwaitingCandidate,
  Config,
  CriterionGradeRef,
  DerivedState,
  GradingTier,
  InFlightIntent,
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
  /** Unit -> verification-contract commands (R45). Defaults to the parsed contract (R15, KTD1). */
  verificationCommandsFor?: (unit: PlanUnit) => string[];
  /**
   * Calibration lookup for the calibrated-judge authority gate (KTD6/R4).
   * Defaults to the operator-supplied profile files under the config base
   * path (R74); absent profiles resolve as not calibrated (fail-closed, R48).
   */
  resolveCalibration?: CalibrationResolver;
  /** Calibration profile base path; defaults to the config base path (R74). */
  calibrationBasePath?: string;
  /**
   * Test seam: produces the v2 envelope a verifier specialist writes at its
   * declared path before termination. Absent (production): no envelope —
   * a missing/invalid envelope is a failed verifier attempt on the same
   * frozen candidate (KTD5). Never called by Miah to manufacture a grade.
   */
  verifierEnvelopeFor?: (opts: {
    unit: PlanUnit;
    take: number;
    candidateAttempt: string;
    packageDir: string;
    packageSha256: string;
    workspaceId: string | null;
  }) => VerifierEnvelope | null;
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
  return readUnitsJson(store.layout.unitsJsonPath);
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

/** True when any unit holds a preserved candidate awaiting verifier dispatch (KTD5). */
export function hasPendingVerification(state: DerivedState): boolean {
  return Object.keys(state.awaiting_verification).length > 0;
}

/** The unit's preserved builder candidate, or null. */
export function candidateOf(
  state: DerivedState,
  unitId: UnitId,
): AwaitingCandidate | null {
  return state.awaiting_verification[unitId] ?? null;
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

function raiseEscalationSummary(
  ctx: StepContext,
  input: { unit_id?: string | null; trigger: string; reason: string; criterion?: string | null },
): EscalationSummary {
  const raised = raiseEscalation(ctx.store, input);
  return summaryFromEvent(raised.event);
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
          // Reconcile read the envelope and closed the dispatch; now run the
          // full role-specific pipeline for the terminated attempt (KTD5). The
          // phase is Implementing (a prior session dispatched the specialist):
          // freeze the candidate (KTD14) before verifying it.
          ensurePhase(store, "Reviewing");
          const proc =
            result.intent.role === "verifier"
              ? await processVerifierTermination(
                  ctx,
                  runtime,
                  result.intent,
                  result.handle,
                  readVerifierEnvelopeAt(result.handle, result.intent),
                )
              : await processBuilderTermination(
                  ctx,
                  runtime,
                  result.intent,
                  result.handle,
                  readEnvelopeAt(result.handle, result.intent.unit_id, result.intent.take),
                );
          mergeProc(outcome, proc);
        }
      }
    }
  }

  // (3) Budget predicates (R81). Run-level cost ceiling first, then
  // run-level deadline (R10-R14, KD2).
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

  // R10-R14: run-level deadline. Compute driven time from journal events and
  // compare against config.run.max_duration_s. On breach, escalate to Attention.
  // The driver holds the lease at this point, so leaseFresh is true and the
  // current epoch closes at now.
  {
    const nowMs = ctx.now ? ctx.now() : Date.now();
    const events = store.journal.readEvents();
    const drivenMs = drivenMilliseconds(events, { now: nowMs, leaseFresh: true });
    const maxMs = ctx.config.run.max_duration_s * 1000;
    if (drivenMs > maxMs) {
      outcome.escalated.push(
        raiseEscalationSummary(ctx, {
          unit_id: null,
          trigger: "run-deadline-exceeded",
          reason: `driven time ${Math.round(drivenMs / 1000)}s exceeds run ceiling ${ctx.config.run.max_duration_s}s (R10-R14)`,
        }),
      );
      ensurePhase(store, "Attention");
      return outcome;
    }
  }

  const stateNow = store.replay().state;
  const inFlight = stateNow.in_flight_intents;
  // R66/R82: a unit with an open escalation is NOT dispatch-eligible until the
  // operator resolves it. Without this guard, an escalation raised during the
  // reconcile path (step 2) would re-dispatch the unit in step 5 before the
  // step-7 Attention transition — launching a fresh take past an escalation.
  const escalatedUnits = new Set<UnitId>(
    unresolvedEscalations(store)
      .map((escalation) => escalation.unit_id)
      .filter((id): id is UnitId => id !== null),
  );
  const eligible = findEligibleUnits(stateNow, units).filter(
    (unit) => !escalatedUnits.has(unit.id),
  );

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

  // (5b) Verifier dispatch (KTD5): every unit with a preserved frozen builder
  // candidate and no in-flight intent is dispatched to the verifier — the
  // candidate's own workspace, a separate verifier-attempt idempotency key,
  // and the composed evidence package (KTD3). Launch failures and invalid
  // results retry the same candidate; the verifier-attempt ceiling raises
  // repeatedly-fails without spending builder budgets.
  {
    const stateBefore = store.stateSnapshot();
    const inFlightNow = new Set(stateBefore.in_flight_intents.map((i) => i.unit_id));
    let slotsNow = Math.max(0, cap - stateBefore.in_flight_intents.length);
    for (const unitId of Object.keys(stateBefore.awaiting_verification)) {
      if (slotsNow <= 0 || inFlightNow.has(unitId)) {
        continue;
      }
      const unit = units[unitId];
      const candidate = stateBefore.awaiting_verification[unitId];
      if (unit === undefined || candidate === undefined) {
        continue;
      }
      // KTD1/R10: a legacy contractless unit fails closed before any verifier
      // dispatch (the scope-change-needed escalation raised at builder
      // termination keeps it blocked in Attention until an amendment).
      if (!hasValidContract(unit)) {
        continue;
      }
      if (verifierBudgetExhausted(store.stateSnapshot(), unitId, ctx.config)) {
        outcome.escalated.push(escalateVerifierRepeatedlyFails(ctx, unitId));
        ensurePhase(store, "Attention");
        return outcome;
      }
      const handle = await recoverCandidateHandle(ctx, candidate);
      if (handle === null || handle.cwd === null) {
        continue;
      }
      const packageDir = path.join(handle.cwd, ".miah", "verifier", unitId, candidate.attempt);
      let manifest: VerifierPackageManifest | null = null;
      if (!fs.existsSync(path.join(packageDir, "manifest.json"))) {
        try {
          manifest = composeVerifierPackage({
            store,
            unit,
            candidate,
            worktreeRoot: handle.cwd,
          }).manifest;
        } catch (error) {
          // The candidate cannot be packaged (missing/broken evidence): a
          // verifier attempt that can never succeed — fail closed.
          store.append("verifier_attempt_failed", {
            unit_id: unitId,
            attempt: candidate.attempt,
            reason: error instanceof Error ? error.message : String(error),
          });
          if (verifierBudgetExhausted(store.stateSnapshot(), unitId, ctx.config)) {
            outcome.escalated.push(escalateVerifierRepeatedlyFails(ctx, unitId));
            ensurePhase(store, "Attention");
            return outcome;
          }
          continue;
        }
      } else {
        manifest = readPackageManifest(packageDir);
      }
      if (manifest === null) {
        continue;
      }
      const attempt = (stateBefore.units[unitId]?.verifier_attempts ?? 0) + 1;
      const envelopePath = defaultEnvelopePath("verifier", unitId, candidate.take);
      const verifier: VerifierPacketContext = {
        package_path: `.miah/verifier/${unitId}/${candidate.attempt}`,
        package_sha256: manifest.package_sha256,
        candidate_attempt: candidate.attempt,
        candidate_take: candidate.take,
        workspace_id: candidate.workspace_id,
        criteria: (unit.acceptance ?? []).map((c) => ({ id: c.id, text: c.text, tier: c.tier })),
        contract_commands: unit.verificationContract?.commands ?? [],
        contract_summary: contractSummaryOf(unit),
      };
      // Test seam: the verifier specialist writes its v2 envelope at the
      // declared path before termination (production: nothing here). The seam
      // output is written to disk only outside production — in production the
      // envelope can come only from the real specialist agent, never from a
      // synthetic seam value (the "Miah manufactures a grade" failure mode);
      // an unguarded seam in production fails closed as a missing envelope.
      const verifierEnvelope =
        ctx.verifierEnvelopeFor && process.env.NODE_ENV !== "production"
          ? ctx.verifierEnvelopeFor({
              unit,
              take: candidate.take,
              candidateAttempt: candidate.attempt,
              packageDir,
              packageSha256: manifest.package_sha256,
              workspaceId: candidate.workspace_id,
            })
          : null;
      if (verifierEnvelope !== null) {
        const envelopeAbs = path.join(handle.cwd, envelopePath);
        fs.mkdirSync(path.dirname(envelopeAbs), { recursive: true });
        fs.writeFileSync(envelopeAbs, `${JSON.stringify(verifierEnvelope, null, 2)}\n`, "utf8");
      }
      const dispatched = await dispatchUnit(dispatchCtx(ctx), {
        unit,
        role: "verifier",
        take: candidate.take,
        idempotencyKey: `dispatch-verifier-${unitId}-t${candidate.take}-a${attempt}`,
        envelopePath,
        workspaceId: candidate.workspace_id ?? undefined,
        verifier,
      });
      if (dispatched.status === "created") {
        runtime.handlesByUnit.set(unitId, dispatched.handle);
        runtime.noProgressByUnit.delete(unitId);
        runtime.noProgressFingerprintByUnit.delete(unitId);
        const inspect = await ctx.adapter.inspect(dispatched.handle);
        runtime.preUsageByUnit.set(unitId, inspect.usage);
        ensurePhase(store, "Reviewing");
        slotsNow -= 1;
      } else {
        // KTD5: a verifier launch failure is a failed verifier attempt on the
        // same frozen candidate — never a builder take or rework cycle.
        if (verifierBudgetExhausted(store.stateSnapshot(), unitId, ctx.config)) {
          outcome.escalated.push(escalateVerifierRepeatedlyFails(ctx, unitId));
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
      // R26/R14: the watchdog is the sole reaper. Skip this intent for this
      // poll cycle — do not call adapter.stop, do not append any event, and
      // do not advance the no-progress counter. The intent stays in-flight
      // and its receipt is handled by the watchdog or at the next drain.
      outcome.polled.push({ unit_id: intent.unit_id, terminated: false });
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
    // Candidate frozen for verification (KTD14): Implementing -> Reviewing.
    ensurePhase(store, "Reviewing");
    if (intent.role === "verifier") {
      const envelopeRel = defaultEnvelopePath("verifier", intent.unit_id, intent.take);
      const harvest = await harvestEnvelope(dispatchCtx(ctx), refFromIntent(intent), handle, envelopeRel);
      const proc = await processVerifierTermination(
        ctx,
        runtime,
        intent,
        handle,
        harvest.envelope as VerifierEnvelope | null,
      );
      mergeProc(outcome, proc);
    } else {
      const envelopeRel = defaultEnvelopePath("builder", intent.unit_id, intent.take);
      const harvest = await harvestEnvelope(dispatchCtx(ctx), refFromIntent(intent), handle, envelopeRel);
      const proc = await processBuilderTermination(
        ctx,
        runtime,
        intent,
        handle,
        harvest.envelope as ResultEnvelope | null,
      );
      mergeProc(outcome, proc);
    }
  }

  // (7)-(9) Phase transition per FSM (KTD14). An escalation pauses the run in
  // Attention (raised inline or by a terminated-attempt acceptance). Otherwise:
  // all done -> AwaitingApproval, builder work -> Implementing, verifier work
  // (in-flight, frozen candidate, or harvested this step) -> Reviewing.
  if (outcome.escalated.length > 0) {
    ensurePhase(store, "Attention");
  } else {
    const s = store.replay().state;
    if (allUnitsAccepted(s, units)) {
      ensurePhase(store, "AwaitingApproval");
    } else if (s.in_flight_intents.some((intent) => intent.role !== "verifier")) {
      ensurePhase(store, "Implementing");
    } else if (
      s.in_flight_intents.length > 0 ||
      hasPendingVerification(s) ||
      outcome.harvested.length > 0
    ) {
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
// Terminated-specialist pipelines (KTD5/KTD6): builder -> verifier -> accept
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

/** Human-readable criterion -> command mapping for the verifier packet (KTD3). */
function contractSummaryOf(unit: PlanUnit): string {
  const contract = unit.verificationContract;
  if (contract === null || contract === undefined) {
    return "no contract";
  }
  return Object.entries(contract.criterion_map)
    .map(([criterionId, mapping]) => `${criterionId} -> ${mapping.commands.join(", ") || "(no commands)"}`)
    .join("; ");
}

/** Recover the frozen candidate's workspace handle from its recorded identity. */
async function recoverCandidateHandle(
  ctx: StepContext,
  candidate: AwaitingCandidate,
): Promise<PaseoHandle | null> {
  if (candidate.agent_id === null || candidate.agent_id === "") {
    return null;
  }
  try {
    const inspect = await ctx.adapter.inspect({
      agentId: candidate.agent_id,
      cwd: null,
      workspaceId: candidate.workspace_id,
    });
    return {
      agentId: candidate.agent_id,
      cwd: inspect.cwd ?? null,
      workspaceId: candidate.workspace_id,
    };
  } catch {
    return null;
  }
}

/** KTD5: verifier-attempt budget against the separate per-candidate ceiling. */
function verifierBudgetExhausted(
  state: DerivedState,
  unitId: UnitId,
  config: Config,
): boolean {
  const s = state.units[unitId];
  return (
    s !== undefined &&
    s.verifier_attempts >= config.run.max_takes &&
    s.last_acceptance !== "accept"
  );
}

/** Escalate at the verifier-attempt ceiling (KTD5/R77: verifier-dispatch reason). */
function escalateVerifierRepeatedlyFails(
  ctx: StepContext,
  unitId: UnitId,
): EscalationSummary {
  return raiseEscalationSummary(ctx, {
    unit_id: unitId,
    trigger: "repeatedly-fails",
    reason: `max verifier attempts exceeded for ${unitId} (verifier-dispatch, KTD5)`,
  });
}

/** The calibration gate for calibrated-judge verdicts (KTD6, R4/R74). */
function resolveCalibrationFor(
  ctx: StepContext,
): CalibrationResolver {
  if (ctx.resolveCalibration !== undefined) {
    return ctx.resolveCalibration;
  }
  const basePath = ctx.calibrationBasePath ?? resolveConfigBasePath();
  return (provider, model, tier) =>
    resolveCalibrationMetrics(provider, model, tier, ctx.config.calibration, basePath);
}

function readVerifierEnvelopeAt(
  handle: PaseoHandle,
  intent: InFlightIntent,
): VerifierEnvelope | null {
  if (handle.cwd === null) {
    return null;
  }
  return readVerifierEnvelope(
    path.join(handle.cwd, defaultEnvelopePath("verifier", intent.unit_id, intent.take)),
  );
}

/**
 * For one terminated builder (KTD5): fail closed on a missing contract, then
 * harvest evidence, verify custody + T2-T3 continuity, and preserve the frozen
 * candidate for verifier dispatch. The dispatch itself (envelope read +
 * `dispatch_terminated`) is the caller's job, so this never double-closes an
 * intent. Miah grades nothing here — the verifier's envelope entries and the
 * operator's decisions are the only grade sources (KTD6).
 */
async function processBuilderTermination(
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

  // KTD1/R10: a unit without a parsed verification contract cannot be sensed
  // or verified. It stays blocked under scope-change-needed until an
  // operator-approved amendment supplies a valid contract — the commands never
  // run and no verifier is dispatched.
  if (!hasValidContract(unit)) {
    proc.escalated.push(
      raiseEscalationSummary(ctx, {
        unit_id: intent.unit_id,
        trigger: "scope-change-needed",
        reason: `unit ${intent.unit_id} has no verification contract; operator-approved amendment required (KTD1/R10)`,
      }),
    );
    ensurePhase(store, "Attention");
    return proc;
  }

  const role: SpecialistRole = "builder";
  const take = intent.take;
  const worktreeRoot = handle.cwd ?? "";
  const verificationCommands = ctx.verificationCommandsFor
    ? ctx.verificationCommandsFor(unit)
    : contractVerificationCommandsFor(unit);

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

  // The successful builder termination already derived the awaiting-
  // verification candidate (KTD5); the verifier dispatch happens at the next
  // step boundary so a crash here resumes at verification, never a new take.
  return proc;
}

/**
 * For one terminated verifier (KTD5/KTD6): validate the v2 envelope against
 * the frozen candidate and package, custody the result, map envelope entries
 * into durable CriterionGrade references (applying the calibration authority
 * gate), then evaluate the predicate and route accept / bounded rework /
 * escalation. An invalid result is a failed verifier attempt on the same
 * frozen candidate; only a valid verifier fail grade starts builder rework.
 */
async function processVerifierTermination(
  ctx: StepContext,
  runtime: StepRuntime,
  intent: InFlightIntent,
  handle: PaseoHandle,
  envelope: VerifierEnvelope | null,
): Promise<HarvestProc> {
  const store = ctx.store;
  const units = runtime.units ?? {};
  const unit = units[intent.unit_id];
  const proc: HarvestProc = { accepted: [], reworked: [], escalated: [], harvested: [] };
  if (unit === undefined) {
    return proc;
  }
  const state = store.stateSnapshot();
  const candidate = state.awaiting_verification[intent.unit_id];

  // A missing/invalid v2 envelope is a failed verifier attempt (the dispatch
  // already closed with a non-success outcome, which replay counted).
  if (envelope === null || candidate === undefined) {
    if (verifierBudgetExhausted(store.stateSnapshot(), intent.unit_id, ctx.config)) {
      proc.escalated.push(escalateVerifierRepeatedlyFails(ctx, intent.unit_id));
    }
    return proc;
  }

  // KTD5 hardening: the terminated verifier's worktree root is authoritative
  // only when the adapter observed it. A null cwd must never degrade into
  // `path.join("", ...)` reads against the process CWD or a workspaceHash of
  // the wrong directory — fail the attempt cleanly instead (bounded retry).
  const worktreeRoot = handle.cwd === null ? null : handle.cwd;
  if (worktreeRoot === null) {
    store.append("verifier_attempt_failed", {
      unit_id: intent.unit_id,
      attempt: intent.idempotency_key,
      reason: "verifier worktree unavailable: adapter reported no cwd for the terminated verifier",
    });
    if (verifierBudgetExhausted(store.stateSnapshot(), intent.unit_id, ctx.config)) {
      proc.escalated.push(escalateVerifierRepeatedlyFails(ctx, intent.unit_id));
    }
    return proc;
  }
  const packageDir = path.join(worktreeRoot, ".miah", "verifier", unit.id, candidate.attempt);
  const manifest = readPackageManifest(packageDir);
  const binding = verifyEnvelopeBinding(envelope, packageDir, candidate, manifest);
  const coverage = verifyGradeCoverage(envelope, unit);
  const pointers = verifyEvidencePointers(envelope, packageDir, manifest);

  if (!binding.ok || !coverage.ok || !pointers.ok) {
    const reason = [binding.reason, coverage.reason, pointers.reason]
      .filter((part): part is string => part !== null)
      .join("; ");
    // KTD5: an invalid verifier result is a failed verifier attempt on the
    // same frozen candidate — never a builder take or a rework cycle.
    store.append("verifier_attempt_failed", {
      unit_id: intent.unit_id,
      attempt: intent.idempotency_key,
      reason,
    });
    if (verifierBudgetExhausted(store.stateSnapshot(), intent.unit_id, ctx.config)) {
      proc.escalated.push(escalateVerifierRepeatedlyFails(ctx, intent.unit_id));
    }
    return proc;
  }

  // Custody the verifier result before acceptance reads it (KTD4): envelope,
  // usage delta, and result record — commands are never re-run here (U3.AC5).
  const inspect = await ctx.adapter.inspect(handle);
  const result = harvestVerifierResult({
    store,
    unitId: unit.id,
    candidate,
    verifierAttempt: intent.idempotency_key,
    verifierAgentId: intent.agent_id ?? "unknown",
    worktreeRoot,
    envelope,
    preDispatchUsage: runtime.preUsageByUnit.get(intent.unit_id) ?? EMPTY_USAGE,
    postTerminationUsage: inspect.usage,
    now: ctx.now,
  });
  proc.harvested.push({ unit_id: intent.unit_id, take: candidate.take, role: "verifier" });

  // T2-T3 continuity across the verifier phase (KTD3): `.miah/` transport
  // writes are excluded from the hash, so only source mutation opens a gap.
  const vHash = workspaceHash(worktreeRoot);
  takeContinuityRecord(store, {
    unit_id: intent.unit_id,
    role: "verifier",
    take: candidate.take,
    harvestHash: vHash,
    integrationHash: vHash,
  });

  // KTD6: verifier envelope entries are the only grade source (with operator
  // decisions). The calibration gate applies to calibrated-judge verdicts;
  // deterministic certification needs no profile (KD6).
  const profile = resolveRoleDefaultsFor(ctx);
  const grades: CriterionGradeRef[] = [];
  for (const criterion of unit.acceptance ?? []) {
    if (criterion.tier === "human" || criterion.id === null) {
      continue;
    }
    const entry = envelope.grades.find((grade) => grade.criterion_id === criterion.id);
    if (entry === undefined) {
      continue;
    }
    const graded = gradeCriterion(
      {
        criterion: criterion.text,
        tier: entry.declared_tier as GradingTier,
        // KTD4: the verifier's verdict passes through unchanged — including
        // its own `ungraded` declaration, which grading routes to escalation
        // (never converted to the null "envelope missing" path).
        verifierVerdict: entry.verdict,
        verifierProvider: profile.provider,
        verifierModel: profile.model,
      },
      { resolveCalibration: resolveCalibrationFor(ctx) },
    );
    grades.push({
      criterion_id: criterion.id,
      criterion: criterion.text,
      tier: graded.tier,
      grade: graded.grade,
      route: graded.route,
      basis: entry.flagged_for_human
        ? "verifier-flagged-for-human-judgment"
        : graded.basis,
      source: "verifier",
    });
  }
  store.append("criterion_grades_recorded", {
    unit_id: intent.unit_id,
    take: candidate.take,
    verifier_attempt: intent.idempotency_key,
    grades,
  });

  // Evaluate acceptance from the durable grades (KTD6: resume re-evaluates
  // without parsing specialist prose).
  const stateAfter = store.stateSnapshot();
  const records: CriterionGrade[] = gradesFromRefs(
    stateAfter.criterion_grades[intent.unit_id] ?? [],
  );

  // KTD7: a verifier flag raises `verifier-flagged-for-human-judgment` with
  // the complete payload — one criterion-level escalation per flagged entry —
  // and suppresses the generic predicate escalation (exactly one trigger).
  const flagged = envelope.grades.filter((grade) => grade.flagged_for_human);
  for (const entry of flagged) {
    const criterion = (unit.acceptance ?? []).find((c) => c.id === entry.criterion_id);
    raiseEscalation(ctx.store, {
      unit_id: intent.unit_id,
      trigger: "verifier-flagged-for-human-judgment",
      reason: `verifier flagged criterion ${entry.criterion_id} for human judgment`,
      criterion: criterion?.text ?? null,
      // KTD7 payload:
      payload: {
        criterion_id: entry.criterion_id,
        declared_tier: entry.declared_tier,
        verifier_attempt: intent.idempotency_key,
        verifier_provider: profile.provider,
        verifier_model: profile.model,
        basis: entry.basis,
        evidence_package_sha256: envelope.evidence_package_sha256,
        evidence: entry.evidence,
      },
    });
  }
  const escalationOverride =
    flagged.length > 0 ? { trigger: "verifier-flagged-for-human-judgment", payload: {} } : null;

  const acceptance = await evaluateUnitAcceptance({
    store,
    unit,
    records,
    openGaps: stateAfter.open_gaps,
    escalationOverride,
    integration: {
      store,
      unit,
      sourceWorktree: worktreeRoot,
      canonicalWorktree: ctx.canonicalWorktree,
      verificationCommands: contractVerificationCommandsFor(unit),
      runCommand: ctx.runCommand,
      commitIntegration: commitIntegrationFiles,
    },
  });

  if (acceptance.verdict.decision === "accept") {
    proc.accepted.push({ unit_id: intent.unit_id });
    return proc;
  }

  if (acceptance.verdict.route === "escalate") {
    if (acceptance.applied.escalationEvent !== null) {
      proc.escalated.push(summaryFromEvent(acceptance.applied.escalationEvent));
    }
    return proc;
  }

  // A valid verifier fail grade routes to bounded builder rework (KTD5),
  // unless a budget is exhausted (R77/R78).
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

/** D8-i profile for the verifier role (operator preferences override, R14). */
function resolveRoleDefaultsFor(ctx: StepContext): { paseo_role: string; provider: string; model: string } {
  return resolveRoleDefaults("verifier", { preferencesPath: ctx.preferencesPath });
}
