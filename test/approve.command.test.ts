/**
 * `miah approve` command tests (U9.9, R67, F15, AE24).
 *
 * `miah approve` on an all-accepted run journals `operator_decision: approve`
 * (R69), transitions AwaitingApproval -> Complete, and appends
 * `run_terminal: complete`. It refuses when the run is not fully accepted or
 * is already terminal.
 */
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { runApprove } from "../src/commands/approve";
import { runCommand } from "../src/commands/run";
import { readJournalFile } from "../src/journal";
import { RunStore } from "../src/run-store";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { makeFakeProbe } from "./fixtures/fake-substrate-probe";
import { ScriptedAdapter } from "./helpers/scripted-adapter";
import {
  inspectResult,
  passRunner,
  seedBuilderWorktree,
} from "./helpers/step-harness";

const PLAN = [
  "---",
  "title: Approve Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Approve Test Plan",
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
  "  - `src/hello.ts` exists and is exported — `tier: deterministic`",
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
  const basePath = makeTempDir("miah-approve-");
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

/** Drive the run to AwaitingApproval via the looping driver (R67). */
async function driveToApproval(run: AdmittedRun): Promise<void> {
  const worktree = makeTempDir("miah-approve-ws-");
  seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
  const canonicalWorktree = makeTempDir("miah-approve-canonical-");
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

describe("approve command", () => {
  it("on an all-accepted run writes run_terminal: complete and releases the lease (R67, AE24)", async () => {
    const run = await admit();
    await driveToApproval(run);

    const { code, stdout } = await capture(() =>
      runApprove(run.runId, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("approved");

    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    const { events } = readJournalFile(store.layout.journalPath);
    const decision = events.find((e) => e.type === "operator_decision");
    expect(decision).toMatchObject({ decision: "approve" });
    // R69: identity + timestamp + decision.
    expect(typeof decision?.operator).toBe("string");
    expect((decision?.operator as string).length).toBeGreaterThan(0);
    expect(typeof decision?.timestamp).toBe("number");

    expect(events.some((e) => e.type === "run_terminal" && e.status === "complete")).toBe(true);
    expect(events.some((e) => e.type === "phase_transition" && e.to === "Complete")).toBe(true);
    const state = store.replay().state;
    expect(state.terminal).toBe("complete");
    expect(state.phase).toBe("Complete");
    // The lease was released: a resumer can acquire immediately.
    expect(store.lease.holderId()).toBeNull();
  });

  it("refuses when the run is not fully accepted", async () => {
    const run = await admit();
    // Release the admission lease so approve can acquire and reach the guard.
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    store.lease.release(run.holderId);
    const { code, stderr } = await capture(() =>
      runApprove(run.runId, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("not fully accepted");
  });

  it("refuses when the run is already terminal", async () => {
    const run = await admit();
    await driveToApproval(run);
    expect(
      (await capture(() => runApprove(run.runId, { basePath: run.basePath, config: run.config })))
        .code,
    ).toBe(0);
    const { code, stderr } = await capture(() =>
      runApprove(run.runId, { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("already terminal");
  });

  it("returns non-zero when the run does not exist", async () => {
    const { code, stderr } = await capture(() =>
      runApprove("run-missing", { basePath: makeTempDir("miah-approve-empty-") }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("no run found");
  });
});
