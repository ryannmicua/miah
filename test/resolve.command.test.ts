/**
 * `miah resolve` command tests (U9.8, R66, R69, F14).
 *
 * `miah resolve` appends `operator_decision: resolve` + `escalation_resolved`
 * with the close reason, and marks the affected unit for re-dispatch (rework)
 * or acceptance (approve). A run paused in Attention resumes to Ready so the
 * next `miah run` re-dispatches.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { runCommand } from "../src/commands/run";
import { runResolve } from "../src/commands/resolve";
import { writeApprovalPackage } from "../src/driver";
import { ensurePhase } from "../src/fsm";
import { raiseEscalation, unresolvedEscalations } from "../src/escalation";
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
  "title: Resolve Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Resolve Test Plan",
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
  const basePath = makeTempDir("miah-resolve-");
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

/** Raise an escalation and pause the run in Attention (as the driver does). */
function escalateAndPause(run: AdmittedRun, input: { criterion?: string } = {}): string {
  const store = new RunStore({
    basePath: run.basePath,
    runId: run.runId,
    config: run.config,
    holderId: run.holderId,
  });
  const raised = raiseEscalation(store, {
    unit_id: "U1",
    trigger: "repeatedly-fails",
    reason: "max takes exceeded for U1 (R77)",
    criterion: input.criterion ?? null,
  });
  ensurePhase(store, "Attention");
  store.lease.release(run.holderId);
  return raised.escalation_id;
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

async function captureRunResolve(
  runId: string,
  escalationId: string,
  decision: "approve" | "deny" | "rework",
  note?: string,
  basePath?: string,
  config?: ReturnType<typeof fastConfig>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return capture(() =>
    runResolve(runId, escalationId, decision, note, {
      basePath: basePath ?? makeTempDir("miah-resolve-empty-"),
      config,
    }),
  );
}

function adapterFor(run: AdmittedRun, worktree: string, lifecycle = "idle"): ScriptedAdapter {
  const adapter = new ScriptedAdapter();
  adapter.launchResult = { agentId: "agent-1", cwd: worktree, workspaceId: "wks_1" };
  adapter.statusFor = () => lifecycle;
  adapter.inspectFor = () => inspectResult("agent-1", lifecycle, worktree);
  return adapter;
}

describe("resolve command", () => {
  it("appends operator_decision resolve + escalation_resolved and marks the unit for re-dispatch (rework) (R66, R69, F14)", async () => {
    const run = await admit();
    const escalationId = escalateAndPause(run);

    const { code, stdout } = await captureRunResolve(
      run.runId,
      escalationId,
      "rework",
      "fix the gap",
      run.basePath,
      run.config,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("resolved with rework");

    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    const { events } = readJournalFile(store.layout.journalPath);
    const decision = events.find((e) => e.type === "operator_decision");
    expect(decision).toMatchObject({
      decision: "resolve",
      escalation_id: escalationId,
      resolve_decision: "rework",
    });
    // R69: identity + timestamp + decision.
    expect(typeof decision?.operator).toBe("string");
    expect((decision?.operator as string).length).toBeGreaterThan(0);
    expect(typeof decision?.timestamp).toBe("number");

    const resolved = events.find((e) => e.type === "escalation_resolved");
    expect(resolved).toMatchObject({ escalation_id: escalationId, decision: "rework" });
    expect(resolved?.close_reason).toContain("fix the gap");

    // Unit marked for re-dispatch.
    expect(events.some((e) => e.type === "rework_started" && e.unit_id === "U1")).toBe(true);
    expect(events.some((e) => e.type === "phase_transition" && e.to === "Ready")).toBe(true);
    expect(unresolvedEscalations(store)).toHaveLength(0);
  });

  it("the next miah run sees the resolution and re-dispatches the unit (R66, U9.8)", async () => {
    const run = await admit();
    // Take 1 was dispatched, terminated, failed acceptance, and escalated.
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    store.append("dispatch_intent", { unit_id: "U1", role: "builder", take: 1, idempotency_key: "k1", packet_hash: "p", deadline: "d", provider: "p", model: "m" });
    store.append("dispatch_created", { unit_id: "U1", agent_id: "agent-old", workspace_id: "w1" });
    store.append("dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k1" });
    store.append("acceptance_decision", { unit_id: "U1", decision: "not_accepted", route: "escalate", reason: "calibration not cleared (R48)" });
    const raised = raiseEscalation(store, {
      unit_id: "U1",
      trigger: "no-checker-profile-clears-calibration-bar",
      reason: "no checker profile clears the calibration bar (R48/R20)",
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);
    expect(
      (
        await captureRunResolve(
          run.runId,
          raised.escalation_id,
          "rework",
          undefined,
          run.basePath,
          run.config,
        )
      ).code,
    ).toBe(0);

    const worktree = makeTempDir("miah-resolve-ws-");
    seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
    seedBuilderWorktree(worktree, "U1", 2, ["src/hello.ts"]);
    const canonicalWorktree = makeTempDir("miah-resolve-canonical-");
    const adapter = adapterFor(run, worktree);

    const code = await runCommand(run.runId, {
      adapter,
      basePath: run.basePath,
      holderId: "run-holder",
      config: run.config,
      workspaceRoot: worktree,
      canonicalWorktree,
      runCommand: passRunner,
      verificationCommandsFor: () => ["npm test"],
    });
    expect(code).toBe(0);

    const { events } = readJournalFile(store.layout.journalPath);
    const intents = events.filter((e) => e.type === "dispatch_intent" && e.unit_id === "U1");
    // Take 1 was the failed pre-escalation attempt; take 2 is the re-dispatch.
    expect(intents).toHaveLength(2);
    expect(store.replay().state.units.U1.status).toBe("accepted");
  });

  it("approve closes the escalated criterion's gap and marks the unit accepted (F14)", async () => {
    const run = await admit();
    const escalationId = escalateAndPause(run, { criterion: "behaves per contract" });

    const { code } = await captureRunResolve(
      run.runId,
      escalationId,
      "approve",
      "reviewer verdict is sound",
      run.basePath,
      run.config,
    );
    expect(code).toBe(0);

    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    const { events } = readJournalFile(store.layout.journalPath);
    expect(events.some((e) => e.type === "escalation_resolved" && e.escalation_id === escalationId)).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "gap_closed" &&
          e.unit_id === "U1" &&
          e.criterion === "behaves per contract",
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "acceptance_decision" && e.unit_id === "U1" && e.decision === "accept"),
    ).toBe(true);
    expect(store.replay().state.units.U1.status).toBe("accepted");
    expect(unresolvedEscalations(store)).toHaveLength(0);
  });

  it("approve with multiple open gaps journals a gap_closed per gap so the approval package lists every close reason (R50, M1)", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    // Two open gaps on U1; the escalation addresses only one criterion.
    store.append("gap_recorded", {
      unit_id: "U1",
      criterion: "behaves per contract",
      reason: "reviewer could not verify",
    });
    store.append("gap_recorded", {
      unit_id: "U1",
      criterion: "meets requirements",
      reason: "missing evidence",
    });
    const raised = raiseEscalation(store, {
      unit_id: "U1",
      trigger: "repeatedly-fails",
      reason: "max takes exceeded for U1 (R77)",
      criterion: "behaves per contract",
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);
    expect(store.stateSnapshot().open_gaps).toHaveLength(2);

    const { code } = await captureRunResolve(
      run.runId,
      raised.escalation_id,
      "approve",
      "operator accepted",
      run.basePath,
      run.config,
    );
    expect(code).toBe(0);

    // The accept decision superseded every open gap: derived state has none.
    const state = store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.open_gaps).toHaveLength(0);

    // The approval package lists BOTH gap close reasons (the escalation
    // criterion's + the implicitly-closed one), so nothing disappears silently.
    const pkgPath = writeApprovalPackage(store);
    expect(pkgPath).not.toBeNull();
    const pkg = JSON.parse(fs.readFileSync(pkgPath as string, "utf8"));
    const closes = pkg.gap_close_reasons as Array<{
      unit_id: string;
      criterion: string;
      close_reason: string;
    }>;
    expect(closes).toHaveLength(2);
    expect(closes.map((g) => g.criterion).sort()).toEqual([
      "behaves per contract",
      "meets requirements",
    ]);
    expect(closes.every((g) => g.unit_id === "U1")).toBe(true);
    // The implicitly-closed gap carries the R50 operator-approval reason.
    const implicit = closes.find((g) => g.criterion === "meets requirements");
    expect(implicit?.close_reason).toBe("operator-approval");
  });

  it("returns non-zero when the escalation is not open", async () => {
    const run = await admit();
    // Release the admission lease so the resolve command can acquire it.
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    store.lease.release(run.holderId);
    const { code, stderr } = await captureRunResolve(
      run.runId,
      "esc-999",
      "rework",
      undefined,
      run.basePath,
      run.config,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("esc-999");
  });

  it("returns non-zero when the run does not exist", async () => {
    const { code, stderr } = await captureRunResolve("run-missing", "esc-1", "rework");
    expect(code).toBe(1);
    expect(stderr).toContain("no run found");
  });
});
