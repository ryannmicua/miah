/**
 * Kill drill v2 (dispatch level, R37-R38, U5).
 *
 * A child process journals a dispatch intent (mode "intent-only") or an intent
 * plus its created event (mode "intent+created") through the real RunStore and
 * is then force-killed. The parent takes the stale lease, replays, and runs
 * reconciliation exactly as a resumer would:
 *
 *   - intent-only:     the adapter is queried, no handle is found, and a
 *                      `dispatch_failed` is appended — the unit routes to rework.
 *   - intent+created:  the handle is found by recorded identity, its lifecycle
 *                      is read from the adapter, and the result envelope is
 *                      harvested (or polling would resume, covered in
 *                      test/dispatch.test.ts).
 */
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { readJournalFile } from "../src/journal";
import { resolveRunLayout, RunStore } from "../src/run-store";
import { reconcileIntents } from "../src/dispatch";
import { deriveState } from "../src/replay";
import { writeEnvelope } from "../src/envelope";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { ScriptedAdapter } from "./helpers/scripted-adapter";

const VITE_NODE_ENTRY = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "vite-node",
  "vite-node.mjs",
);
const CHILD_SCRIPT = path.resolve(__dirname, "helpers", "kill-drill-v2-child.ts");

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
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function waitForStaleLease(
  leasePath: string,
  ttlS: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(leasePath, "utf8");
      const lease = JSON.parse(raw) as { last_heartbeat_at?: number; released?: boolean };
      if (lease.released === true) {
        return;
      }
      if (
        typeof lease.last_heartbeat_at === "number" &&
        Date.now() - lease.last_heartbeat_at > ttlS * 1000
      ) {
        return;
      }
    } catch {
      // lease.lock not readable yet; keep polling
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for stale lease at ${leasePath}`);
}

const RUN_ID = "run-drill-v2-20260806T000000";
const FUTURE_DEADLINE = new Date(Date.now() + 3_600_000).toISOString();

interface DrillScenario {
  basePath: string;
  runId: string;
  config: unknown;
  holderId: string;
  mode: "intent-only" | "intent+created" | "terminated-success";
  intent: Record<string, unknown>;
  created?: Record<string, unknown>;
  terminated?: Record<string, unknown>;
}

function spawnDrillChild(basePath: string, scenario: DrillScenario): { child: ChildProcess; marker: string } {
  const scenarioPath = path.join(basePath, "scenario.json");
  const markerPath = path.join(basePath, "marker");
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");

  const logPath = path.join(basePath, "child.log");
  const logFd = fs.openSync(logPath, "w");
  const child = spawn(
    process.execPath,
    [VITE_NODE_ENTRY, CHILD_SCRIPT, scenarioPath, markerPath],
    { stdio: ["ignore", "ignore", logFd] },
  );
  fs.closeSync(logFd);
  return { child, marker: markerPath };
}

afterEach(cleanupTempDirs);

describe("kill-drill v2", () => {
  it(
    "kill after dispatch_intent before dispatch_created → resume → adapter queried → no handle → dispatch_failed → rework (R37)",
    async () => {
      const basePath = makeTempDir("miah-kd2-");
      const config = fastConfig({ lease: { heartbeat_interval_s: 0.5, ttl_s: 1 } });
      const scenario: DrillScenario = {
        basePath,
        runId: RUN_ID,
        config,
        holderId: "drill-holder",
        mode: "intent-only",
        intent: {
          sender_role: "miah",
          role: "builder",
          unit_id: "U1",
          take: 1,
          idempotency_key: "dispatch-builder-U1-t1",
          packet_hash: "a".repeat(64),
          deadline: FUTURE_DEADLINE,
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
        },
      };

      const { child, marker } = spawnDrillChild(basePath, scenario);
      await waitForFile(marker, 30_000);
      // Kill while Miah is "alive" but before the adapter call is recorded.
      if (child.exitCode === null) {
        process.kill(child.pid);
      }
      await waitForExit(child, 10_000);

      // The child committed exactly the intent (lease_acquired + dispatch_intent).
      const layout = resolveRunLayout(basePath, RUN_ID);
      const beforeResume = readJournalFile(layout.journalPath);
      const childTypes = beforeResume.events
        .filter((e) => e.type !== "lease_acquired" && e.type !== "lease_renewed")
        .map((e) => e.type);
      expect(childTypes).toEqual(["dispatch_intent"]);

      await waitForStaleLease(layout.leasePath, config.lease.ttl_s, 15_000);

      const resumed = new RunStore({ basePath, runId: RUN_ID, config, holderId: "resumer" });
      const takeover = resumed.lease.acquire("resumer");
      expect(takeover.ok).toBe(true);
      if (takeover.ok) {
        expect(takeover.reason).toBe("stale-takeover");
      }
      resumed.replay();

      // Resume = replay-then-reconcile (R38). The adapter is queried (via the
      // resolver seam); no handle exists for the intent.
      const adapter = new ScriptedAdapter();
      const results = await reconcileIntents({
        store: resumed,
        adapter,
        repoRoot: basePath,
        now: Date.now,
        handleResolver: async () => null,
      });

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.outcome).toBe("no-handle");
      expect(result.failedEvent).not.toBeNull();
      expect(String(result.failedEvent?.reason)).toContain("no handle");

      // Journal: intent → reconcile_record → dispatch_failed. No created.
      const events = readJournalFile(layout.journalPath).events;
      const types = events.map((e) => e.type);
      expect(types).toContain("dispatch_intent");
      expect(types).toContain("reconcile_record");
      expect(types).toContain("dispatch_failed");
      expect(types).not.toContain("dispatch_created");
      expect(types).not.toContain("dispatch_terminated");
      const reconcileSeq = events.find((e) => e.type === "reconcile_record")?.seq ?? -1;
      const failedSeq = events.find((e) => e.type === "dispatch_failed")?.seq ?? -1;
      expect(reconcileSeq).toBeGreaterThan(0);
      expect(failedSeq).toBeGreaterThan(reconcileSeq);

      // The unit is routed to rework: no in-flight intent remains.
      const state = resumed.stateSnapshot();
      expect(state.in_flight_intents).toHaveLength(0);
      expect(state.units.U1.status).toBe("not_started");
    },
    60_000,
  );

  it(
    "kill after dispatch_created before dispatch_terminated → resume → handle found → status checked → harvest",
    async () => {
      const basePath = makeTempDir("miah-kd2-");
      const config = fastConfig({ lease: { heartbeat_interval_s: 0.5, ttl_s: 1 } });
      const scenario: DrillScenario = {
        basePath,
        runId: RUN_ID,
        config,
        holderId: "drill-holder",
        mode: "intent+created",
        intent: {
          sender_role: "miah",
          role: "builder",
          unit_id: "U1",
          take: 1,
          idempotency_key: "dispatch-builder-U1-t1",
          packet_hash: "a".repeat(64),
          deadline: FUTURE_DEADLINE,
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
        },
        created: {
          unit_id: "U1",
          agent_id: "agent-drill-2",
          workspace_id: "wks-drill-2",
          base_commit: "commit-before-death",
        },
      };

      const { child, marker } = spawnDrillChild(basePath, scenario);
      await waitForFile(marker, 30_000);
      if (child.exitCode === null) {
        process.kill(child.pid);
      }
      await waitForExit(child, 10_000);

      // The specialist had written its result envelope before Miah died.
      const worktree = makeTempDir();
      writeEnvelope(path.join(worktree, ".miah", "envelope-builder-U1-t1.json"), {
        schema_version: 1,
        producer_role: "builder",
        attempt_id: "dispatch-builder-U1-t1",
        take: 1,
        unit_id: "U1",
        self_claim: "Harvested on resume.",
        produced_files: [{ path: "src/hello.ts", sha256: "b".repeat(64) }],
        wall_clock_estimate_s: 5,
      });

      const layout = resolveRunLayout(basePath, RUN_ID);
      const beforeResume = readJournalFile(layout.journalPath);
      const childTypes = beforeResume.events
        .filter((e) => e.type !== "lease_acquired" && e.type !== "lease_renewed")
        .map((e) => e.type);
      expect(childTypes).toEqual(["dispatch_intent", "dispatch_created"]);

      await waitForStaleLease(layout.leasePath, config.lease.ttl_s, 15_000);

      const resumed = new RunStore({ basePath, runId: RUN_ID, config, holderId: "resumer" });
      const takeover = resumed.lease.acquire("resumer");
      expect(takeover.ok).toBe(true);
      resumed.replay();

      // The created identity is recorded, so the handle is found by identity
      // and the adapter's lifecycle is read on resume (R37: status checked).
      const adapter = new ScriptedAdapter();
      adapter.inspectFor = () => ({
        agentId: "agent-drill-2",
        lifecycle: "idle",
        provider: "opencode",
        model: "opencode-go/deepseek-v4-flash",
        mode: "default",
        cwd: worktree,
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
        capabilities: {},
      });

      const results = await reconcileIntents({
        store: resumed,
        adapter,
        repoRoot: basePath,
        now: Date.now,
        gitReader: () => "commit-on-resume",
      });

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.outcome).toBe("handle-found");
      expect(result.status).toBe("idle");
      // Already-created identity: reconciliation does not re-journal created.
      expect(result.createdEvent).toBeNull();
      expect(result.terminatedEvent?.outcome).toBe("success");
      expect(result.handle?.cwd).toBe(worktree);

      const events = readJournalFile(layout.journalPath).events;
      const types = events.map((e) => e.type);
      const createdCount = types.filter((t) => t === "dispatch_created").length;
      expect(createdCount).toBe(1);
      expect(types).toContain("reconcile_record");
      expect(types).toContain("result_envelope_observed");
      expect(types).toContain("dispatch_terminated");
      expect(types).not.toContain("dispatch_failed");

      const terminated = events.find((e) => e.type === "dispatch_terminated");
      expect(terminated).toMatchObject({ unit_id: "U1", outcome: "success" });
      expect(resumed.stateSnapshot().in_flight_intents).toHaveLength(0);
    },
    60_000,
  );

  it(
    "kill after successful builder dispatch_terminated → resume → candidate preserved → resumes at verification, no second builder dispatch (U2.AC4, KTD5)",
    async () => {
      const basePath = makeTempDir("miah-kd2-");
      const config = fastConfig({ lease: { heartbeat_interval_s: 0.5, ttl_s: 1 } });
      const scenario: DrillScenario = {
        basePath,
        runId: RUN_ID,
        config,
        holderId: "drill-holder",
        mode: "terminated-success",
        intent: {
          sender_role: "miah",
          role: "builder",
          unit_id: "U1",
          take: 1,
          idempotency_key: "dispatch-builder-U1-t1",
          packet_hash: "a".repeat(64),
          deadline: FUTURE_DEADLINE,
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
        },
        created: {
          unit_id: "U1",
          agent_id: "agent-drill-3",
          workspace_id: "wks-drill-3",
          base_commit: "commit-frozen",
        },
        terminated: {
          unit_id: "U1",
          outcome: "success",
          idempotency_key: "dispatch-builder-U1-t1",
        },
      };

      const { child, marker } = spawnDrillChild(basePath, scenario);
      await waitForFile(marker, 30_000);
      if (child.exitCode === null) {
        process.kill(child.pid);
      }
      await waitForExit(child, 10_000);

      const layout = resolveRunLayout(basePath, RUN_ID);
      const beforeResume = readJournalFile(layout.journalPath);
      const childTypes = beforeResume.events
        .filter((e) => e.type !== "lease_acquired" && e.type !== "lease_renewed")
        .map((e) => e.type);
      expect(childTypes).toEqual(["dispatch_intent", "dispatch_created", "dispatch_terminated"]);

      await waitForStaleLease(layout.leasePath, config.lease.ttl_s, 15_000);

      const resumed = new RunStore({ basePath, runId: RUN_ID, config, holderId: "resumer" });
      const takeover = resumed.lease.acquire("resumer");
      expect(takeover.ok).toBe(true);
      const { state } = resumed.replay();

      // The replay alone (no reconciliation, no dispatch) must resume at the
      // awaiting-verification boundary: the frozen builder candidate is
      // preserved with its observed identity, and there is no in-flight
      // builder intent to re-dispatch.
      expect(state.in_flight_intents).toHaveLength(0);
      expect(state.units.U1.status).toBe("awaiting_verification");
      expect(state.awaiting_verification.U1).toMatchObject({
        take: 1,
        attempt: "dispatch-builder-U1-t1",
        agent_id: "agent-drill-3",
        workspace_id: "wks-drill-3",
        base_commit: "commit-frozen",
        envelope_path: ".miah/envelope-builder-U1-t1.json",
      });

      // Snapshot-plus-tail replay is byte-identical to the full replay.
      const full = deriveState(readJournalFile(layout.journalPath).events);
      expect(JSON.stringify(state)).toBe(JSON.stringify(full));
    },
    60_000,
  );
});
