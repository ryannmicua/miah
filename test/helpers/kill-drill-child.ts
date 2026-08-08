/**
 * Kill-drill v1 child process.
 *
 * A real RunStore writer that appends journal events until the parent kills it
 * mid-append. Run as a separate process (via vite-node so it can import the
 * real TS source) so the parent's `process.kill()` interrupts a live append.
 *
 * Usage: node node_modules/vite-node/vite-node.mjs test/helpers/kill-drill-child.ts
 *            <scenario.json> <ready-marker>
 *
 * Protocol:
 *   - Phase A: append the first `phaseASize` scenario events slowly, so a
 *     state snapshot deterministically lands at K=50 before the kill.
 *   - Write the ready marker.
 *   - Phase B: append the rest in a tight loop, each payload padded with a
 *     multi-MB blob so the kill lands mid-write of some event. The blob is a
 *     raw payload field that derived state never reads (R41: raw data is not
 *     load-bearing for reconstruction).
 */
import * as fs from "fs";
import { RunStore } from "../../src/run-store";
import { Config } from "../../src/types";

interface Scenario {
  basePath: string;
  runId: string;
  config: Config;
  holderId: string;
  phaseASize: number;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function main(): void {
  const scenarioPath = process.argv[2];
  const markerPath = process.argv[3];
  if (!scenarioPath || !markerPath) {
    process.stderr.write("kill-drill-child: missing scenario or marker argument\n");
    process.exit(2);
  }
  let scenario: Scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as Scenario;
  } catch (error) {
    process.stderr.write(`kill-drill-child: cannot read scenario: ${String(error)}\n`);
    process.exit(2);
  }

  const store = new RunStore({
    basePath: scenario.basePath,
    runId: scenario.runId,
    config: scenario.config,
    holderId: scenario.holderId,
  });

  const acquired = store.lease.acquire(scenario.holderId);
  if (!acquired.ok) {
    process.stderr.write(`kill-drill-child: acquire failed: ${acquired.reason}\n`);
    process.exit(3);
  }

  const phaseASize = Math.min(scenario.phaseASize, scenario.events.length);

  void appendPhaseA(store, scenario, phaseASize).then(() => {
    fs.writeFileSync(markerPath, "ready", "utf8");
    // Phase B: append until killed. Each event is padded with a multi-MB blob
    // so a `process.kill()` from the parent reliably lands mid-write of some
    // event, leaving a crash-truncated trailing line for resume to repair.
    const blob = "x".repeat(16 * 1024 * 1024);
    for (let i = phaseASize; i < scenario.events.length; i++) {
      store.lease.maybeHeartbeat(scenario.holderId);
      const s = scenario.events[i];
      store.append(s.type, { ...s.payload, kill_drill_blob: blob });
    }
    process.exit(0);
  });
}

async function appendPhaseA(
  store: RunStore,
  scenario: Scenario,
  size: number,
): Promise<void> {
  for (let i = 0; i < size; i++) {
    store.lease.maybeHeartbeat(scenario.holderId);
    const s = scenario.events[i];
    store.append(s.type, s.payload);
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
