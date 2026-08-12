/**
 * Kill-drill v2 child process.
 *
 * Appends a dispatch intent (and optionally the matching dispatch_created or a
 * successful dispatch_terminated), signals readiness, then stays alive until
 * the parent kills it — simulating Miah dying mid-dispatch:
 *
 *   - mode "intent-only":         Miah died right after `dispatch_intent`,
 *                                 before the adapter call (R37
 *                                 intent-without-created).
 *   - mode "intent+created":      Miah died after `dispatch_created`, before
 *                                 `dispatch_terminated`.
 *   - mode "terminated-success":  Miah died after the builder's successful
 *                                 `dispatch_terminated` — the preserved
 *                                 candidate must resume at verification
 *                                 (KTD5), not with a fresh builder dispatch.
 *
 * Usage: node node_modules/vite-node/vite-node.mjs test/helpers/kill-drill-v2-child.ts
 *            <scenario.json> <ready-marker>
 *
 * The parent then takes the stale lease, replays, and runs reconciliation
 * (R37) exactly as a real resumer would.
 */
import * as fs from "fs";
import { RunStore } from "../../src/run-store";
import { Config } from "../../src/types";

interface Scenario {
  basePath: string;
  runId: string;
  config: Config;
  holderId: string;
  mode: "intent-only" | "intent+created" | "terminated-success";
  intent: Record<string, unknown>;
  created?: Record<string, unknown>;
  terminated?: Record<string, unknown>;
}

function main(): void {
  const scenarioPath = process.argv[2];
  const markerPath = process.argv[3];
  if (!scenarioPath || !markerPath) {
    process.stderr.write("kill-drill-v2-child: missing scenario or marker argument\n");
    process.exit(2);
  }
  let scenario: Scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as Scenario;
  } catch (error) {
    process.stderr.write(`kill-drill-v2-child: cannot read scenario: ${String(error)}\n`);
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
    process.stderr.write(`kill-drill-v2-child: acquire failed: ${acquired.reason}\n`);
    process.exit(3);
  }

  store.append("dispatch_intent", scenario.intent);
  if (scenario.created !== undefined) {
    store.append("dispatch_created", scenario.created);
  }
  if (scenario.mode === "terminated-success" && scenario.terminated !== undefined) {
    store.append("dispatch_terminated", scenario.terminated);
  }

  fs.writeFileSync(markerPath, "ready", "utf8");

  // Stay alive until the parent kills this process (the simulated "Miah died
  // mid-dispatch" window). Heartbeat so the lease stays fresh while alive.
  setInterval(() => {
    try {
      store.lease.maybeHeartbeat(scenario.holderId);
    } catch {
      // best effort; the parent kills us shortly
    }
  }, 250);
}

main();
