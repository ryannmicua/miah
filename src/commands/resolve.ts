/**
 * `miah resolve <run-id> <escalation-id> --decision <approve|deny|rework> [--note <text>]`
 * command (R66, R69, F14).
 *
 * Closes one pending escalation with the operator's decision and marks the
 * affected unit for re-dispatch (rework) or acceptance (approve). Journaled
 * under the lease (R69): an `operator_decision: resolve` event, then an
 * `escalation_resolved` event with the close reason. `approve` also closes the
 * escalated criterion's gap and journals `acceptance_decision: accept` (the
 * operator's judgment is the authority for the human/calibrated-judge tier,
 * R47/R48). `rework` journals `rework_started` so the unit is dispatch-eligible
 * again. `deny` closes the escalation without changing unit state; a
 * still-blocking condition re-raises on the next `miah run`. A run paused in
 * Attention resumes via Attention -> Ready so the next `miah run` re-dispatches
 * (R66, F14).
 */
import { PaseoCliAdapter, type PaseoAdapter, type PaseoHandle } from "../adapter/paseo";
import { commitIntegrationFiles, runIntegrationCheck } from "../acceptance";
import { loadConfig, resolveConfigBasePath } from "../config";
import { unresolvedEscalations } from "../escalation";
import { ensurePhase } from "../fsm";
import { readManifest } from "../manifest";
import { resolveRunLayout, RunStore } from "../run-store";
import { readUnitsFromStore } from "../step";
import type { Config, PlanUnit, UnitId } from "../types";
import { operatorIdentity } from "./stop";

/** Exit code when the run or escalation cannot be resolved. */
export const RESOLVE_ERROR_EXIT_CODE = 1;

/** The D6-a escalation decision set. */
export type ResolveDecision = "approve" | "deny" | "rework";

export interface ResolveOptions {
  config?: Config;
  basePath?: string;
  holderId?: string;
  /** Canonical worktree the approved unit's `creates:` integrate into (R89). */
  canonicalWorktree?: string;
  /** Verification-contract commands per unit (R45); absent for a unit means no commands run. */
  verificationCommandsFor?: (unit: PlanUnit) => string[];
  /** Adapter for recovering the approved unit's last-take worktree (R89). */
  adapter?: PaseoAdapter;
}

/**
 * Run `miah resolve` for a run id and escalation id. Returns the process exit
 * code: 0 on success, non-zero when the run does not exist, the escalation is
 * not open, or the lease is held by a live driver.
 */
export async function runResolve(
  runId: string,
  escalationId: string,
  decision: ResolveDecision,
  note?: string,
  opts: ResolveOptions = {},
): Promise<number> {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const layout = resolveRunLayout(basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    console.error(`miah resolve: no run found for ${runId}`);
    return RESOLVE_ERROR_EXIT_CODE;
  }
  const config = opts.config ?? loadConfig();
  const holderId = opts.holderId ?? `miah-op-${process.pid}`;
  const store = new RunStore({ basePath, runId, config, holderId });
  const acquired = store.lease.acquire(holderId);
  if (!acquired.ok) {
    console.error(
      `miah resolve: lease held by ${acquired.lease.holder_id} (fresh heartbeat); cannot resolve while a driver is active`,
    );
    return RESOLVE_ERROR_EXIT_CODE;
  }
  try {
    const escalations = unresolvedEscalations(store);
    const escalation = escalations.find((entry) => entry.escalation_id === escalationId);
    if (escalation === undefined) {
      console.error(`miah resolve: escalation ${escalationId} not found or already resolved`);
      return RESOLVE_ERROR_EXIT_CODE;
    }

    const operator = operatorIdentity();
    store.append("operator_decision", {
      operator,
      decision: "resolve",
      escalation_id: escalationId,
      resolve_decision: decision,
      note: note ?? null,
    });
    store.append("escalation_resolved", {
      escalation_id: escalationId,
      decision,
      close_reason: note ?? "resolved by operator",
      operator,
    });

    const unitId = escalation.unit_id;
    if (decision === "approve" && unitId !== null) {
      // Operator approval is the authority for the escalated criterion: close
      // its gap and mark the unit accepted (F14, R47/R48).
      if (escalation.criterion !== null) {
        store.append("gap_closed", {
          unit_id: unitId,
          criterion: escalation.criterion,
          close_reason: note ?? "operator approved the escalation",
        });
      }
      // Acceptance supersedes every remaining open gap on the unit (replay
      // drops them on `acceptance_decision: accept`). Journal a `gap_closed`
      // per remaining gap BEFORE the acceptance so the approval package's
      // `gap_close_reasons` list stays complete and R50's "a problem cannot
      // disappear silently" holds. The operator's approval is the close reason.
      for (const gap of store.stateSnapshot().open_gaps) {
        if (gap.unit_id === unitId) {
          store.append("gap_closed", {
            unit_id: unitId,
            criterion: gap.criterion,
            close_reason: "operator-approval",
          });
        }
      }
      store.append("acceptance_decision", {
        unit_id: unitId,
        decision: "accept",
        via: "operator-resolve",
        reason: note ?? null,
      });

      // R89: an operator-accepted unit is still accepted, so its `creates:`
      // deliverables must integrate into the canonical worktree. Recover the
      // unit's last-take worktree and run the standard integration check
      // (copy -> verify -> commit). Failure is journaled as the smuggle gap
      // (the operator's acceptance stands; the gap is surfaced).
      await integrateApprovedUnit(store, unitId, opts);
    } else if (decision === "rework" && unitId !== null) {
      // Mark the affected unit for re-dispatch (F14).
      store.append("rework_started", { unit_id: unitId, via: "operator-resolve" });
    }

    // Resume a paused run: Attention -> Ready so the next `miah run` advances
    // (R66 resume path; a still-blocking condition re-raises in the driver).
    if (store.stateSnapshot().phase === "Attention") {
      ensurePhase(store, "Ready");
    }

    console.log(`miah resolve: escalation ${escalationId} resolved with ${decision}`);
    return 0;
  } finally {
    try {
      store.lease.release(holderId);
    } catch {
      // best effort
    }
  }
}

/**
 * R89 follow-through for an operator-approved unit: copy its `creates:`
 * deliverables from the last take's worktree into the canonical worktree, run
 * the verification contract there, and commit the integration. No-op when no
 * canonical checkout is configured, the unit declares no `creates:`, or the
 * worktree can no longer be recovered. A verification failure in the
 * integrated checkout is journaled as the standard integration-smuggle gap.
 */
async function integrateApprovedUnit(
  store: RunStore,
  unitId: UnitId,
  opts: ResolveOptions,
): Promise<void> {
  const canonicalWorktree = opts.canonicalWorktree;
  if (!canonicalWorktree) {
    return;
  }
  const units = readUnitsFromStore(store);
  const unit = units !== null ? units[unitId] : undefined;
  if (unit === undefined || (unit.creates ?? []).length === 0) {
    return;
  }
  const created = store.journal
    .readEvents()
    .filter((event) => event.type === "dispatch_created" && event.unit_id === unitId)
    .pop();
  const agentId = created?.agent_id;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return;
  }
  const workspaceId = created?.workspace_id;
  const adapter = opts.adapter ?? new PaseoCliAdapter();
  let handle: PaseoHandle;
  try {
    const inspect = await adapter.inspect({
      agentId,
      cwd: null,
      workspaceId: typeof workspaceId === "string" ? workspaceId : null,
    });
    handle = { agentId, cwd: inspect.cwd ?? null, workspaceId: null };
  } catch {
    // Best effort: the worktree is no longer recoverable; the acceptance
    // stands but the deliverable is not integrated into the canonical repo.
    return;
  }
  if (handle.cwd === null) {
    return;
  }
  const verificationCommands = opts.verificationCommandsFor ? opts.verificationCommandsFor(unit) : [];
  await runIntegrationCheck({
    store,
    unit,
    sourceWorktree: handle.cwd,
    canonicalWorktree,
    verificationCommands,
    commitIntegration: commitIntegrationFiles,
  });
}
