/**
 * `miah approve <run-id>` command (R67, F15).
 *
 * Final approval for a run whose units are all accepted. Guards on the run
 * being fully accepted (R67: approval is only meaningful at the
 * AwaitingApproval gate), journals `operator_decision: approve` (R69), moves
 * the phase AwaitingApproval -> Complete, appends `run_terminal: complete`,
 * and releases the lease. Rejections go through `miah reject` instead.
 */
import { loadConfig, resolveConfigBasePath } from "../config";
import { ensurePhase } from "../fsm";
import { readManifest } from "../manifest";
import { resolveRunLayout, RunStore } from "../run-store";
import { allUnitsAccepted, readUnitsFromStore } from "../step";
import type { Config } from "../types";
import { operatorIdentity } from "./stop";

/** Exit code when the run cannot be approved. */
export const APPROVE_ERROR_EXIT_CODE = 1;

export interface ApproveOptions {
  config?: Config;
  basePath?: string;
  holderId?: string;
}

/**
 * Run `miah approve` for a run id. Returns the process exit code: 0 when the
 * run terminates complete, non-zero when the run is not fully accepted, is
 * already terminal, does not exist, or the lease is held by a live driver.
 */
export async function runApprove(runId: string, opts: ApproveOptions = {}): Promise<number> {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const layout = resolveRunLayout(basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    console.error(`miah approve: no run found for ${runId}`);
    return APPROVE_ERROR_EXIT_CODE;
  }
  const config = opts.config ?? loadConfig();
  const holderId = opts.holderId ?? `miah-op-${process.pid}`;
  const store = new RunStore({ basePath, runId, config, holderId });
  const acquired = store.lease.acquire(holderId);
  if (!acquired.ok) {
    console.error(
      `miah approve: lease held by ${acquired.lease.holder_id} (fresh heartbeat); cannot approve while a driver is active`,
    );
    return APPROVE_ERROR_EXIT_CODE;
  }
  try {
    const state = store.replay().state;
    if (state.terminal !== null) {
      console.error(`miah approve: run is already terminal (${state.terminal})`);
      return APPROVE_ERROR_EXIT_CODE;
    }
    const units = readUnitsFromStore(store);
    if (units === null || !allUnitsAccepted(state, units)) {
      console.error("miah approve: run is not fully accepted; cannot approve (R67)");
      return APPROVE_ERROR_EXIT_CODE;
    }

    store.append("operator_decision", { operator: operatorIdentity(), decision: "approve" });
    // FSM: AwaitingApproval -> Complete (KTD14). Tolerate a phase that cannot
    // move to AwaitingApproval; the run_terminal event is authoritative.
    if (store.stateSnapshot().phase !== "AwaitingApproval") {
      try {
        ensurePhase(store, "AwaitingApproval");
      } catch {
        // best effort
      }
    }
    ensurePhase(store, "Complete");
    store.append("run_terminal", { status: "complete" });

    console.log(`miah approve: run ${runId} approved (run_terminal: complete)`);
    return 0;
  } finally {
    try {
      store.lease.release(holderId);
    } catch {
      // best effort
    }
  }
}
