/**
 * `miah reject <run-id> [--rework <unit-ids>|--end]` command (R67, F15).
 *
 * Rejects the run at (or toward) the final approval gate. Journals
 * `operator_decision: reject` (R69). With `--rework <unit-ids>` the named
 * units are marked for re-dispatch (`rework_started`) without terminating the
 * run; with `--end` the run terminates via `run_terminal: rejected`. The two
 * are mutually exclusive, and a unit list is validated against the run's
 * `units.json` view before any event is appended.
 */
import { loadConfig, resolveConfigBasePath } from "../config";
import { readManifest } from "../manifest";
import { resolveRunLayout, RunStore } from "../run-store";
import { readUnitsFromStore } from "../step";
import type { Config, UnitId } from "../types";
import { operatorIdentity } from "./stop";

/** Exit code when the rejection cannot be recorded. */
export const REJECT_ERROR_EXIT_CODE = 1;

export interface RejectRequest {
  /** Unit ids to route back to rework (`--rework`). Empty when not given. */
  rework?: UnitId[];
  /** End the run without completion approval (`--end`). */
  end?: boolean;
}

export interface RejectOptions {
  config?: Config;
  basePath?: string;
  holderId?: string;
}

/**
 * Run `miah reject` for a run id. Returns the process exit code: 0 on success,
 * non-zero on invalid flags, unknown units, an already-terminal run, a missing
 * run, or a lease held by a live driver.
 */
export async function runReject(
  runId: string,
  request: RejectRequest,
  opts: RejectOptions = {},
): Promise<number> {
  const rework = request.rework ?? [];
  const end = request.end ?? false;
  if (rework.length > 0 && end) {
    console.error("miah reject: --rework and --end are mutually exclusive");
    return REJECT_ERROR_EXIT_CODE;
  }
  if (rework.length === 0 && !end) {
    console.error("miah reject: specify --rework <unit-ids> or --end");
    return REJECT_ERROR_EXIT_CODE;
  }

  const basePath = opts.basePath ?? resolveConfigBasePath();
  const layout = resolveRunLayout(basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    console.error(`miah reject: no run found for ${runId}`);
    return REJECT_ERROR_EXIT_CODE;
  }
  const config = opts.config ?? loadConfig();
  const holderId = opts.holderId ?? `miah-op-${process.pid}`;
  const store = new RunStore({ basePath, runId, config, holderId });
  const acquired = store.lease.acquire(holderId);
  if (!acquired.ok) {
    console.error(
      `miah reject: lease held by ${acquired.lease.holder_id} (fresh heartbeat); cannot reject while a driver is active`,
    );
    return REJECT_ERROR_EXIT_CODE;
  }
  try {
    const state = store.replay().state;
    if (state.terminal !== null) {
      console.error(`miah reject: run is already terminal (${state.terminal})`);
      return REJECT_ERROR_EXIT_CODE;
    }
    const units = readUnitsFromStore(store) ?? {};
    for (const id of rework) {
      if (units[id] === undefined) {
        console.error(`miah reject: unit ${id} is not in the run's plan`);
        return REJECT_ERROR_EXIT_CODE;
      }
    }

    store.append("operator_decision", {
      operator: operatorIdentity(),
      decision: "reject",
      rework_units: rework.length > 0 ? rework : null,
      end: end ? true : null,
    });
    for (const id of rework) {
      store.append("rework_started", { unit_id: id, via: "operator-reject" });
    }
    if (end) {
      store.append("run_terminal", { status: "rejected" });
    }

    if (end) {
      console.log(`miah reject: run ${runId} rejected (run_terminal: rejected)`);
    } else {
      console.log(
        `miah reject: run ${runId} rejected — ${rework.join(", ")} marked for re-dispatch`,
      );
    }
    return 0;
  } finally {
    try {
      store.lease.release(holderId);
    } catch {
      // best effort
    }
  }
}
