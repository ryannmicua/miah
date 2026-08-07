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
 * again. A run paused in Attention resumes via Attention -> Ready so the next
 * `miah run` re-dispatches (R66, F14).
 */
import { loadConfig, resolveConfigBasePath } from "../config";
import { unresolvedEscalations } from "../escalation";
import { ensurePhase } from "../fsm";
import { readManifest } from "../manifest";
import { resolveRunLayout, RunStore } from "../run-store";
import type { Config } from "../types";
import { operatorIdentity } from "./stop";

/** Exit code when the run or escalation cannot be resolved. */
export const RESOLVE_ERROR_EXIT_CODE = 1;

/** The D6-a escalation decision set. */
export type ResolveDecision = "approve" | "deny" | "rework";

export interface ResolveOptions {
  config?: Config;
  basePath?: string;
  holderId?: string;
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
      store.append("acceptance_decision", {
        unit_id: unitId,
        decision: "accept",
        via: "operator-resolve",
        reason: note ?? null,
      });
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
