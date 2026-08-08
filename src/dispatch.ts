/**
 * Dispatch pipeline (R36-R38, R43-R44, U5).
 *
 * Implements, for one specialist, sequentially (concurrency=1):
 *
 *   dispatch_intent -> adapter launch -> dispatch_created | dispatch_failed
 *     -> poll status at step-boundary cadence
 *     -> on terminal, read the result envelope -> dispatch_terminated
 *
 * Ordering (R17): `dispatch_intent` is journaled BEFORE the adapter call
 * leaves. Identity is partly observed rather than wholly self-reported (A6):
 * `dispatch_created` records the actual agent id, workspace id, and the base
 * commit read from git — never from the packet.
 *
 * Reconciliation on restart (R37): every `dispatch_intent` with no matching
 * `dispatch_created` / `dispatch_failed` / `dispatch_terminated` is queried
 * against the adapter (via the injectable handle-resolver seam — the U4 adapter
 * has no idempotency-key lookup, so the honest default is "no handle" ->
 * `dispatch_failed` -> rework). A `reconcile_record` (R38) is journaled before
 * the reconciliation decision. Deadlines (R5): work past a recorded deadline is
 * refused — the specialist is terminated immediately and the dispatch closes
 * with a deadline-exceeded gap.
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setTimeout as sleep } from "timers/promises";
import { PaseoAdapter, PaseoHandle } from "./adapter/paseo";
import { readEnvelope, defaultEnvelopePath, type ResultEnvelope } from "./envelope";
import { readManifest } from "./manifest";
import { composePacket, computePacketHash, extractUnitSection, renderPacketPrompt, type DispatchPacket } from "./packet";
import { readUnitsJson, RunStore, type RunStoreLayout } from "./run-store";
import {
  Config,
  D8I_ROLE_DEFAULTS,
  InFlightIntent,
  JournalEvent,
  PlanUnit,
  SpecialistRole,
  UnitId,
} from "./types";

/** Default per-dispatch duration budget (D7, R73): 900s = 15m. */
export const DEFAULT_MAX_DURATION_S = 900;

/** Lifecycle statuses that mean the specialist has stopped working (R44). */
export const TERMINAL_LIFECYCLE_STATUSES = [
  "idle",
  "closed",
  "error",
  "terminated",
  "completed",
  "failed",
] as const;

/** Reads the canonical worktree's current HEAD commit (A6). */
export type GitCommitReader = (repoRoot: string) => string | null;

/**
 * Resolves a handle for an intent-without-created on resume (R37). The U4
 * adapter exposes no idempotency-key lookup, so the default honestly reports
 * "no handle" (which routes the unit to rework). A real resolver can be wired
 * to list agents by title/idempotency key when the substrate supports it.
 */
export type HandleResolver = (opts: {
  intent: InFlightIntent;
  unit: PlanUnit | null;
  packetHash: string;
}) => Promise<PaseoHandle | null>;

/** The resolved specialist profile: paseo role + provider/model (D8-i). */
export interface SpecialistProfile {
  paseo_role: string;
  provider: string;
  model: string;
}

/** Everything the dispatch layer needs to act on one run. */
export interface DispatchContext {
  store: RunStore;
  adapter: PaseoAdapter;
  /** The canonical repo root: source of the base commit (A6). */
  repoRoot: string;
  /** Handle lookup for intent-without-created reconciliation (R37). */
  handleResolver?: HandleResolver;
  /** Provider/model resolution for a role (defaults to D8-i + preferences). */
  roleResolver?: (role: SpecialistRole) => SpecialistProfile;
  /** Reads the worktree HEAD commit; defaults to the git CLI reader. */
  gitReader?: GitCommitReader;
  /** `~/.paseo/orchestration-preferences.json` (D8-i), injectable for tests. */
  preferencesPath?: string;
  /**
   * Run config (R80 snapshot). The `dispatch.default_workspace` value is read
   * from here when set; otherwise the run's manifest `config_snapshot` is
   * consulted (the production path), and absent everywhere the U4
   * new-worktree contract applies.
   */
  config?: Config;
  now?: () => number;
}

/** Lightweight handle on a live dispatch, for polling and harvesting. */
export interface DispatchRef {
  unit_id: UnitId;
  role: SpecialistRole;
  take: number;
  idempotency_key: string;
  deadline: string;
}

export interface DispatchOptions {
  unit: PlanUnit;
  role: SpecialistRole;
  take: number;
  /** ISO deadline; defaults to now + config max_duration (R73). */
  deadline?: string;
  /** Result-envelope path relative to the worktree; defaults per role/unit/take. */
  envelopePath?: string;
  /** Overrides the default plan excerpt (planner gets the full snapshot, R8). */
  planExcerpt?: string;
}

export type DispatchOutcome =
  | {
      status: "created";
      intent: JournalEvent;
      created: JournalEvent;
      handle: PaseoHandle;
      packet: DispatchPacket;
      ref: DispatchRef;
    }
  | { status: "failed"; intent: JournalEvent; failed: JournalEvent; packet: DispatchPacket };

export interface PollOptions {
  /** Poll cadence (step-boundary cadence). */
  cadenceMs: number;
  /** Safety cap on consecutive polls before giving up (tests). */
  maxPolls?: number;
  /** Overrides the result-envelope path (defaults per role/unit/take). */
  envelopePath?: string;
}

export type PollResult =
  | {
      status: "terminated";
      terminatedEvent: JournalEvent;
      envelope: ResultEnvelope | null;
      gapEvent: JournalEvent | null;
    }
  | { status: "gave-up"; lastStatus: string };

export interface HarvestResult {
  terminatedEvent: JournalEvent;
  envelope: ResultEnvelope | null;
  gapEvent: JournalEvent | null;
}

export interface ReconcileResult {
  intent: InFlightIntent;
  outcome: "no-handle" | "handle-found";
  /** True when the dispatch was refused because the deadline passed (R5). */
  refused: boolean;
  failedEvent: JournalEvent | null;
  createdEvent: JournalEvent | null;
  terminatedEvent: JournalEvent | null;
  handle: PaseoHandle | null;
  status: string | null;
}

// ---------------------------------------------------------------------------
// Time and git helpers
// ---------------------------------------------------------------------------

/** Whether `now` is past the recorded ISO deadline (R5). */
export function isPastDeadline(deadline: string | null, now: number): boolean {
  if (deadline === null || deadline.length === 0) {
    return false;
  }
  const time = Date.parse(deadline);
  if (Number.isNaN(time)) {
    return false;
  }
  return now > time;
}

/** Whether the adapter-reported lifecycle means the specialist stopped (R44). */
export function isTerminalLifecycle(status: string): boolean {
  return (TERMINAL_LIFECYCLE_STATUSES as readonly string[]).includes(status);
}

/** Deterministic idempotency key for a dispatch (R36: retry = new take). */
export function idempotencyKeyFor(
  unitId: UnitId,
  role: SpecialistRole,
  take: number,
): string {
  return `dispatch-${role}-${unitId}-t${take}`;
}

function dispatchTitle(role: SpecialistRole, unitId: UnitId, take: number): string {
  return `miah-${role}-${unitId}-t${take}`;
}

/** Read the worktree HEAD commit via git; best-effort (A6). */
export function defaultGitCommitReader(repoRoot: string): string | null {
  try {
    const out = cp.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const commit = String(out).trim();
    return commit.length > 0 ? commit : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Role defaults (D8-i + operator preferences)
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace id dispatches attach to instead of creating a new
 * worktree (attach-to-project hardening). Priority: the caller-provided
 * `ctx.config` (`dispatch.default_workspace`), then the run's admission-time
 * config snapshot (manifest `config_snapshot`, R80) so a run in progress keeps
 * the config it was admitted with. Absent everywhere -> undefined, and the U4
 * `--new-workspace worktree --worktree-mode branch-off` contract applies.
 */
function defaultWorkspaceOf(ctx: DispatchContext): string | undefined {
  const fromCtx = ctx.config?.dispatch?.default_workspace;
  if (typeof fromCtx === "string" && fromCtx.length > 0) {
    return fromCtx;
  }
  const manifest = readManifest(ctx.store.layout);
  const fromSnapshot = manifest?.config_snapshot?.dispatch?.default_workspace;
  return typeof fromSnapshot === "string" && fromSnapshot.length > 0 ? fromSnapshot : undefined;
}

function readRolePreferences(preferencesPath?: string): Record<string, unknown> | null {
  const filePath =
    preferencesPath ?? path.join(os.homedir(), ".paseo", "orchestration-preferences.json");
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Provider/model for a role: the operator's `~/.paseo/orchestration-preferences.json`
 * wins when present, otherwise the D8-i table defaults.
 */
export function resolveRoleDefaults(
  role: SpecialistRole,
  opts: { preferencesPath?: string } = {},
): SpecialistProfile {
  const base = D8I_ROLE_DEFAULTS[role];
  const prefs = readRolePreferences(opts.preferencesPath);
  if (prefs !== null) {
    const override = prefs[role];
    if (typeof override === "object" && override !== null) {
      const o = override as Record<string, unknown>;
      return {
        paseo_role: typeof o.paseo_role === "string" ? o.paseo_role : base.paseo_role,
        provider: typeof o.provider === "string" && o.provider.length > 0 ? o.provider : base.provider,
        model: typeof o.model === "string" && o.model.length > 0 ? o.model : base.model,
      };
    }
  }
  return { ...base };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function readPlanSnapshot(layout: RunStoreLayout): string {
  if (!fs.existsSync(layout.planSnapshotPath)) {
    throw new Error(`plan snapshot missing at ${layout.planSnapshotPath}`);
  }
  return fs.readFileSync(layout.planSnapshotPath, "utf8");
}

/** The dispatch ref view of a journaled in-flight intent (R37). */
export function refFromIntent(intent: InFlightIntent): DispatchRef {
  return {
    unit_id: intent.unit_id,
    role: intent.role as SpecialistRole,
    take: intent.take,
    idempotency_key: intent.idempotency_key,
    deadline: intent.deadline,
  };
}

/**
 * Dispatch one specialist for a unit attempt (R13, R17, R36). Journals
 * `dispatch_intent` before the adapter call leaves, then either `dispatch_created`
 * (observed identity + git base commit) or `dispatch_failed` (named reason,
 * idempotency key retained so a retry is a new take).
 */
export async function dispatchUnit(
  ctx: DispatchContext,
  opts: DispatchOptions,
): Promise<DispatchOutcome> {
  const now = ctx.now ? ctx.now() : Date.now();
  const deadline = opts.deadline ?? new Date(now + DEFAULT_MAX_DURATION_S * 1000).toISOString();
  const profile = (ctx.roleResolver ?? ((role) => resolveRoleDefaults(role, { preferencesPath: ctx.preferencesPath })))(opts.role);
  const envelopePath = opts.envelopePath ?? defaultEnvelopePath(opts.role, opts.unit.id, opts.take);
  const key = idempotencyKeyFor(opts.unit.id, opts.role, opts.take);

  const planSnapshotText = readPlanSnapshot(ctx.store.layout);
  const planExcerpt =
    opts.planExcerpt ??
    (opts.role === "planner"
      ? planSnapshotText
      : extractUnitSection(planSnapshotText, opts.unit.id) ?? planSnapshotText);

  const packet = composePacket({
    unit: opts.unit,
    role: opts.role,
    take: opts.take,
    planExcerpt,
    envelopePath,
    idempotencyKey: key,
    deadline,
    provider: profile.provider,
    model: profile.model,
  });
  const packetHash = computePacketHash(packet);

  // R17: the intent is durable before the adapter call leaves.
  const intent = ctx.store.append("dispatch_intent", {
    sender_role: "miah",
    role: opts.role,
    unit_id: opts.unit.id,
    take: opts.take,
    idempotency_key: key,
    packet_hash: packetHash,
    deadline,
    provider: profile.provider,
    model: profile.model,
  });

  try {
    const handle = await ctx.adapter.launch(renderPacketPrompt(packet, packetHash), {
      provider: profile.provider,
      model: profile.model,
      title: dispatchTitle(opts.role, opts.unit.id, opts.take),
      workspace: "worktree",
      worktreeMode: "branch-off",
      workspaceId: defaultWorkspaceOf(ctx),
      cwd: ctx.repoRoot,
    });
    const baseCommit = (ctx.gitReader ?? defaultGitCommitReader)(ctx.repoRoot);
    const created = ctx.store.append("dispatch_created", {
      unit_id: opts.unit.id,
      agent_id: handle.agentId,
      workspace_id: handle.workspaceId,
      base_commit: baseCommit,
    });
    const ref: DispatchRef = {
      unit_id: opts.unit.id,
      role: opts.role,
      take: opts.take,
      idempotency_key: key,
      deadline,
    };
    return { status: "created", intent, created, handle, packet, ref };
  } catch (error) {
    const failed = ctx.store.append("dispatch_failed", {
      unit_id: opts.unit.id,
      idempotency_key: key,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", intent, failed, packet };
  }
}

// ---------------------------------------------------------------------------
// Polling and harvest
// ---------------------------------------------------------------------------

/** Read the declared envelope and close the dispatch (R43-R44). */
export async function harvestEnvelope(
  ctx: DispatchContext,
  intent: DispatchRef,
  handle: PaseoHandle,
  envelopeRelPath: string,
): Promise<HarvestResult> {
  const envelopeAbs =
    handle.cwd !== null ? path.join(handle.cwd, envelopeRelPath) : null;
  const envelope = envelopeAbs !== null ? readEnvelope(envelopeAbs) : null;

  if (envelope !== null) {
    ctx.store.append("result_envelope_observed", {
      unit_id: intent.unit_id,
      envelope_path: envelopeAbs,
      producer_role: envelope.producer_role,
      attempt_id: envelope.attempt_id,
      take: envelope.take,
    });
    const terminatedEvent = ctx.store.append("dispatch_terminated", {
      unit_id: intent.unit_id,
      outcome: "success",
      envelope_path: envelopeAbs,
    });
    return { terminatedEvent, envelope, gapEvent: null };
  }

  // R43: an absent envelope is an evidence gap, not an auto-failure and not an
  // auto-completion. The dispatch still closes (terminated) but with a
  // non-success outcome and an open gap the acceptance predicate must resolve.
  const gapEvent = ctx.store.append("gap_recorded", {
    unit_id: intent.unit_id,
    criterion: "result-envelope",
    reason:
      "result envelope absent at declared path after specialist termination (R43)",
  });
  const terminatedEvent = ctx.store.append("dispatch_terminated", {
    unit_id: intent.unit_id,
    outcome: "envelope-missing",
    envelope_path: envelopeAbs,
  });
  return { terminatedEvent, envelope: null, gapEvent };
}

/**
 * Refuse work past a recorded deadline (R5/R44): terminate the specialist
 * immediately and close the dispatch with a deadline-exceeded gap. The full
 * deadline-exceeded handling pipeline lands in U6; the dispatch layer only
 * makes the refusal decision and records the gap.
 */
export async function refusePastDeadline(
  ctx: DispatchContext,
  intent: DispatchRef,
  handle: PaseoHandle,
): Promise<{ terminatedEvent: JournalEvent; gapEvent: JournalEvent }> {
  try {
    await ctx.adapter.stop(handle);
  } catch {
    // best-effort terminate (R5): the agent may already be terminal.
  }
  const gapEvent = ctx.store.append("gap_recorded", {
    unit_id: intent.unit_id,
    criterion: "deadline",
    reason: "specialist ran past the recorded deadline; work refused (R5)",
  });
  const terminatedEvent = ctx.store.append("dispatch_terminated", {
    unit_id: intent.unit_id,
    outcome: "deadline-exceeded",
    idempotency_key: intent.idempotency_key,
  });
  return { terminatedEvent, gapEvent };
}

/**
 * Poll `status(handle)` at the step-boundary cadence until the adapter reports
 * terminal. On terminal: refuse if the deadline passed, otherwise read the
 * result envelope and journal `dispatch_terminated` (plus a gap when the
 * envelope is absent, R43).
 */
export async function pollUntilTerminal(
  ctx: DispatchContext,
  handle: PaseoHandle,
  intent: DispatchRef,
  opts: PollOptions,
): Promise<PollResult> {
  if (isPastDeadline(intent.deadline, ctx.now ? ctx.now() : Date.now())) {
    const { terminatedEvent, gapEvent } = await refusePastDeadline(ctx, intent, handle);
    return { status: "terminated", terminatedEvent, envelope: null, gapEvent };
  }

  let polls = 0;
  for (;;) {
    const status = await ctx.adapter.status(handle);
    if (isTerminalLifecycle(status)) {
      if (isPastDeadline(intent.deadline, ctx.now ? ctx.now() : Date.now())) {
        const { terminatedEvent, gapEvent } = await refusePastDeadline(ctx, intent, handle);
        return { status: "terminated", terminatedEvent, envelope: null, gapEvent };
      }
      const envelopeRel =
        opts.envelopePath ?? defaultEnvelopePath(intent.role, intent.unit_id, intent.take);
      const harvest = await harvestEnvelope(ctx, intent, handle, envelopeRel);
      return { status: "terminated" as const, ...harvest };
    }
    if (opts.maxPolls !== undefined && polls >= opts.maxPolls) {
      return { status: "gave-up", lastStatus: status };
    }
    polls += 1;
    await sleep(opts.cadenceMs);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (R37-R38)
// ---------------------------------------------------------------------------

const noHandleResolver: HandleResolver = async () => null;

async function reconcileOne(
  ctx: DispatchContext,
  intent: InFlightIntent,
  unit: PlanUnit | null,
): Promise<ReconcileResult> {
  const now = ctx.now ? ctx.now() : Date.now();
  const ref = refFromIntent(intent);
  const envelopeRel = defaultEnvelopePath(ref.role, ref.unit_id, ref.take);

  let handle: PaseoHandle | null = null;
  let createdEvent: JournalEvent | null = null;
  let status: string | null = null;

  if (intent.agent_id !== null && intent.agent_id !== "") {
    // Created identity was journaled: re-read the live lifecycle from the
    // adapter (R37), which also recovers the worktree cwd for harvesting.
    handle = { agentId: intent.agent_id, cwd: null, workspaceId: intent.workspace_id };
    const inspect = await ctx.adapter.inspect(handle);
    status = inspect.lifecycle;
    handle = { ...handle, cwd: inspect.cwd ?? handle.cwd };
  } else {
    // Intent-without-created: query the adapter (resolver seam) by idempotency
    // key / target + packet hash (R37).
    handle = await (ctx.handleResolver ?? noHandleResolver)({
      intent,
      unit,
      packetHash: intent.packet_hash,
    });
    if (handle === null) {
      ctx.store.append("reconcile_record", {
        unit_id: intent.unit_id,
        idempotency_key: intent.idempotency_key,
        intent_seq: intent.seq,
        finding: "no-handle",
        deadline: intent.deadline,
      });
      const failedEvent = ctx.store.append("dispatch_failed", {
        unit_id: intent.unit_id,
        idempotency_key: intent.idempotency_key,
        reason: "reconciliation: no handle found for recorded dispatch intent (R37)",
      });
      return {
        intent,
        outcome: "no-handle",
        refused: false,
        failedEvent,
        createdEvent: null,
        terminatedEvent: null,
        handle: null,
        status: null,
      };
    }
    createdEvent = ctx.store.append("dispatch_created", {
      unit_id: intent.unit_id,
      agent_id: handle.agentId,
      workspace_id: handle.workspaceId,
      base_commit: (ctx.gitReader ?? defaultGitCommitReader)(ctx.repoRoot),
    });
    const inspect = await ctx.adapter.inspect(handle);
    status = inspect.lifecycle;
    handle = { ...handle, cwd: inspect.cwd ?? handle.cwd };
  }

  // Deadline refusal (R5): refuse all work produced past the recorded deadline
  // before deciding any next transition.
  if (isPastDeadline(intent.deadline, now)) {
    ctx.store.append("reconcile_record", {
      unit_id: intent.unit_id,
      idempotency_key: intent.idempotency_key,
      intent_seq: intent.seq,
      finding: "deadline-exceeded",
      agent_id: handle.agentId,
      lifecycle: status,
      deadline: intent.deadline,
    });
    const { terminatedEvent } = await refusePastDeadline(ctx, ref, handle);
    return {
      intent,
      outcome: "handle-found",
      refused: true,
      failedEvent: null,
      createdEvent,
      terminatedEvent,
      handle,
      status,
    };
  }

  ctx.store.append("reconcile_record", {
    unit_id: intent.unit_id,
    idempotency_key: intent.idempotency_key,
    intent_seq: intent.seq,
    finding: "handle-found",
    agent_id: handle.agentId,
    workspace_id: handle.workspaceId,
    lifecycle: status,
    deadline: intent.deadline,
  });

  if (status !== null && isTerminalLifecycle(status)) {
    const harvest = await harvestEnvelope(ctx, ref, handle, envelopeRel);
    return {
      intent,
      outcome: "handle-found",
      refused: false,
      failedEvent: null,
      createdEvent,
      terminatedEvent: harvest.terminatedEvent,
      handle,
      status,
    };
  }

  // Live: resume polling (the caller keeps the returned handle).
  return {
    intent,
    outcome: "handle-found",
    refused: false,
    failedEvent: null,
    createdEvent,
    terminatedEvent: null,
    handle,
    status,
  };
}

/**
 * Reconcile every in-flight dispatch intent on restart (R37): replay-then-
 * reconcile, never replay alone (R38). For each intent-without-created the
 * adapter is queried (resolver seam); a missing handle appends
 * `dispatch_failed` (unit routed to rework); a found handle appends
 * `dispatch_created` with the discovered identity. Each intent gets a
 * `reconcile_record` before the decision.
 */
export async function reconcileIntents(ctx: DispatchContext): Promise<ReconcileResult[]> {
  const units = readUnitsJson(ctx.store.layout.unitsJsonPath);
  const intents = [...ctx.store.stateSnapshot().in_flight_intents];
  const results: ReconcileResult[] = [];
  for (const intent of intents) {
    const unit = units !== null ? (units[intent.unit_id] ?? null) : null;
    results.push(await reconcileOne(ctx, intent, unit));
  }
  return results;
}
