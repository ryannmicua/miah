/**
 * Kill drill v1 (journal + lease level, U3.3, A2, D1's central claim).
 *
 * A child process appends journal events through the real RunStore/Journal/Lease
 * code, is killed mid-append with `process.kill()`, and the parent resumes:
 * stale-takeover of the lease, replay from the latest snapshot plus the tail,
 * and a byte-identical reconstructed state with no lost or duplicate events.
 *
 * The kill lands mid-write of a multi-MB event (phase B), so a crash-truncated
 * trailing line is expected; replay must repair it and restore the last
 * complete event. The scenario also deterministically lands a state snapshot at
 * seq 50 during phase A, so the drill exercises the snapshot-plus-tail path.
 */
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { deriveState } from "../src/replay";
import { readJournalFile } from "../src/journal";
import { resolveRunLayout, RunStore } from "../src/run-store";
import { cleanupTempDirs, makeTempDir, buildScenarioEvents, fastConfig } from "./helpers";

const VITE_NODE_ENTRY = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "vite-node",
  "vite-node.mjs",
);
const CHILD_SCRIPT = path.resolve(__dirname, "helpers", "kill-drill-child.ts");

const SCENARIO_SIZE = 70;
const PHASE_A_SIZE = 60; // deterministic slow appends; snapshot lands at seq 50

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(timeoutMs),
  ]);
  if (child.exitCode === null) {
    // Force-terminate a stuck child so the test never hangs.
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function waitForStaleLease(leasePath: string, ttlS: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(leasePath, "utf8");
      const lease = JSON.parse(raw) as { last_heartbeat_at?: number; released?: boolean };
      if (lease.released === true) {
        return;
      }
      if (typeof lease.last_heartbeat_at === "number" && Date.now() - lease.last_heartbeat_at > ttlS * 1000) {
        return;
      }
    } catch {
      // lease.lock not readable yet; keep polling
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for stale lease at ${leasePath}`);
}

/** Recursively find stray temp files (lease/snapshot/repair) in a run store. */
function listStrayTempFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tmp$|\.repair-/.test(entry.name) || entry.name.startsWith(".state-")) {
        found.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return found;
}

afterEach(cleanupTempDirs);

describe("kill-drill", () => {
  it(
    "v1: kill mid-append → resume → byte-identical reconstructed state (no lost/duplicate events)",
    async () => {
      const basePath = makeTempDir();
      const runId = "run-drill-20260806T000000";
      // heartbeat interval < TTL so the child's own heartbeats always keep the
      // lease fresh while it is alive, and staleness is reached quickly after
      // the kill.
      const config = fastConfig({ lease: { heartbeat_interval_s: 0.5, ttl_s: 1 } });
      const scenario = buildScenarioEvents(SCENARIO_SIZE);
      const scenarioPath = path.join(basePath, "scenario.json");
      const markerPath = path.join(basePath, "marker");

      fs.writeFileSync(
        scenarioPath,
        JSON.stringify({
          basePath,
          runId,
          config,
          holderId: "drill-holder",
          phaseASize: PHASE_A_SIZE,
          events: scenario,
        }),
        "utf8",
      );

      // Spawn the writer child (real RunStore/Journal/Lease via vite-node).
      // stdio is redirected to files (never pipes): a killed child's pipe
      // handles were destabilizing the vitest worker on Windows. The child's
      // stdout/stderr go to a log file for post-mortem debugging.
      const logPath = path.join(basePath, "child.log");
      const logFd = fs.openSync(logPath, "w");
      const child = spawn(
        process.execPath,
        [VITE_NODE_ENTRY, CHILD_SCRIPT, scenarioPath, markerPath],
        { stdio: ["ignore", "ignore", logFd] },
      );
      fs.closeSync(logFd);

      // Phase A (60 events, snapshot at seq 50) completes and signals readiness.
      await waitForFile(markerPath, 30_000);
      // Kill while phase B's first multi-MB append is in flight.
      await sleep(40);
      if (child.exitCode === null) {
        process.kill(child.pid);
      }
      await waitForExit(child, 10_000);

      // A resumer may take the lease only once the dead holder is stale.
      const layout = resolveRunLayout(basePath, runId);
      await waitForStaleLease(layout.leasePath, config.lease.ttl_s, 15_000);

      // The child's durable prefix is whatever survived the kill, possibly with
      // a crash-truncated trailing line (kill mid-append).
      const preResume = readJournalFile(layout.journalPath);
      const hadPartialTail = preResume.truncated;
      const completeBeforeResume = preResume.events.length;
      let injectedTail = false;
      if (!hadPartialTail) {
        // The kill can land between appends on some machines (OS scheduling),
        // leaving no partial line. A killed append CAN leave a crash-truncated
        // trailing line, so deterministically simulate that exact state to
        // exercise the mid-append repair path: resume replay must truncate it
        // and restore the last complete event.
        fs.appendFileSync(
          layout.journalPath,
          `{"seq":${completeBeforeResume + 1},"type":"dispatch_intent","timestamp":0,"unit_id":"U`,
          "utf8",
        );
        injectedTail = true;
        expect(readJournalFile(layout.journalPath).truncated).toBe(true);
      }

      const resumed = new RunStore({ basePath, runId, config, holderId: "resumer" });
      expect(resumed.lease.read()?.holder_id).toBe("drill-holder"); // current holder read on resume
      const takeover = resumed.lease.acquire("resumer");
      expect(takeover.ok).toBe(true);
      if (takeover.ok) {
        expect(takeover.reason).toBe("stale-takeover"); // never a fresh-heartbeat steal
      }

      const replay = resumed.replay(); // repairs the crash-truncated tail, replays snapshot + tail
      const events = readJournalFile(layout.journalPath).events;

      // No lost or duplicate events: complete seqs are exactly [1..N].
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(events[0].type).toBe("lease_acquired");
      const N = events.length;
      // The child's committed prefix survived intact; the resumer's stale
      // takeover appended one more lease_acquired event.
      expect(N).toBe(completeBeforeResume + 1);
      expect(N).toBeGreaterThanOrEqual(PHASE_A_SIZE + 1); // at least phase A committed
      expect(N).toBeLessThanOrEqual(SCENARIO_SIZE + 2);
      // The scenario events survive in order, unfragmented by the kill
      // (lease bookkeeping events are the only interleaving).
      const scenarioTypes = events
        .filter((e) => e.type !== "lease_acquired" && e.type !== "lease_renewed")
        .map((e) => e.type);
      expect(scenarioTypes).toEqual(scenario.slice(0, scenarioTypes.length).map((s) => s.type));

      // Snapshot + tail replay is byte-identical to a full replay (R42).
      const full = deriveState(events);
      expect(JSON.stringify(replay.state)).toBe(JSON.stringify(full));
      expect(replay.state.seq).toBe(N);

      // The deterministic phase-A snapshot exists; the latest snapshot anchors
      // the replay (50, or 100 if the kill landed later in phase B).
      expect(fs.existsSync(path.join(layout.snapshotsDir, "state-50.json"))).toBe(true);
      expect(replay.snapshotSeq).not.toBeNull();
      expect(replay.snapshotSeq).toBeGreaterThanOrEqual(50);
      expect(replay.snapshotSeq).toBeLessThanOrEqual(N);

      // The crash-truncated tail is gone after resume repair.
      expect(readJournalFile(layout.journalPath).truncated).toBe(false);

      // Temp hygiene: killed acquire/heartbeat/snapshot writes leave no temps.
      expect(listStrayTempFiles(layout.root)).toEqual([]);

      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim() : "";
      console.log(
        `[kill-drill v1] N=${N} committed events, hadPartialTail=${hadPartialTail}, ` +
          `injectedTail=${injectedTail}, snapshotSeq=${replay.snapshotSeq}, ` +
          `takeover=${takeover.ok ? takeover.reason : "failed"}` +
          (log ? `, childLog="${log.slice(0, 200)}"` : ""),
      );
    },
    60_000,
  );
});
