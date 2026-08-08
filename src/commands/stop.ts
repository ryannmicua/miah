/**
 * `miah stop <run-id>` command (R65, F13, D6-c).
 *
 * Appends an `operator_decision: stop` journal event and sets the run-store
 * `stop-requested` flag. The flag is written first and unconditionally — it is
 * the durable signal a live driver reads at its next step boundary (R65), even
 * when another driver holds the lease. The journal event is appended under the
 * lease when it is free (the normal paused-run case) so the decision is
 * recorded with the operator's identity, timestamp, and decision (R69).
 *
 * No driver-side work happens here: the lease-holding driver honors the flag
 * (terminate in-flight, `phase_transition: Stopping`, release the lease — U8).
 *
 * This module also hosts `operatorIdentity` (R69), shared by every operator
 * command so every `operator_decision` event carries the same identity source.
 */
import * as os from "os";
import { loadConfig, resolveConfigBasePath } from "../config";
import { writeStopRequested } from "../driver";
import { readManifest } from "../manifest";
import { resolveRunLayout, RunStore } from "../run-store";
import type { Config } from "../types";

/** Exit code when the run cannot be found. */
export const STOP_ERROR_EXIT_CODE = 1;

/**
 * Operator identity for journaled operator decisions (R69). Honors the
 * `MIAH_OPERATOR` env override, then the OS username, then a plain fallback —
 * never empty.
 */
export function operatorIdentity(): string {
  const fromEnv = process.env.MIAH_OPERATOR;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const name = os.userInfo().username;
    if (typeof name === "string" && name.length > 0) {
      return name;
    }
  } catch {
    // fall through to the generic identity
  }
  return "operator";
}

export interface StopOptions {
  config?: Config;
  basePath?: string;
  holderId?: string;
}

/**
 * Run `miah stop` for a run id. Returns the process exit code: 0 when the stop
 * request is durably recorded (flag always; journal event when the lease is
 * free), non-zero when the run does not exist.
 */
export function runStop(runId: string, opts: StopOptions = {}): number {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const layout = resolveRunLayout(basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    console.error(`miah stop: no run found for ${runId}`);
    return STOP_ERROR_EXIT_CODE;
  }
  const config = opts.config ?? loadConfig();
  const holderId = opts.holderId ?? `miah-op-${process.pid}`;
  const store = new RunStore({ basePath, runId, config, holderId });

  // Durable signal first (R65): survives even while a driver holds the lease.
  writeStopRequested(layout);

  const acquired = store.lease.acquire(holderId);
  if (!acquired.ok) {
    console.log(
      `miah stop: stop requested for ${runId} (flag set); lease held by ${acquired.lease.holder_id} — the driver will honor it at the next step boundary`,
    );
    return 0;
  }
  try {
    store.append("operator_decision", { operator: operatorIdentity(), decision: "stop" });
  } finally {
    try {
      store.lease.release(holderId);
    } catch {
      // best effort
    }
  }
  console.log(`miah stop: stop requested for ${runId} (operator_decision: stop journaled)`);
  return 0;
}
