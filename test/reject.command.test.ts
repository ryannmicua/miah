/**
 * `miah reject` command tests (U9.10, R67, F15).
 *
 * `miah reject --end` writes `run_terminal: rejected`. `miah reject
 * --rework <unit-ids>` marks the specified units for re-dispatch without
 * terminating the run. Both journal `operator_decision: reject` (R69).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { runCommand } from "../src/commands/run";
import { runReject } from "../src/commands/reject";
import { readJournalFile } from "../src/journal";
import { RunStore } from "../src/run-store";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { makeFakeProbe } from "./fixtures/fake-substrate-probe";
import { ScriptedAdapter } from "./helpers/scripted-adapter";
import {
  defaultVerifierEnvelope,
  inspectResult,
  passRunner,
  seedBuilderWorktree,
} from "./helpers/step-harness";

const ONE_UNIT_PLAN = [
  "---",
  "title: Reject Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Reject Test Plan",
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

const TWO_UNIT_PLAN = [
  "---",
  "title: Reject Two-Unit Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Reject Two-Unit Test Plan",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **Goal:** Create the `src/a.ts` source module.",
  "- **creates:** `src/a.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - U1.AC1. `src/a.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U1.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
  "### U2. Consumer module",
  "",
  "- **Goal:** Create the `src/b.ts` consumer module.",
  "- **creates:** `src/b.ts`",
  "- **inputs:** none",
  "- **depends-on:** U1",
  "- **Acceptance:**",
  "  - U2.AC1. `src/b.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U2.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`",
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

async function admit(planText: string): Promise<AdmittedRun> {
  const basePath = makeTempDir("miah-reject-");
  const config = fastConfig();
  const holderId = "admit-holder";
  const admission = await admitPlan(planText, {
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

async function driveToApproval(run: AdmittedRun, seeds: Array<{ unit: string; take: number; files: string[] }>): Promise<void> {
  const worktree = makeTempDir("miah-reject-ws-");
  for (const seed of seeds) {
    seedBuilderWorktree(worktree, seed.unit, seed.take, seed.files);
  }
  const canonicalWorktree = makeTempDir("miah-reject-canonical-");
  const adapter = new ScriptedAdapter();
  adapter.launchResult = { agentId: "agent-1", cwd: worktree, workspaceId: "wks_1" };
  adapter.statusFor = () => "idle";
  adapter.inspectFor = () => inspectResult("agent-1", "idle", worktree);
  const code = await runCommand(run.runId, {
    adapter,
    basePath: run.basePath,
    holderId: run.holderId,
    config: run.config,
    workspaceRoot: worktree,
    canonicalWorktree,
    runCommand: passRunner,
    verificationCommandsFor: () => ["npm test"],
    verifierEnvelopeFor: defaultVerifierEnvelope,
  });
  expect(code).toBe(0);
}

function capture(callback: () => Promise<number>): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  return callback().then((code) => ({
    code,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  }));
}

describe("reject command", () => {
  it("reject --end writes run_terminal: rejected (R67)", async () => {
    const run = await admit(ONE_UNIT_PLAN);
    await driveToApproval(run, [{ unit: "U1", take: 1, files: ["src/hello.ts"] }]);

    const { code, stdout } = await capture(() =>
      runReject(run.runId, { end: true }, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("run_terminal: rejected");

    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    const { events } = readJournalFile(store.layout.journalPath);
    const decision = events.find((e) => e.type === "operator_decision");
    expect(decision).toMatchObject({ decision: "reject", end: true });
    // R69: identity + timestamp + decision.
    expect(typeof decision?.operator).toBe("string");
    expect((decision?.operator as string).length).toBeGreaterThan(0);
    expect(typeof decision?.timestamp).toBe("number");

    expect(events.some((e) => e.type === "run_terminal" && e.status === "rejected")).toBe(true);
    expect(store.replay().state.terminal).toBe("rejected");
  });

  it("reject --rework <unit-ids> marks units without terminating the run (R67, U9.10)", async () => {
    const run = await admit(TWO_UNIT_PLAN);
    await driveToApproval(run, [
      { unit: "U1", take: 1, files: ["src/a.ts"] },
      { unit: "U2", take: 1, files: ["src/b.ts"] },
    ]);

    const { code, stdout } = await capture(() =>
      runReject(run.runId, { rework: ["U2"] }, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("U2 marked for re-dispatch");

    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    const { events } = readJournalFile(store.layout.journalPath);
    const decision = events.find((e) => e.type === "operator_decision");
    expect(decision).toMatchObject({ decision: "reject", rework_units: ["U2"] });

    // U2 marked for re-dispatch; no termination.
    expect(events.some((e) => e.type === "rework_started" && e.unit_id === "U2")).toBe(true);
    expect(events.some((e) => e.type === "run_terminal")).toBe(false);
    const state = store.replay().state;
    expect(state.terminal).toBeNull();
    expect(state.units.U2.status).toBe("rework");
    expect(state.units.U1.status).toBe("accepted");
  });

  it("reject --rework with an unknown unit returns non-zero", async () => {
    const run = await admit(ONE_UNIT_PLAN);
    // Release the admission lease so reject can acquire and reach the guard.
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    store.lease.release(run.holderId);
    const { code, stderr } = await capture(() =>
      runReject(run.runId, { rework: ["U9"] }, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("U9");
  });

  it("reject with neither --rework nor --end returns non-zero", async () => {
    const run = await admit(ONE_UNIT_PLAN);
    const { code, stderr } = await capture(() =>
      runReject(run.runId, {}, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("--rework");
  });

  it("reject --rework with --end together returns non-zero", async () => {
    const run = await admit(ONE_UNIT_PLAN);
    const { code, stderr } = await capture(() =>
      runReject(run.runId, { rework: ["U1"], end: true }, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("mutually exclusive");
  });

  it("reject --rework at AwaitingApproval → next `miah run` re-dispatches the marked unit and completes (R67)", async () => {
    const run = await admit(TWO_UNIT_PLAN);
    await driveToApproval(run, [
      { unit: "U1", take: 1, files: ["src/a.ts"] },
      { unit: "U2", take: 1, files: ["src/b.ts"] },
    ]);

    // Operator rejects U2 for rework at the final gate.
    const { code, stdout } = await capture(() =>
      runReject(run.runId, { rework: ["U2"] }, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("U2 marked for re-dispatch");

    // The run still sits at the gate with U2 durably marked for rework.
    const before = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    let state = before.replay().state;
    expect(state.phase).toBe("AwaitingApproval");
    expect(state.units.U2.status).toBe("rework");

    // The next `miah run` resumes: U2 re-dispatched (take 2) and completes.
    await driveToApproval(run, [
      { unit: "U1", take: 1, files: ["src/a.ts"] },
      { unit: "U2", take: 1, files: ["src/b.ts"] },
      { unit: "U2", take: 2, files: ["src/b.ts"] },
    ]);

    const after = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    state = after.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.units.U2.status).toBe("accepted");
    expect(state.phase).toBe("AwaitingApproval");

    const { events } = readJournalFile(after.layout.journalPath);
    const u2Intents = events.filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U2");
    expect(u2Intents).toHaveLength(2);
    const resumed = events.some(
      (e) => e.type === "phase_transition" && e.from === "AwaitingApproval" && e.to === "Ready",
    );
    expect(resumed).toBe(true);
  });
});
