/**
 * Shared test helpers for U3 (not a vitest test file).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config, DEFAULT_CONFIG, JournalEvent, PlanUnit, UnitId } from "../src/types";
import { resolveRunLayout, RunStore, RunStoreLayout } from "../src/run-store";

/** Mutable fake clock for lease TTL / heartbeat tests. */
export interface Clock {
  now: number;
  fn: () => number;
}

export function makeClock(initial = 1_000_000): Clock {
  const clock: Clock = { now: initial, fn: () => clock.now };
  return clock;
}

/** A small-timing Config so lease TTL / heartbeat tests run in ms, not 60s. */
export function fastConfig(overrides: Partial<Config> = {}): Config {
  const journal = overrides.journal ?? {};
  const lease = overrides.lease ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    journal: { snapshot_cadence: 50, ...journal },
    lease: { heartbeat_interval_s: 1, ttl_s: 2, ...lease },
    dispatch: { ...DEFAULT_CONFIG.dispatch, ...(overrides.dispatch ?? {}) },
    run: { ...DEFAULT_CONFIG.run, ...(overrides.run ?? {}) },
    calibration: { ...DEFAULT_CONFIG.calibration, ...(overrides.calibration ?? {}) },
  };
}

const tempDirs: string[] = [];

export function makeTempDir(prefix = "miah-u3-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export interface TestStore {
  basePath: string;
  runId: string;
  layout: RunStoreLayout;
  config: Config;
  clock: Clock;
  store: RunStore;
}

export const TEST_RUN_ID = "run-test-0000000000-000000000000";

/** A RunStore in a temp dir with a fake clock and small lease timing. */
export function createTestStore(
  opts: { config?: Config; holderId?: string; clock?: Clock; runId?: string } = {},
): TestStore {
  const basePath = makeTempDir();
  const runId = opts.runId ?? TEST_RUN_ID;
  const config = opts.config ?? fastConfig();
  const clock = opts.clock ?? makeClock();
  const holderId = opts.holderId ?? "holder-A";
  const store = new RunStore({ basePath, runId, config, holderId, now: clock.fn });
  return { basePath, runId, layout: resolveRunLayout(basePath, runId), config, clock, store };
}

/** Construct a JournalEvent with a fixed timestamp (for pure-state tests). */
export function makeEvent(
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
): JournalEvent {
  return { seq, type, timestamp: 0, ...payload };
}

/** Small units.json dependency graph: U1 root, U2 on U1, U3 on U2. */
export function makeUnits(): Record<UnitId, PlanUnit> {
  return {
    U1: { id: "U1", number: 1, title: "one", goal: null, requirements: null, creates: [], inputs: [], dependsOn: [], acceptance: null },
    U2: { id: "U2", number: 2, title: "two", goal: null, requirements: null, creates: [], inputs: [], dependsOn: ["U1"], acceptance: null },
    U3: { id: "U3", number: 3, title: "three", goal: null, requirements: null, creates: [], inputs: [], dependsOn: ["U2"], acceptance: null },
  };
}

/**
 * A deterministic, varied event stream (run_start, dispatch lifecycle, gaps,
 * acceptance, rework, phases) for replay/snapshot/kill-drill scenarios.
 */
export function buildScenarioEvents(count: number): Array<{ type: string; payload: Record<string, unknown> }> {
  const units = ["U1", "U2", "U3"];
  const phases = ["Implementing", "Reviewing", "AwaitingApproval"];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  events.push({ type: "run_start", payload: { run_id: "scenario-run", plan_hash: "a".repeat(64) } });
  let cycle = 0;
  while (events.length < count) {
    const unit = units[cycle % units.length];
    const take = Math.floor(cycle / units.length) + 1;
    const key = `k-${unit}-${take}`;
    const push = (type: string, payload: Record<string, unknown>): boolean => {
      if (events.length >= count) {
        return false;
      }
      events.push({ type, payload });
      return true;
    };
    if (!push("dispatch_intent", { unit_id: unit, role: "builder", take, idempotency_key: key, packet_hash: `ph-${cycle}`, deadline: `deadline-${cycle}`, provider: "codex", model: "gpt-5.4" })) break;
    if (!push("dispatch_created", { unit_id: unit, agent_id: `agent-${cycle}`, workspace_id: `ws-${cycle}`, base_commit: `bc-${cycle}` })) break;
    if (!push("gap_recorded", { unit_id: unit, criterion: `criterion-${cycle}`, reason: `missing evidence ${cycle}` })) break;
    if (!push("phase_transition", { from: cycle === 0 ? "Admitting" : "Implementing", to: phases[cycle % phases.length] })) break;
    if (!push("gap_closed", { unit_id: unit, criterion: `criterion-${cycle}`, close_reason: "harvested" })) break;
    if (!push("dispatch_terminated", { unit_id: unit, outcome: "success" })) break;
    const accepted = cycle % 5 !== 4;
    if (!push("acceptance_decision", { unit_id: unit, decision: accepted ? "accept" : "not_accepted" })) break;
    if (!accepted) {
      if (!push("rework_started", { unit_id: unit })) break;
    }
    cycle++;
  }
  return events;
}

export { DEFAULT_CONFIG };
