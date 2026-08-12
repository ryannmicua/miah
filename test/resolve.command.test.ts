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
  defaultVerifierEnvelope,
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
  "  - U1.AC1. `src/hello.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U1.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
].join("\n");

/** Two deterministic criteria with IDENTICAL text (the KTD1 mis-target hazard). */
const PLAN_TWIN_TEXT = [
  "---",
  "title: Twin Text Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Twin Text Plan",
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
  "  - U1.AC1. same wording — `tier: deterministic`",
  "  - U1.AC2. same wording — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U1.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`; `U1.AC2` -> `U1.CMD1`",
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

async function admit(planText: string = PLAN): Promise<AdmittedRun> {
  const basePath = makeTempDir("miah-resolve-");
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
  extra: Parameters<typeof runResolve>[5] = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return capture(() =>
    runResolve(runId, escalationId, decision, note, {
      basePath: basePath ?? makeTempDir("miah-resolve-empty-"),
      config,
      ...extra,
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
      verifierEnvelopeFor: defaultVerifierEnvelope,
    });
    expect(code).toBe(0);

    const { events } = readJournalFile(store.layout.journalPath);
    const intents = events.filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U1");
    // Take 1 was the failed pre-escalation attempt; take 2 is the re-dispatch.
    expect(intents).toHaveLength(2);
    expect(store.replay().state.units.U1.status).toBe("accepted");
  });

  it("U6.AC3: operator approve records a pass for only the escalated criterion, closes its paired gaps, and re-evaluates all criteria", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    store.append("gap_recorded", {
      unit_id: "U1",
      criterion: "`src/hello.ts` exists and is exported",
      reason: "reviewer could not verify",
    });
    const escalationId = escalateAndPause(run, { criterion: "`src/hello.ts` exists and is exported" });

    const worktree = makeTempDir("miah-resolve-ws-");
    seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
    const { code } = await captureRunResolve(
      run.runId,
      escalationId,
      "approve",
      "verifier flag resolved by operator",
      run.basePath,
      run.config,
      {
        adapter: adapterFor(run, worktree),
        canonicalWorktree: makeTempDir("miah-resolve-canonical-"),
        runCommand: passRunner,
        verificationCommandsFor: () => ["npm test"],
      },
    );
    expect(code).toBe(0);

    const { events } = readJournalFile(store.layout.journalPath);
    expect(events.some((e) => e.type === "escalation_resolved" && e.escalation_id === escalationId)).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "gap_closed" &&
          e.unit_id === "U1" &&
          e.criterion === "`src/hello.ts` exists and is exported",
      ),
    ).toBe(true);
    // The operator grade is a durable criterion-level PASS for exactly the
    // escalated criterion (KTD6: verifier entries + operator decisions only).
    const grades = store.replay().state.criterion_grades.U1;
    expect(grades).toEqual([
      expect.objectContaining({
        criterion_id: "U1.AC1",
        criterion: "`src/hello.ts` exists and is exported",
        tier: "deterministic",
        grade: "pass",
        source: "operator",
        basis: "operator-approval",
      }),
    ]);
    expect(
      events.some((e) => e.type === "acceptance_decision" && e.unit_id === "U1" && e.decision === "accept"),
    ).toBe(true);
    expect(store.replay().state.units.U1.status).toBe("accepted");
    expect(unresolvedEscalations(store)).toHaveLength(0);
  });

  it("KTD7: operator resolution by criterion_id targets the escalated twin-text criterion, not its namesake", async () => {
    const run = await admit(PLAN_TWIN_TEXT);
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    // AC1 passed verification; AC2 is ungraded/escalate — the predicate
    // escalates AC2, whose text is IDENTICAL to AC1's. The escalation payload
    // carries AC2's stable id (the applyAcceptance KTD7 shape).
    store.append("criterion_grades_recorded", {
      unit_id: "U1",
      grades: [
        { criterion_id: "U1.AC1", criterion: "same wording", tier: "deterministic", grade: "pass", route: null, basis: "verifier-certified:all-passed", source: "verifier" },
        { criterion_id: "U1.AC2", criterion: "same wording", tier: "deterministic", grade: "ungraded", route: "escalate", basis: "verifier-ungraded: mechanical evidence insufficient", source: "verifier" },
      ],
    });
    const raised = raiseEscalation(store, {
      unit_id: "U1",
      trigger: "no-checker-profile-clears-calibration-bar",
      reason: "verdict is ungraded (calibration bar not cleared / operator judgment required, R48)",
      criterion: "same wording",
      payload: { criterion_id: "U1.AC2", declared_tier: "deterministic" },
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);

    const { code } = await captureRunResolve(
      run.runId,
      raised.escalation_id,
      "approve",
      "operator graded AC2",
      run.basePath,
      run.config,
    );
    expect(code).toBe(0);

    const state = store.replay().state;
    // The operator grade landed on U1.AC2 — the escalated criterion — NOT on
    // U1.AC1, even though both criteria share identical display text.
    const grades = state.criterion_grades.U1;
    expect(grades.some((g) => g.criterion_id === "U1.AC2" && g.source === "operator" && g.grade === "pass")).toBe(true);
    expect(grades.some((g) => g.criterion_id === "U1.AC1" && g.source === "operator")).toBe(false);
    // AC1's verifier pass survived the merge untouched.
    expect(grades.some((g) => g.criterion_id === "U1.AC1" && g.source === "verifier" && g.grade === "pass")).toBe(true);
    // Both criteria now pass: the unit accepts.
    expect(state.units.U1.status).toBe("accepted");
    expect(
      store.journal.readEvents().some((e) => e.type === "acceptance_decision" && e.unit_id === "U1" && e.decision === "accept"),
    ).toBe(true);
    expect(unresolvedEscalations(store)).toHaveLength(0);
  });

  it("U6: resolving one criterion cannot append whole-unit accept while another gap remains", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    // Two open gaps on U1; the escalation addresses only the declared one.
    store.append("gap_recorded", {
      unit_id: "U1",
      criterion: "`src/hello.ts` exists and is exported",
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
      criterion: "`src/hello.ts` exists and is exported",
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);
    expect(store.stateSnapshot().open_gaps).toHaveLength(2);

    const worktree = makeTempDir("miah-resolve-ws-");
    seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
    const { code } = await captureRunResolve(
      run.runId,
      raised.escalation_id,
      "approve",
      "operator accepted",
      run.basePath,
      run.config,
      {
        adapter: adapterFor(run, worktree),
        canonicalWorktree: makeTempDir("miah-resolve-canonical-"),
        runCommand: passRunner,
        verificationCommandsFor: () => ["npm test"],
      },
    );
    expect(code).toBe(0);

    const { events } = readJournalFile(store.layout.journalPath);
    // The escalated criterion's gap closed and its operator grade recorded...
    expect(
      events.some(
        (e) => e.type === "gap_closed" && e.criterion === "`src/hello.ts` exists and is exported",
      ),
    ).toBe(true);
    // ...but the unrelated gap stays open and blocks the whole-unit accept:
    // the resolve never appends acceptance_decision: accept by shortcut.
    expect(store.replay().state.open_gaps.map((g) => g.criterion)).toContain("meets requirements");
    expect(
      events.some((e) => e.type === "acceptance_decision" && e.decision === "accept"),
    ).toBe(false);
    expect(store.replay().state.units.U1.status).not.toBe("accepted");
    // The operator grade itself is preserved (unrelated grades never erased).
    expect(
      store.replay().state.criterion_grades.U1?.some(
        (g) => g.criterion_id === "U1.AC1" && g.source === "operator" && g.grade === "pass",
      ),
    ).toBe(true);
  });

  it("deny resolves the escalation without accepting the unit (R66, U9.8)", async () => {
    const run = await admit();
    const escalationId = escalateAndPause(run);

    const { code, stdout } = await captureRunResolve(
      run.runId,
      escalationId,
      "deny",
      "operator denies this attempt",
      run.basePath,
      run.config,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("resolved with deny");

    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    const { events } = readJournalFile(store.layout.journalPath);
    expect(
      events.some((e) => e.type === "operator_decision" && e.resolve_decision === "deny"),
    ).toBe(true);
    const resolved = events.find((e) => e.type === "escalation_resolved");
    expect(resolved).toMatchObject({ escalation_id: escalationId, decision: "deny" });
    expect(resolved?.close_reason).toContain("operator denies this attempt");

    // The unit was NOT accepted and no rework was started for it.
    expect(events.some((e) => e.type === "acceptance_decision" && e.decision === "accept")).toBe(
      false,
    );
    expect(events.some((e) => e.type === "rework_started")).toBe(false);
    expect(store.replay().state.units.U1.status).not.toBe("accepted");
    expect(unresolvedEscalations(store)).toHaveLength(0);
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

  it("U6.AC1: a verifier-flagged escalation resolved by approve records the operator pass for that criterion", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    const raised = raiseEscalation(store, {
      unit_id: "U1",
      trigger: "verifier-flagged-for-human-judgment",
      reason: "verifier flagged criterion U1.AC1 for human judgment",
      criterion: "`src/hello.ts` exists and is exported",
      payload: {
        criterion_id: "U1.AC1",
        declared_tier: "deterministic",
        verifier_attempt: "dispatch-verifier-U1-t1-a1",
        basis: "evidence is materially inadequate",
        evidence_package_sha256: "a".repeat(64),
        evidence: [],
      },
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);

    const worktree = makeTempDir("miah-resolve-ws-");
    seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
    const { code } = await captureRunResolve(
      run.runId,
      raised.escalation_id,
      "approve",
      undefined,
      run.basePath,
      run.config,
      {
        adapter: adapterFor(run, worktree),
        canonicalWorktree: makeTempDir("miah-resolve-canonical-"),
        runCommand: passRunner,
        verificationCommandsFor: () => ["npm test"],
      },
    );
    expect(code).toBe(0);
    const state = store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.criterion_grades.U1?.[0]).toMatchObject({
      criterion_id: "U1.AC1",
      grade: "pass",
      source: "operator",
    });
  });

  it("U6.AC4: operator rework records a fail/rework route without erasing unrelated grades or gaps", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    // A durable verifier pass grade for the declared criterion exists already.
    store.append("criterion_grades_recorded", {
      unit_id: "U1",
      grades: [
        {
          criterion_id: "U1.AC1",
          criterion: "`src/hello.ts` exists and is exported",
          tier: "deterministic",
          grade: "pass",
          route: null,
          basis: "verifier-certified:all-passed",
          source: "verifier",
        },
      ],
    });
    // An open gap on an unrelated criterion stays open through the rework.
    store.append("gap_recorded", {
      unit_id: "U1",
      criterion: "meets requirements",
      reason: "missing evidence",
    });
    const raised = raiseEscalation(store, {
      unit_id: "U1",
      trigger: "verifier-flagged-for-human-judgment",
      reason: "flag",
      criterion: "`src/hello.ts` exists and is exported",
      payload: { criterion_id: "U1.AC1", declared_tier: "deterministic" },
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);

    const worktree = makeTempDir("miah-resolve-ws-");
    seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
    const { code } = await captureRunResolve(
      run.runId,
      raised.escalation_id,
      "rework",
      undefined,
      run.basePath,
      run.config,
      {
        adapter: adapterFor(run, worktree),
        canonicalWorktree: makeTempDir("miah-resolve-canonical-"),
        runCommand: passRunner,
        verificationCommandsFor: () => ["npm test"],
      },
    );
    expect(code).toBe(0);
    const state = store.replay().state;
    // The operator's fail grade replaced only the escalated criterion's grade;
    // the unrelated gap stayed open; the unit routes to rework, not accept.
    const grades = state.criterion_grades.U1;
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({
      criterion_id: "U1.AC1",
      grade: "fail",
      route: "rework",
      source: "operator",
      basis: "operator-rework",
    });
    expect(state.open_gaps.map((g) => g.criterion)).toContain("meets requirements");
    expect(state.units.U1.status).toBe("rework");
    const reworkEvents = store.journal.readEvents().filter((e) => e.type === "rework_started");
    expect(reworkEvents.length).toBeGreaterThan(0);
    // No whole-unit accept from the rework decision.
    expect(
      store.journal.readEvents().some((e) => e.type === "acceptance_decision" && e.decision === "accept"),
    ).toBe(false);
  });

  it("U6.AC6: a null-criterion verifier operational escalation supports same-candidate retry on approve and builder rework on rework", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    // A frozen candidate with verifier attempts at the ceiling.
    store.append("dispatch_intent", { unit_id: "U1", role: "builder", take: 1, idempotency_key: "k1", packet_hash: "p", deadline: "d", provider: "p", model: "m" });
    store.append("dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k1" });
    store.append("verifier_attempt_failed", { unit_id: "U1", attempt: "a1", reason: "missing envelope" });
    store.append("verifier_attempt_failed", { unit_id: "U1", attempt: "a2", reason: "missing envelope" });
    const raised = raiseEscalation(store, {
      unit_id: "U1",
      trigger: "repeatedly-fails",
      reason: "max verifier attempts exceeded for U1 (verifier-dispatch, KTD5)",
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);
    expect(store.replay().state.units.U1.verifier_attempts).toBe(2);

    // approve: resets the verifier-attempt counter; the frozen candidate stays.
    const approveCode = await captureRunResolve(
      run.runId,
      raised.escalation_id,
      "approve",
      undefined,
      run.basePath,
      run.config,
    );
    expect(approveCode.code).toBe(0);
    const fresh = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    let state = fresh.replay().state;
    expect(state.units.U1.verifier_attempts).toBe(0);
    expect(state.units.U1.status).toBe("awaiting_verification");
    expect(state.awaiting_verification.U1).toMatchObject({ take: 1 });
    // Neither decision accepted the unit.
    expect(state.units.U1.status).not.toBe("accepted");

    // rework on a fresh null-criterion escalation starts a new builder take.
    const reacquired = fresh.lease.acquire(run.holderId);
    expect(reacquired.ok).toBe(true);
    const raised2 = raiseEscalation(fresh, {
      unit_id: "U1",
      trigger: "repeatedly-fails",
      reason: "max verifier attempts exceeded for U1 (verifier-dispatch, KTD5)",
    });
    fresh.lease.release(run.holderId);
    const reworkCode = await captureRunResolve(
      run.runId,
      raised2.escalation_id,
      "rework",
      undefined,
      run.basePath,
      run.config,
    );
    expect(reworkCode.code).toBe(0);
    state = fresh.replay().state;
    expect(state.units.U1.status).toBe("rework");
    expect(state.awaiting_verification.U1).toBeUndefined();
  });

  it("U6.AC5: integration after eventual acceptance uses the builder candidate, never the later verifier dispatch workspace", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    // The builder's observed workspace differs from the verifier's: the
    // verifier dispatch is the most recent dispatch, so a blind "last
    // dispatch" lookup would pick the wrong workspace.
    store.append("dispatch_intent", { unit_id: "U1", role: "builder", take: 1, idempotency_key: "k1", packet_hash: "p", deadline: "d", provider: "p", model: "m" });
    store.append("dispatch_created", { unit_id: "U1", role: "builder", take: 1, attempt: "k1", agent_id: "agent-builder", workspace_id: "wks-builder" });
    store.append("dispatch_terminated", { unit_id: "U1", role: "builder", take: 1, attempt: "k1", outcome: "success" });
    store.append("dispatch_intent", { unit_id: "U1", role: "verifier", take: 1, idempotency_key: "v1", packet_hash: "p", deadline: "d", provider: "p", model: "m" });
    store.append("dispatch_created", { unit_id: "U1", role: "verifier", take: 1, attempt: "v1", agent_id: "agent-verifier", workspace_id: "wks-verifier" });
    store.append("dispatch_terminated", { unit_id: "U1", role: "verifier", take: 1, attempt: "v1", outcome: "success" });
    const raised = raiseEscalation(store, {
      unit_id: "U1",
      trigger: "verifier-flagged-for-human-judgment",
      reason: "flag",
      criterion: "`src/hello.ts` exists and is exported",
      payload: { criterion_id: "U1.AC1", declared_tier: "deterministic" },
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);

    // The builder worktree holds the deliverable; the verifier workspace is a
    // decoy that would fail integration if (wrongly) used as the source.
    const builderWorktree = makeTempDir("miah-resolve-builder-");
    seedBuilderWorktree(builderWorktree, "U1", 1, ["src/hello.ts"]);
    const decoyWorktree = makeTempDir("miah-resolve-decoy-");
    const adapter = new ScriptedAdapter();
    adapter.inspectFor = (handle) =>
      inspectResult(
        handle.agentId,
        "idle",
        handle.agentId === "agent-builder" ? builderWorktree : decoyWorktree,
      );
    const integratedFiles: string[] = [];
    const canonicalWorktree = makeTempDir("miah-resolve-canonical-");
    const { code } = await captureRunResolve(
      run.runId,
      raised.escalation_id,
      "approve",
      undefined,
      run.basePath,
      run.config,
      {
        adapter,
        canonicalWorktree,
        runCommand: async (command, cwd) => {
          // Record which worktree the integration check ran in.
          integratedFiles.push(path.relative(builderWorktree, cwd));
          return { command, exit_code: 0, stdout: "ok\n", stderr: "" };
        },
        verificationCommandsFor: () => ["npm test"],
      },
    );
    expect(code).toBe(0);
    // Integration ran in the BUILDER candidate workspace, not the verifier's.
    expect(integratedFiles).toHaveLength(1);
    expect(fs.existsSync(path.join(canonicalWorktree, "src", "hello.ts"))).toBe(true);
    expect(store.replay().state.units.U1.status).toBe("accepted");
  });

  it("U6.AC7: resolve-time integration sources the frozen commands from the parsed contract helper", async () => {
    const run = await admit();
    const store = new RunStore({
      basePath: run.basePath,
      runId: run.runId,
      config: run.config,
      holderId: run.holderId,
    });
    const raised = raiseEscalation(store, {
      unit_id: "U1",
      trigger: "verifier-flagged-for-human-judgment",
      reason: "flag",
      criterion: "`src/hello.ts` exists and is exported",
      payload: { criterion_id: "U1.AC1", declared_tier: "deterministic" },
    });
    // D1 (resolve-time integration safety): the integration check needs a
    // recoverable builder worktree as its source; journal the builder dispatch
    // so builderCandidateWorktree recovers this worktree (otherwise integration
    // is skipped and the contract commands below never run).
    store.append("dispatch_created", {
      unit_id: "U1",
      role: "builder",
      take: 1,
      attempt: "k1",
      agent_id: "agent-builder",
      workspace_id: "wks-builder",
    });
    ensurePhase(store, "Attention");
    store.lease.release(run.holderId);

    const worktree = makeTempDir("miah-resolve-ws-");
    seedBuilderWorktree(worktree, "U1", 1, ["src/hello.ts"]);
    const seenCommands: string[] = [];
    const { code } = await captureRunResolve(
      run.runId,
      raised.escalation_id,
      "approve",
      undefined,
      run.basePath,
      run.config,
      {
        adapter: adapterFor(run, worktree),
        canonicalWorktree: makeTempDir("miah-resolve-canonical-"),
        // No verificationCommandsFor: the parsed contract supplies `npm test`.
        runCommand: async (command, cwd) => {
          seenCommands.push(command);
          return { command, exit_code: 0, stdout: "ok\n", stderr: "" };
        },
      },
    );
    expect(code).toBe(0);
    expect(seenCommands).toContain("npm test");
    expect(store.replay().state.units.U1.status).toBe("accepted");
  });
});
