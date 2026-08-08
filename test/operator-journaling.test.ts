/**
 * R69 journaling test: every operator action (`stop`, `resolve`, `approve`,
 * `reject`, `amend`) is journaled as an `operator_decision` event carrying
 * operator identity, timestamp, and decision.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { runAmend } from "../src/commands/amend";
import { runApprove } from "../src/commands/approve";
import { runCommand } from "../src/commands/run";
import { runReject } from "../src/commands/reject";
import { runResolve } from "../src/commands/resolve";
import { runStop } from "../src/commands/stop";
import { ensurePhase } from "../src/fsm";
import { raiseEscalation } from "../src/escalation";
import { readJournalFile, type JournalEvent } from "../src/journal";
import { writeManifest } from "../src/manifest";
import { RunStore } from "../src/run-store";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { makeFakeProbe } from "./fixtures/fake-substrate-probe";
import { ScriptedAdapter } from "./helpers/scripted-adapter";
import {
  inspectResult,
  makeUnit,
  passRunner,
  seedBuilderWorktree,
  setupHarness,
} from "./helpers/step-harness";

const PLAN = [
  "---",
  "title: Journaling Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Journaling Test Plan",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **creates:** `src/hello.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - `src/hello.ts` exists and is exported — `tier: deterministic`",
  "",
].join("\n");

const AMEND_PLAN = [
  "---",
  "title: Journaling Amend Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Journaling Amend Plan",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **creates:** `src/a.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - `src/a.ts` exists and is exported — `tier: deterministic`",
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
  const basePath = makeTempDir("miah-journal-");
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

async function driveToApproval(run: AdmittedRun): Promise<void> {
  const worktree = makeTempDir("miah-journal-ws-");
  seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
  const canonicalWorktree = makeTempDir("miah-journal-canonical-");
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

async function capture(callback: () => number | Promise<number>): Promise<{ code: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  const code = await callback();
  return { code };
}

async function operatorDecisionsOf(run: AdmittedRun): Promise<JournalEvent[]> {
  const store = new RunStore({
    basePath: run.basePath,
    runId: run.runId,
    config: run.config,
    holderId: run.holderId,
  });
  const { events } = readJournalFile(store.layout.journalPath);
  return events.filter((e) => e.type === "operator_decision");
}

function assertJournaled(decision: JournalEvent | undefined, expected: Record<string, unknown>): void {
  expect(decision).toBeDefined();
  expect(decision).toMatchObject(expected);
  // R69: identity + timestamp + decision on every operator action.
  expect(typeof decision?.operator).toBe("string");
  expect((decision?.operator as string).length).toBeGreaterThan(0);
  expect(typeof decision?.timestamp).toBe("number");
}

describe("operator journaling", () => {
  it("stop is journaled with identity, timestamp, and decision (R69)", async () => {
    const run = await admit(PLAN);
    const store = new RunStore({ basePath: run.basePath, runId: run.runId, config: run.config, holderId: run.holderId });
    store.lease.release(run.holderId);
    expect((await capture(() => runStop(run.runId, { basePath: run.basePath, config: run.config }))).code).toBe(0);
    const decisions = await operatorDecisionsOf(run);
    assertJournaled(decisions[0], { decision: "stop" });
  });

  it("resolve is journaled with identity, timestamp, and decision (R69)", async () => {
    const run = await admit(PLAN);
    const store = new RunStore({ basePath: run.basePath, runId: run.runId, config: run.config, holderId: run.holderId });
    const raised = raiseEscalation(store, { unit_id: "U1", trigger: "no-progress", reason: "no change" });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);
    const { code } = await capture(() =>
      runResolve(run.runId, raised.escalation_id, "rework", "retry", { basePath: run.basePath, config: run.config }),
    );
    expect(code).toBe(0);
    const decisions = await operatorDecisionsOf(run);
    assertJournaled(decisions[0], { decision: "resolve", resolve_decision: "rework" });
  });

  it("approve is journaled with identity, timestamp, and decision (R69)", async () => {
    const run = await admit(PLAN);
    await driveToApproval(run);
    expect((await capture(() => runApprove(run.runId, { basePath: run.basePath, config: run.config }))).code).toBe(0);
    const decisions = await operatorDecisionsOf(run);
    assertJournaled(decisions[0], { decision: "approve" });
  });

  it("reject is journaled with identity, timestamp, and decision (R69)", async () => {
    const run = await admit(PLAN);
    await driveToApproval(run);
    expect((await capture(() => runReject(run.runId, { end: true }, { basePath: run.basePath, config: run.config }))).code).toBe(0);
    const decisions = await operatorDecisionsOf(run);
    assertJournaled(decisions[0], { decision: "reject", end: true });
  });

  it("amend is journaled with identity, timestamp, and decision (R69)", async () => {
    const h = setupHarness({ U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }) });
    writeManifest(h.t.layout, {
      schema_version: 1,
      run_id: h.t.layout.runId,
      plan_hash: "a".repeat(64),
      plan_snapshot_file: "plan-snapshot.v1.md",
      created_at: new Date().toISOString(),
      config_snapshot: h.config,
      probe_verdicts: {},
    });
    h.t.store.lease.release(h.holderId);
    const planPath = path.join(makeTempDir("miah-journal-amend-"), "plan.md");
    fs.writeFileSync(planPath, AMEND_PLAN, "utf8");
    const { code } = await capture(() =>
      runAmend(h.t.layout.runId, planPath, {
        basePath: h.t.basePath,
        config: h.config,
        holderId: "amend-holder",
        workspaceRoot: h.repoRoot,
      }),
    );
    expect(code).toBe(0);
    const { events } = readJournalFile(h.t.layout.journalPath);
    const decision = events.find((e) => e.type === "operator_decision");
    assertJournaled(decision, { decision: "amend" });
    // The amendment itself is also journaled with the operator identity.
    const amended = events.find((e) => e.type === "amendment_applied");
    expect(typeof amended?.operator).toBe("string");
  });
});
