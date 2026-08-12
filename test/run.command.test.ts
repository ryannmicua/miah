/**
 * `miah run` command wiring (U8, D6-a/R63): resolve run id, read the
 * admission-time config, drive the driver, map status to exit codes. Uses an
 * admitted run (fake probe) and a scripted adapter — no live daemon.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { runCommand, resolveRunId } from "../src/commands/run";
import { raiseEscalation } from "../src/escalation";
import { ensurePhase } from "../src/fsm";
import { RunStore } from "../src/run-store";
import { fastConfig, cleanupTempDirs, makeTempDir } from "./helpers";
import { makeFakeProbe } from "./fixtures/fake-substrate-probe";
import { ScriptedAdapter } from "./helpers/scripted-adapter";
import {
  defaultVerifierEnvelope,
  inspectResult,
  passRunner,
  seedBuilderWorktree,
} from "./helpers/step-harness";

const PLAN = [
  "---",
  "title: Run Command Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Run Command Test Plan",
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
  worktree: string;
  canonicalWorktree: string;
  config: ReturnType<typeof fastConfig>;
}

async function admit(opts: { lifecycle?: string } = {}): Promise<AdmittedRun> {
  const basePath = makeTempDir("miah-run-cmd-");
  const config = fastConfig();
  const holderId = "command-holder";
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
  const worktree = makeTempDir("miah-worktree-");
  seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
  const canonicalWorktree = makeTempDir("miah-canonical-");
  return {
    basePath,
    runId: admission.run.runId,
    holderId,
    worktree,
    canonicalWorktree,
    config,
  };
}

function adapterFor(run: AdmittedRun, lifecycle = "idle"): ScriptedAdapter {
  const adapter = new ScriptedAdapter();
  adapter.launchResult = { agentId: "agent-1", cwd: run.worktree, workspaceId: "wks_1" };
  adapter.statusFor = () => lifecycle;
  adapter.inspectFor = () => inspectResult("agent-1", lifecycle, run.worktree);
  return adapter;
}

function captureLogs(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  return { stdout, stderr };
}

describe("run command", () => {
  it("resolves the latest run id when none is given (KTD15 default)", async () => {
    const basePath = makeTempDir("miah-run-cmd-");
    expect(resolveRunId(basePath)).toBeNull();
    await admitPlan(PLAN, {
      probe: makeFakeProbe(),
      config: fastConfig(),
      basePath,
      holderId: "h",
      workspacePaths: [],
    });
    const id = resolveRunId(basePath);
    expect(id).not.toBeNull();
    expect(id).toMatch(/^run-/);
  });

  it("drives an admitted run to completion: exit 0, prints complete, approval package written (R67)", async () => {
    const run = await admit();
    const logs = captureLogs();
    const adapter = adapterFor(run);
    const code = await runCommand(run.runId, {
      adapter,
      basePath: run.basePath,
      holderId: run.holderId,
      config: run.config,
      workspaceRoot: run.worktree,
      canonicalWorktree: run.canonicalWorktree,
      runCommand: passRunner,
      verificationCommandsFor: () => ["npm test"],
      verifierEnvelopeFor: defaultVerifierEnvelope,
    });

    expect(code).toBe(0);
    expect(logs.stdout.join("\n")).toContain("run complete");
    const approval = path.join(run.basePath, "runs", run.runId, "approval-package.json");
    expect(fs.existsSync(approval)).toBe(true);
  });

  it("U5.AC7: the production run path sources commands from the parsed contract (no runtime default)", async () => {
    const run = await admit();
    const logs = captureLogs();
    const adapter = adapterFor(run);
    const seenCommands: string[] = [];
    // No verificationCommandsFor is passed: the production default reads the
    // unit's parsed frozen contract (R15, KTD1).
    const code = await runCommand(run.runId, {
      adapter,
      basePath: run.basePath,
      holderId: run.holderId,
      config: run.config,
      workspaceRoot: run.worktree,
      canonicalWorktree: run.canonicalWorktree,
      runCommand: async (command, cwd) => {
        seenCommands.push(command);
        return { command, exit_code: 0, stdout: "ok\n", stderr: "" };
      },
      verifierEnvelopeFor: defaultVerifierEnvelope,
    });
    expect(code).toBe(0);
    expect(logs.stdout.join("\n")).toContain("run complete");
    // The sensor ran exactly the snapshot contract's command (`npm test` from
    // the plan's Verification Contract block) — never an empty default.
    expect(seenCommands).toContain("npm test");
    const state = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: "read-holder",
    }).replay().state;
    expect(state.units.U1.status).toBe("accepted");
  });

  it("miah run --once advances one step (exit 0) and the next --once completes (D6-a, U10.8)", async () => {
    const run = await admit();
    const adapter = adapterFor(run, "running");
    const baseOpts = {
      basePath: run.basePath,
      holderId: run.holderId,
      config: run.config,
      workspaceRoot: run.worktree,
      canonicalWorktree: run.canonicalWorktree,
      runCommand: passRunner,
      verifierEnvelopeFor: defaultVerifierEnvelope,
    };

    const firstLogs = captureLogs();
    const first = await runCommand(run.runId, { ...baseOpts, adapter, once: true });
    expect(first).toBe(0);
    expect(firstLogs.stdout.join("\n")).toContain("step advanced");

    // The specialist finished while the driver was dead; resume completes it.
    const resumed = adapterFor(run, "idle");
    const secondLogs = captureLogs();
    const second = await runCommand(run.runId, { ...baseOpts, adapter: resumed, once: true });
    expect(second).toBe(0);
    expect(secondLogs.stdout.join("\n")).toContain("run complete");
  });

  it("returns a non-zero exit when the run does not exist", async () => {
    const logs = captureLogs();
    const code = await runCommand("run-does-not-exist", { basePath: makeTempDir() });
    expect(code).toBe(1);
    expect(logs.stderr.join("\n")).toContain("no manifest");
  });

  it("returns a non-zero exit when the lease is held by another live driver (R39)", async () => {
    const run = await admit();
    // Release the admission-time lease, then a *different* holder acquires it
    // with a fresh heartbeat (simulating another live driver).
    const admitStore = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    admitStore.lease.release(run.holderId);
    const otherStore = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: "other-driver",
    });
    const acquired = otherStore.lease.acquire("other-driver");
    expect(acquired.ok).toBe(true);

    const logs = captureLogs();
    const code = await runCommand(run.runId, {
      adapter: adapterFor(run),
      basePath: run.basePath,
      holderId: run.holderId,
      config: run.config,
      workspaceRoot: run.worktree,
      canonicalWorktree: run.canonicalWorktree,
    });
    expect(code).toBe(1);
    expect(logs.stdout.join("\n")).toContain("lease held by another driver");
  });

  it("returns RUN_BLOCKED_EXIT_CODE (1) when the run is paused in Attention (blocked)", async () => {
    const run = await admit();
    // A prior driver session escalated the run and paused it in Attention.
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    raiseEscalation(store, {
      unit_id: "U1",
      trigger: "repeatedly-fails",
      reason: "max takes exceeded for U1 (R77)",
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);

    const logs = captureLogs();
    const code = await runCommand(run.runId, {
      adapter: adapterFor(run),
      basePath: run.basePath,
      holderId: run.holderId,
      config: run.config,
      workspaceRoot: run.worktree,
      canonicalWorktree: run.canonicalWorktree,
    });
    // The E2E drive-run child depends on this exact exit code (Attention).
    expect(code).toBe(1);
    expect(logs.stdout.join("\n")).toContain("run paused in Attention");
    expect(logs.stdout.join("\n")).toContain("max takes exceeded");
  });
});
