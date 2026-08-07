/**
 * The looping driver (U8): `miah run` / `miah run --once`.
 *
 * The driver owns the terminal: it acquires the run's single-writer lease (R3,
 * R15), replays the durable record, reconciles prior sessions, and then loops
 * the step function until a stop condition is reached (R3, R42, R37):
 *
 *   - all units accepted -> AwaitingApproval, approval package written (R67),
 *     lease released, driver exits with a summary (KTD17)
 *   - an escalation is raised / the run is in Attention -> the run is paused;
 *     the driver prints the escalation details and exits (R66)
 *   - no executable work remains -> `escalation_raised: blocked-no-eligible-work`
 *     -> Attention (R66)
 *   - a `stop-requested` flag is seen at a step boundary -> terminate in-flight
 *     specialists via the adapter, append `phase_transition: Stopping`, release
 *     the lease (R65). A stop recorded while no driver was alive is honored on
 *     the next `miah run` / `miah run --once`.
 *
 * `--once` runs exactly one step and exits; a subsequent `--once` continues
 * (D6-a, KTD15). Every step boundary renews the lease heartbeat (R40); the
 * lease is released on every clean exit so the next driver resumes immediately.
 */
import * as fs from "fs";
import * as path from "path";
import type { PaseoAdapter } from "./adapter/paseo";
import { readManifest } from "./manifest";
import {
  allUnitsAccepted,
  createStepRuntime,
  cumulativeUsageFromEvidence,
  findEligibleUnits,
  readUnitsFromStore,
  runStep,
  type StepContext,
  type StepRuntime,
} from "./step";
import { ensurePhase } from "./fsm";
import {
  raiseEscalation,
  unresolvedEscalations,
  type EscalationSummary,
} from "./escalation";
import type { RunStore, RunStoreLayout } from "./run-store";
import type { Config, PlanUnit } from "./types";
import type {
  CommandRunner,
  DiffRunner,
} from "./evidence";
import type { GitCommitReader, HandleResolver } from "./dispatch";

// ---------------------------------------------------------------------------
// stop-requested flag (R65)
// ---------------------------------------------------------------------------

const STOP_REQUESTED_FILENAME = "stop-requested.json";

/** Path of the run-store `stop-requested` flag (R65). */
export function stopRequestedPath(layout: RunStoreLayout): string {
  return path.join(layout.root, STOP_REQUESTED_FILENAME);
}

/** Read the `stop-requested` flag; false when absent or unparseable (R65). */
export function readStopRequested(layout: RunStoreLayout): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stopRequestedPath(layout), "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).stop_requested === true
    );
  } catch {
    return false;
  }
}

/** Set the `stop-requested` flag (`miah stop` in U9; tests use this directly). */
export function writeStopRequested(layout: RunStoreLayout): void {
  fs.writeFileSync(
    stopRequestedPath(layout),
    `${JSON.stringify({ stop_requested: true, requested_at: Date.now() }, null, 2)}\n`,
    "utf8",
  );
}

/** Clear the flag once the lease-holding driver has honored it (R65). */
export function clearStopRequested(layout: RunStoreLayout): void {
  try {
    fs.rmSync(stopRequestedPath(layout), { force: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Driver result
// ---------------------------------------------------------------------------

export type DriverStatus = "complete" | "attention" | "stopped" | "lease-held" | "advanced";

/** What a driver session did, for the CLI to render. */
export interface DriverResult {
  status: DriverStatus;
  phase: string;
  /** Human-readable summary printed to stdout (R66/R67, KTD17). */
  message: string;
  /** Steps executed this session. */
  stepsRun: number;
  /** Escalations pending at exit (R66). */
  escalations: EscalationSummary[];
  /** Approval-package path, or null when the run is not complete. */
  approvalPackagePath: string | null;
}

export interface DriverOptions {
  store: RunStore;
  /** The lease-holding identity of this driver process. */
  holderId: string;
  config: Config;
  adapter: PaseoAdapter;
  /** The canonical repo root: base-commit source (A6). */
  repoRoot: string;
  /** The canonical worktree accepted `creates:` files integrate into (R89). */
  canonicalWorktree: string;
  /** `--once`: run one step and exit (D6-a). */
  once?: boolean;
  handleResolver?: HandleResolver;
  gitReader?: GitCommitReader;
  preferencesPath?: string;
  diffRunner?: DiffRunner;
  runCommand?: CommandRunner;
  verificationCommandsFor?: (unit: PlanUnit) => string[];
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function buildMessage(
  status: DriverStatus,
  escalations: EscalationSummary[],
  approvalPackagePath: string | null,
): string {
  switch (status) {
    case "complete":
      return approvalPackagePath !== null
        ? `run complete: all units accepted (AwaitingApproval). approval package: ${approvalPackagePath}`
        : "run complete";
    case "attention": {
      const lines = escalations.map(
        (escalation) =>
          `  [${escalation.escalation_id}] unit=${escalation.unit_id ?? "run"} ` +
          `trigger=${escalation.trigger}: ${escalation.reason}`,
      );
      return `run paused in Attention (R66) — operator resolve required\n${lines.join("\n")}`;
    }
    case "stopped":
      return "run stopped (R65): in-flight specialists terminated, phase=Stopping, lease released";
    case "advanced":
      return "step advanced; the run continues on the next `miah run`";
    case "lease-held":
      return "lease held by another driver with a fresh heartbeat; run not started (R39)";
    default:
      return status;
  }
}

/** Release the lease as the last durable act of a clean driver exit. */
function releaseLease(store: RunStore, holderId: string): void {
  try {
    // Refresh the heartbeat first so the release's own journal append passes
    // the fresh-holder gate even if the step advanced the clock.
    store.lease.maybeHeartbeat(holderId);
    store.lease.release(holderId);
  } catch {
    // Best effort: the lease may already be gone or the process is exiting.
  }
}

function finishResult(
  store: RunStore,
  holderId: string,
  status: DriverStatus,
  stepsRun: number,
  approvalPackagePath: string | null = null,
): DriverResult {
  const phase = store.replay().state.phase;
  const escalations = unresolvedEscalations(store);
  releaseLease(store, holderId);
  return {
    status,
    phase,
    message: buildMessage(status, escalations, approvalPackagePath),
    stepsRun,
    escalations,
    approvalPackagePath,
  };
}

/**
 * Terminate in-flight specialists and journal the Stopping transition (R65).
 * Every in-flight intent is closed with `dispatch_terminated: stopped` so a
 * later resume never harvests work produced around the stop.
 */
async function stopAndRelease(ctx: StepContext, runtime: StepRuntime): Promise<void> {
  const store = ctx.store;
  const state = store.replay().state;
  for (const intent of state.in_flight_intents) {
    let handle = runtime.handlesByUnit.get(intent.unit_id);
    if (handle === undefined && intent.agent_id !== null && intent.agent_id !== "") {
      handle = { agentId: intent.agent_id, cwd: null, workspaceId: intent.workspace_id };
    }
    if (handle !== undefined && intent.agent_id !== null && intent.agent_id !== "") {
      try {
        await ctx.adapter.stop(handle);
      } catch {
        // best-effort terminate (R5): the agent may already be terminal.
      }
    }
    store.append("dispatch_terminated", {
      unit_id: intent.unit_id,
      outcome: "stopped",
      idempotency_key: intent.idempotency_key,
    });
  }
  ensurePhase(store, "Stopping");
}

/** List harvested evidence files under a unit's evidence dir (relative paths). */
function listEvidenceFiles(evidenceDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const entryRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, entryRel);
      } else {
        files.push(entryRel);
      }
    }
  };
  walk(evidenceDir, "");
  return files.sort();
}

/**
 * Write the consolidated approval package (R67) when every unit is accepted.
 * Contains per-unit evidence pointers + acceptance records, gap-close reasons,
 * usage totals, the plan hash, and run duration.
 */
export function writeApprovalPackage(store: RunStore, config: Config): string | null {
  const layout = store.layout;
  const state = store.replay().state;
  const units = readUnitsFromStore(store);
  if (units === null) {
    return null;
  }
  const manifest = readManifest(layout);
  const perUnit: Record<string, unknown> = {};
  for (const unitId of Object.keys(units)) {
    const s = state.units[unitId];
    perUnit[unitId] = {
      status: s?.status ?? "not_started",
      takes: s?.takes ?? 0,
      rework_cycles: s?.rework_cycles ?? 0,
      acceptance: s?.last_acceptance ?? null,
      evidence: listEvidenceFiles(path.join(layout.evidenceDir, unitId)),
    };
  }
  const gapCloses = store.journal
    .readEvents()
    .filter((event) => event.type === "gap_closed")
    .map((event) => ({
      unit_id: event.unit_id,
      criterion: event.criterion,
      close_reason: event.close_reason,
    }));
  const usage = cumulativeUsageFromEvidence(store);
  const createdAt = manifest !== null ? manifest.created_at : null;
  const now = Date.now();
  const completedAt = new Date(now).toISOString();
  const startedMs = createdAt !== null ? Date.parse(createdAt) : null;
  const durationS =
    startedMs !== null && Number.isFinite(startedMs) && startedMs > 0
      ? Math.max(0, (now - startedMs) / 1000)
      : null;
  const approvalPackage = {
    schema: "miah/approval-package/v1",
    run_id: manifest?.run_id ?? state.run_id ?? layout.runId,
    plan_hash: manifest?.plan_hash ?? state.plan_hash,
    created_at: createdAt,
    completed_at: completedAt,
    duration_s: durationS,
    phase: state.phase,
    units: perUnit,
    gap_close_reasons: gapCloses,
    usage: usage ?? { inputTokens: null, outputTokens: null, costUsd: null },
  };
  fs.writeFileSync(
    layout.approvalPackagePath,
    `${JSON.stringify(approvalPackage, null, 2)}\n`,
    "utf8",
  );
  return layout.approvalPackagePath;
}

/**
 * Run the driver. Acquires the lease, reconstructs + reconciles, then loops the
 * step function until a stop condition. `--once` executes one step and exits.
 */
export async function runDriver(opts: DriverOptions): Promise<DriverResult> {
  const { store, holderId, config } = opts;
  const ctx: StepContext = {
    store,
    adapter: opts.adapter,
    repoRoot: opts.repoRoot,
    canonicalWorktree: opts.canonicalWorktree,
    config,
    handleResolver: opts.handleResolver,
    gitReader: opts.gitReader,
    preferencesPath: opts.preferencesPath,
    diffRunner: opts.diffRunner,
    runCommand: opts.runCommand,
    verificationCommandsFor: opts.verificationCommandsFor,
    now: opts.now,
  };
  const runtime = createStepRuntime();

  const acquired = store.lease.acquire(holderId);
  if (!acquired.ok) {
    return {
      status: "lease-held",
      phase: store.stateSnapshot().phase,
      message: buildMessage("lease-held", [], null),
      stepsRun: 0,
      escalations: [],
      approvalPackagePath: null,
    };
  }
  // Reconstruct under lease (R3): repair a crash tail and derive state (R42).
  store.replay();

  // R65: a stop recorded while no driver was alive is honored here.
  if (readStopRequested(store.layout)) {
    await stopAndRelease(ctx, runtime);
    clearStopRequested(store.layout);
    return finishResult(store, holderId, "stopped", 0);
  }

  // Resume into a run already paused/complete without advancing a step.
  const initialPhase = store.replay().state.phase;
  if (initialPhase === "Attention") {
    return finishResult(store, holderId, "attention", 0);
  }
  if (initialPhase === "AwaitingApproval") {
    const pkgPath = writeApprovalPackage(store, config);
    return finishResult(store, holderId, "complete", 0, pkgPath);
  }
  if (initialPhase === "Complete") {
    return finishResult(store, holderId, "complete", 0);
  }
  // A fresh/initial run opens from Admitting/not-started; a stopped run resumes
  // from Stopping. An active run (Implementing/Reviewing) keeps its phase.
  if (
    initialPhase === "not-started" ||
    initialPhase === "Admitting" ||
    initialPhase === "Stopping"
  ) {
    ensurePhase(store, "Ready");
  }

  let stepsRun = 0;
  for (;;) {
    store.lease.maybeHeartbeat(holderId); // R40 heartbeat at the step boundary

    // R65: read stop-requested at each step boundary.
    if (readStopRequested(store.layout)) {
      await stopAndRelease(ctx, runtime);
      clearStopRequested(store.layout);
      return finishResult(store, holderId, "stopped", stepsRun);
    }

    const phaseNow = store.replay().state.phase;
    if (phaseNow === "Attention") {
      return finishResult(store, holderId, "attention", stepsRun);
    }
    if (phaseNow === "AwaitingApproval") {
      const pkgPath = writeApprovalPackage(store, config);
      return finishResult(store, holderId, "complete", stepsRun, pkgPath);
    }

    const outcome = await runStep(ctx, runtime);
    stepsRun += 1;

    const state = store.replay().state;
    if (state.phase === "Attention") {
      return finishResult(store, holderId, "attention", stepsRun);
    }
    if (state.phase === "AwaitingApproval" || allUnitsAccepted(state, runtime.units ?? {})) {
      if (state.phase !== "AwaitingApproval") {
        ensurePhase(store, "AwaitingApproval");
      }
      const pkgPath = writeApprovalPackage(store, config);
      return finishResult(store, holderId, "complete", stepsRun, pkgPath);
    }
    // R66: no executable work remains (nothing in-flight, nothing eligible, not
    // all accepted) -> escalate -> Attention. A reconcile-only or in-flight step
    // never counts as blocked.
    if (
      state.in_flight_intents.length === 0 &&
      findEligibleUnits(state, runtime.units ?? {}).length === 0
    ) {
      raiseEscalation(store, {
        unit_id: null,
        trigger: "blocked-no-eligible-work",
        reason: "no executable work remains and not all units are accepted (R66)",
      });
      ensurePhase(store, "Attention");
      return finishResult(store, holderId, "attention", stepsRun);
    }
    if (opts.once) {
      return finishResult(store, holderId, "advanced", stepsRun);
    }
  }
}
