/**
 * `miah amend <run-id> <new-plan>` command (R68, F16, D6-f, KTD16).
 *
 * Applies a change order to a running run:
 *
 *   1. run preflight on the new plan (R68; a plan that fails preflight or is
 *      not `execution: code` is refused before anything is written)
 *   2. create a new snapshot version (`plan-snapshot.v<version>.md`); the
 *      original snapshot is never mutated (KTD16)
 *   3. diff the new `units.json` against the current one and identify affected
 *      units — those whose `creates:`/`inputs:`/`depends-on` changed plus
 *      every unit that transitively depends on them (R68, D6-f)
 *   4. pause in-flight affected units first (adapter stop + `dispatch_terminated:
 *      amended`; R68)
 *   5. append `amendment_applied` with the new hash and the affected-unit list
 *   6. mark affected units for re-dispatch: accepted units go back to rework
 *      (`rework_started`), in-flight units were already closed above
 *
 * All operator actions are journaled with identity, timestamp, and decision
 * (R69): an `operator_decision: amend` event precedes `amendment_applied`.
 */
import * as fs from "fs";
import { PaseoCliAdapter, type PaseoAdapter } from "../adapter/paseo";
import { loadConfig, resolveConfigBasePath } from "../config";
import { ensurePhase } from "../fsm";
import { readManifest } from "../manifest";
import { parsePlan } from "../parser";
import { preflightPlan } from "../preflight";
import { resolveRunLayout, RunStore } from "../run-store";
import { writeSnapshot } from "../snapshot";
import { readUnitsFromStore } from "../step";
import type { Config, PlanUnit, UnitId } from "../types";
import { collectWorkspacePaths } from "./preflight";
import { currentSnapshotHash, findLatestPlanSnapshot } from "./status";
import { operatorIdentity } from "./stop";

/** Exit code when the amendment cannot be applied. */
export const AMEND_ERROR_EXIT_CODE = 1;

export interface AmendOptions {
  config?: Config;
  basePath?: string;
  holderId?: string;
  /** Pauses in-flight affected units via the adapter (R68). */
  adapter?: PaseoAdapter;
  /** Workspace root for the new plan's preflight (R55). Defaults to cwd. */
  workspaceRoot?: string;
  now?: () => number;
}

/** Order-insensitive path-list equality for the `creates:`/`inputs:`/`depends-on` diff. */
function pathListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Units whose `creates:`/`inputs:`/`depends-on` changed between two units.json
 * views (R68, D6-f). Added and removed units count as changed.
 */
export function diffUnits(
  oldUnits: Record<UnitId, PlanUnit>,
  newUnits: Record<UnitId, PlanUnit>,
): UnitId[] {
  const ids = new Set<UnitId>([...Object.keys(oldUnits), ...Object.keys(newUnits)]);
  const changed: UnitId[] = [];
  for (const id of ids) {
    const oldUnit = oldUnits[id];
    const newUnit = newUnits[id];
    if (oldUnit === undefined || newUnit === undefined) {
      changed.push(id);
      continue;
    }
    if (
      !pathListsEqual(oldUnit.creates ?? [], newUnit.creates ?? []) ||
      !pathListsEqual(oldUnit.inputs ?? [], newUnit.inputs ?? []) ||
      !pathListsEqual(oldUnit.dependsOn ?? [], newUnit.dependsOn ?? [])
    ) {
      changed.push(id);
    }
  }
  return changed.sort();
}

/**
 * The changed units plus every unit that transitively depends on them in the
 * new plan's dependency graph (R68, D6-f). Computed by walking the new
 * `depends-on` edges from each changed unit.
 */
export function affectedUnits(changed: UnitId[], units: Record<UnitId, PlanUnit>): UnitId[] {
  const affected = new Set<UnitId>(changed);
  const stack = [...changed];
  while (stack.length > 0) {
    const current = stack.pop() as UnitId;
    for (const unit of Object.values(units)) {
      if ((unit.dependsOn ?? []).includes(current) && !affected.has(unit.id)) {
        affected.add(unit.id);
        stack.push(unit.id);
      }
    }
  }
  return [...affected].sort();
}

/**
 * Run `miah amend` for a run id and a new plan file path. Returns the process
 * exit code: 0 on success, non-zero when the new plan fails preflight, the run
 * does not exist, or the lease is held by a live driver.
 */
export async function runAmend(
  runId: string,
  newPlanPath: string,
  opts: AmendOptions = {},
): Promise<number> {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const layout = resolveRunLayout(basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    console.error(`miah amend: no run found for ${runId}`);
    return AMEND_ERROR_EXIT_CODE;
  }
  let newPlanText: string;
  try {
    newPlanText = fs.readFileSync(newPlanPath, "utf8");
  } catch {
    console.error(`miah amend: cannot read plan file: ${newPlanPath}`);
    return AMEND_ERROR_EXIT_CODE;
  }

  // Preflight the new plan (R68, U9 approach). Unaffected units are unchanged
  // from the admitted plan, so a passing full preflight is equivalent in
  // practice to the D6-f scoped preflight (only the changed units can newly
  // fail).
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const verdict = preflightPlan(newPlanText, collectWorkspacePaths(workspaceRoot));
  if (!verdict.ok) {
    console.error("miah amend: new plan fails preflight (R68):");
    for (const finding of verdict.failures) {
      console.error(`  [${finding.unitId}] (${finding.code}): ${finding.message}`);
    }
    return AMEND_ERROR_EXIT_CODE;
  }
  if (verdict.execution !== "code") {
    console.error(
      `miah amend: new plan execution must be "code" (got "${verdict.execution ?? "absent"}")`,
    );
    return AMEND_ERROR_EXIT_CODE;
  }

  const config = opts.config ?? loadConfig();
  const holderId = opts.holderId ?? `miah-op-${process.pid}`;
  const store = new RunStore({ basePath, runId, config, holderId, now: opts.now });
  const acquired = store.lease.acquire(holderId);
  if (!acquired.ok) {
    console.error(
      `miah amend: lease held by ${acquired.lease.holder_id} (fresh heartbeat); cannot amend while a driver is active`,
    );
    return AMEND_ERROR_EXIT_CODE;
  }

  try {
    const oldUnits = readUnitsFromStore(store) ?? {};
    const newPlan = parsePlan(newPlanText);
    const newUnits = newPlan.units;
    const changed = diffUnits(oldUnits, newUnits);
    const affected = affectedUnits(changed, newUnits);

    // Pause in-flight affected units first (R68, D6-f, AE25).
    const adapter = opts.adapter ?? new PaseoCliAdapter();
    const state = store.replay().state;
    for (const intent of state.in_flight_intents) {
      if (!affected.includes(intent.unit_id)) {
        continue;
      }
      if (intent.agent_id !== null && intent.agent_id !== "") {
        try {
          await adapter.stop({
            agentId: intent.agent_id,
            cwd: null,
            workspaceId: intent.workspace_id,
          });
        } catch {
          // best-effort terminate (R5): the agent may already be terminal.
        }
      }
      store.append("dispatch_terminated", {
        unit_id: intent.unit_id,
        outcome: "amended",
        idempotency_key: intent.idempotency_key,
      });
    }

    // New snapshot version; the original snapshot is never mutated (R68,
    // KTD16).
    const previous = findLatestPlanSnapshot(layout);
    const version = (previous?.version ?? 1) + 1;
    const snapshot = writeSnapshot(newPlanText, layout.root, `plan-snapshot.v${version}.md`);
    const previousSnapshotHash =
      previous !== null ? currentSnapshotHash(previous.filePath) : null;
    const previousHash = previousSnapshotHash !== null ? previousSnapshotHash : manifest.plan_hash;

    // The parsed-once machine view (R24) follows the new plan.
    fs.writeFileSync(layout.unitsJsonPath, `${JSON.stringify(newUnits, null, 2)}\n`, "utf8");

    // Journal the amendment: operator decision (R69) + amendment_applied with
    // the new hash and the affected-unit list (R68).
    store.append("operator_decision", {
      operator: operatorIdentity(),
      decision: "amend",
      version,
    });
    store.append("amendment_applied", {
      new_hash: snapshot.hash,
      previous_hash: previousHash,
      version,
      changed_units: changed,
      affected_units: affected,
      operator: operatorIdentity(),
    });

    // Mark affected units for re-dispatch (R68): accepted units go back to
    // rework; in-flight units were closed above (now not_started, eligible
    // again).
    const statusesBefore = new Map<UnitId, string>();
    for (const id of affected) {
      statusesBefore.set(id, store.stateSnapshot().units[id]?.status ?? "not_started");
    }
    for (const id of affected) {
      if (statusesBefore.get(id) === "accepted") {
        store.append("rework_started", { unit_id: id, via: "amendment" });
      }
    }

    // Resume a paused (Attention) run after the amendment (R66 resume path).
    if (store.stateSnapshot().phase === "Attention") {
      ensurePhase(store, "Ready");
    }

    console.log(
      `miah amend: amendment applied to ${runId} (snapshot v${version}, hash ${snapshot.hash.slice(
        0,
        12,
      )}, affected: ${affected.join(", ") || "none"})`,
    );
    return 0;
  } finally {
    try {
      store.lease.release(holderId);
    } catch {
      // best effort
    }
  }
}
