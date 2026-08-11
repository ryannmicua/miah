/**
 * `miah stop` command tests (U9.7, R65, F13, D6-c).
 *
 * `miah stop` appends `operator_decision: stop` and sets the run-store
 * `stop-requested` flag. A subsequent `miah run` honors it: the in-flight
 * specialist is terminated via the adapter, `phase_transition: Stopping` is
 * journaled, the lease is released, and the unit is not re-dispatched.
 */
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { runCommand } from "../src/commands/run";
import { runStop } from "../src/commands/stop";
import { readStopRequested } from "../src/driver";
import { readJournalFile } from "../src/journal";
import { RunStore } from "../src/run-store";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { makeFakeProbe } from "./fixtures/fake-substrate-probe";
import { ScriptedAdapter } from "./helpers/scripted-adapter";
import { inspectResult } from "./helpers/step-harness";

const PLAN = [
  "---",
  "title: Stop Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Stop Test Plan",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **Goal:** Create the `src/hello.ts` source module.",
  "- **creates:** `src/hello.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - U1.AC1. `src/hello.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U1.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

interface AdmittedRun {
  basePath: string;
  runId: string;
  holderId: string;
  config: ReturnType<typeof fastConfig>;
}

async function admit(): Promise<AdmittedRun> {
  const basePath = makeTempDir("miah-stop-");
  const config = fastConfig();
  const holderId = "admit-holder";
  const admission = await admitPlan(PLAN, {
    probe: makeFakeProbe(),
    config,
    basePath,
    holderId,
    workspacePaths: [],
  });
  if (!admission.ok || admission.run === null) {
    throw new Error(`admission failed: ${JSON.stringify(admission.failures)}`);
  }
  return { basePath, runId: admission.run.runId, holderId, config };
}

/** Leave U1 in-flight with a live agent id (dispatch created, no terminal). */
function dispatchInFlight(store: RunStore): void {
  store.append("dispatch_intent", {
    unit_id: "U1",
    role: "builder",
    take: 1,
    idempotency_key: "k1",
    packet_hash: "p",
    deadline: "d",
    provider: "p",
    model: "m",
  });
  store.append("dispatch_created", { unit_id: "U1", agent_id: "agent-1", workspace_id: "w1", base_commit: "abc" });
}

function capture(callback: () => number): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  const code = callback();
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("stop command", () => {
  it("appends operator_decision: stop and sets the stop-requested flag (R65)", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    dispatchInFlight(store);
    store.lease.release(run.holderId);

    const { code, stdout } = capture(() =>
      runStop(run.runId, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("stop requested");

    expect(readStopRequested(store.layout)).toBe(true);

    const { events } = readJournalFile(store.layout.journalPath);
    const decision = events.find((e) => e.type === "operator_decision");
    expect(decision).toBeDefined();
    expect(decision).toMatchObject({ decision: "stop" });
    // R69: operator identity, timestamp, and decision are journaled.
    expect(typeof decision?.operator).toBe("string");
    expect((decision?.operator as string).length).toBeGreaterThan(0);
    expect(typeof decision?.timestamp).toBe("number");
  });

  it("a subsequent miah run honors the stop: terminates in-flight, phase Stopping, lease released, no re-dispatch (R65, U9.7)", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    dispatchInFlight(store);
    store.lease.release(run.holderId);
    expect(
      capture(() => runStop(run.runId, { basePath: run.basePath, config: run.config })).code,
    ).toBe(0);

    const adapter = new ScriptedAdapter();
    adapter.statusFor = () => "running";
    adapter.inspectFor = () => inspectResult("agent-1", "running", null);
    const workspaceRoot = makeTempDir("miah-stop-ws-");

    const code = await runCommand(run.runId, {
      adapter,
      basePath: run.basePath,
      holderId: "run-holder",
      config: run.config,
      workspaceRoot,
      canonicalWorktree: workspaceRoot,
    });
    expect(code).toBe(0);

    // In-flight specialist terminated via the adapter.
    expect(adapter.stopCalls.map((handle) => handle.agentId)).toContain("agent-1");
    const { events } = readJournalFile(store.layout.journalPath);
    expect(events.some((e) => e.type === "phase_transition" && e.to === "Stopping")).toBe(true);
    expect(events.some((e) => e.type === "dispatch_terminated" && e.outcome === "stopped")).toBe(
      true,
    );
    // Only the original dispatch_intent exists — no re-dispatch after the stop.
    expect(events.filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U1")).toHaveLength(1);
    // The flag was consumed and the lease released.
    expect(readStopRequested(store.layout)).toBe(false);
    const lease = store.lease.read();
    expect(lease?.released).toBe(true);
  });

  it("returns non-zero when the run does not exist", async () => {
    const { code, stderr } = capture(() =>
      runStop("run-missing", { basePath: makeTempDir("miah-stop-empty-") }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("no run found");
  });

  it("sets the flag even when a live driver holds the lease (honored at the next step boundary)", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    store.lease.release(run.holderId);
    const driverStore = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: "driver-holder",
    });
    expect(driverStore.lease.acquire("driver-holder").ok).toBe(true);

    const { code } = capture(() =>
      runStop(run.runId, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(0);
    // The durable flag is set even though the journal event could not be
    // appended under a live driver's lease.
    expect(readStopRequested(store.layout)).toBe(true);
    const lease = driverStore.lease.read();
    expect(lease?.holder_id).toBe("driver-holder");
  });
});
