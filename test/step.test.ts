/**
 * U8 step-function tests (R14, R37, R75-R81; audit U8.4-U8.8, U8.11, U8.14)
 * plus the U5 verifier lifecycle (KTD5/KTD6): builder harvest -> verifier
 * dispatch into the frozen candidate -> custodied v2 grades -> predicate.
 *
 * The step function: reconstruct state → reconcile intents → evaluate budget
 * predicates → find eligible units → dispatch within the concurrency cap →
 * poll in-flight → harvest → grade → accept → integrate → transition phase.
 * Every dispatch runs against the scripted in-memory adapter (no real agents).
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createStepRuntime, runStep } from "../src/step";
import { writeCalibrationProfile } from "../src/calibration";
import { fastConfig, cleanupTempDirs, makeTempDir } from "./helpers";
import {
  configureTerminalAdapter,
  defaultVerifierEnvelope,
  driveSteps,
  failRunner,
  makeUnit,
  seedBuilderWorktree,
  setupHarness,
  stepContext,
  type StepHarness,
} from "./helpers/step-harness";

afterEach(cleanupTempDirs);

describe("step", () => {
  it("drives one unit through the full cycle: ready → implement → verify → accept → awaitingApproval (U8.4, KTD5)", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);

    const { outcomes } = await driveSteps(h);

    // Step 0 dispatches the builder; later steps terminate, harvest, dispatch
    // the verifier, harvest its result, and accept.
    expect(outcomes[0].dispatched).toEqual([{ unit_id: "U1", take: 1 }]);
    const harvested = outcomes.flatMap((o) => o.harvested);
    expect(harvested).toEqual([
      { unit_id: "U1", take: 1, role: "builder" },
      { unit_id: "U1", take: 1, role: "verifier" },
    ]);
    expect(outcomes.some((o) => o.accepted.length > 0)).toBe(true);
    expect(outcomes.every((o) => o.escalated.length === 0)).toBe(true);

    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.units.U1.last_acceptance).toBe("accept");
    expect(state.units.U1.verifier_attempts).toBe(0);
    expect(state.open_gaps).toHaveLength(0);
    expect(state.phase).toBe("AwaitingApproval");

    // Only the verifier's envelope entries produced the grades (KTD6): Miah
    // never created a grade.
    const grades = state.criterion_grades.U1;
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({
      criterion_id: "U1.AC1",
      grade: "pass",
      source: "verifier",
    });

    // The verifier was dispatched into the builder's observed workspace (KTD3)
    // and no reviewer was ever dispatched (KTD8).
    const events = h.t.store.journal.readEvents();
    const verifierIntents = events.filter(
      (e) => e.type === "dispatch_intent" && e.role === "verifier",
    );
    expect(verifierIntents).toHaveLength(1);
    const builderCreated = events.find((e) => e.type === "dispatch_created" && e.role === "builder");
    const verifierCreated = events.find(
      (e) => e.type === "dispatch_created" && e.role === "verifier",
    );
    expect(verifierCreated?.workspace_id).toBe(builderCreated?.workspace_id);
    expect(events.some((e) => e.role === "reviewer")).toBe(false);

    // The FSM leg appears in journal order (U8.4): Ready, Implementing,
    // Reviewing, AwaitingApproval.
    const transitions = events
      .filter((event) => event.type === "phase_transition")
      .map((event) => event.to);
    expect(transitions).toEqual(["Ready", "Implementing", "Reviewing", "AwaitingApproval"]);
  });

  it("follows the step-function order in the journal: intent → created → envelope → terminated → evidence → acceptance (U8.11)", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);
    await driveSteps(h);

    const events = h.t.store.journal.readEvents();
    const seqOf = (type: string, unit?: string): number => {
      const event = events.find(
        (e) => e.type === type && (unit === undefined || e.unit_id === unit),
      );
      return event?.seq ?? -1;
    };
    expect(seqOf("dispatch_intent", "U1")).toBeGreaterThan(0);
    expect(seqOf("dispatch_intent", "U1")).toBeLessThan(seqOf("dispatch_created", "U1"));
    expect(seqOf("dispatch_created", "U1")).toBeLessThan(seqOf("result_envelope_observed", "U1"));
    expect(seqOf("result_envelope_observed", "U1")).toBeLessThan(seqOf("dispatch_terminated", "U1"));
    expect(seqOf("dispatch_terminated", "U1")).toBeLessThan(seqOf("evidence_harvested", "U1"));
    expect(seqOf("evidence_harvested", "U1")).toBeLessThan(seqOf("acceptance_decision", "U1"));
    // Acceptance is journaled only after the evidence was harvested.
    expect(seqOf("acceptance_decision", "U1")).toBeGreaterThan(0);
  });

  it("U2 depends on U1: U1 is accepted before U2 is dispatched (R14, U8.5)", async () => {
    const h = setupHarness(
      {
        U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
        U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b.ts"] }),
      },
      {
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/a.ts"]);
          seedBuilderWorktree(w, "U2", 1, ["src/b.ts"]);
        },
      },
    );
    configureTerminalAdapter(h);

    const { outcomes } = await driveSteps(h);
    expect(outcomes[outcomes.length - 1].accepted).toEqual([{ unit_id: "U2" }]);

    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.units.U2.status).toBe("accepted");
    expect(state.phase).toBe("AwaitingApproval");

    const events = h.t.store.journal.readEvents();
    const u1Accept = events.find(
      (e) => e.type === "acceptance_decision" && e.unit_id === "U1",
    )?.seq;
    const u2Intent = events.find(
      (e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U2",
    )?.seq;
    expect(u1Accept).toBeDefined();
    expect(u2Intent).toBeDefined();
    expect(u1Accept as number).toBeLessThan(u2Intent as number);
    // U2 never went in-flight before U1 was accepted.
    const u2Created = events.find((e) => e.type === "dispatch_created" && e.unit_id === "U2")?.seq;
    expect(u2Created as number).toBeGreaterThan(u1Accept as number);
  });

  it("two independent units under cap=1 dispatch sequentially; verification of U1 does not block U2's builder (R75, U8.6)", async () => {
    const h = setupHarness(
      {
        U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
        U2: makeUnit("U2", 2, { creates: ["src/b.ts"] }),
      },
      {
        config: fastConfig({ run: { concurrency_cap: 1 } }),
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/a.ts"]);
          seedBuilderWorktree(w, "U2", 1, ["src/b.ts"]);
        },
      },
    );
    configureTerminalAdapter(h);

    const { outcomes } = await driveSteps(h);
    // The concurrency cap was never exceeded: at most one dispatch per step.
    for (const outcome of outcomes) {
      expect(outcome.dispatched.length).toBeLessThanOrEqual(1);
    }

    const events = h.t.store.journal.readEvents();
    const seqOf = (type: string, unit?: string): number => {
      const event = events.find(
        (e) => e.type === type && (unit === undefined || e.unit_id === unit),
      );
      return event?.seq ?? -1;
    };
    const u1Intent = seqOf("dispatch_intent", "U1");
    const u1Terminated = seqOf("dispatch_terminated", "U1");
    const u2Intent = seqOf("dispatch_intent", "U2");
    // Independent units: U2's builder dispatches only after U1's builder
    // terminated (cap=1 on dispatches), even while U1 awaits verification.
    expect(u1Intent).toBeLessThan(u1Terminated);
    expect(u1Terminated).toBeLessThan(u2Intent);
    expect(h.t.store.replay().state.phase).toBe("AwaitingApproval");
    expect(h.t.store.replay().state.units.U1.status).toBe("accepted");
    expect(h.t.store.replay().state.units.U2.status).toBe("accepted");
  });

  it("no-progress: 3 unchanged polls → escalation_raised: no-progress → Attention (R76, U8.7)", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    // The specialist stays "running" with an unchanged lifecycle/usage.
    configureTerminalAdapter(h, { lifecycle: "running" });

    const { outcomes } = await driveSteps(h);
    const last = outcomes[outcomes.length - 1];
    expect(last.escalated).toHaveLength(1);
    expect(last.escalated[0].trigger).toBe("no-progress");
    expect(last.escalated[0].reason).toContain("3 consecutive polls");

    const state = h.t.store.replay().state;
    expect(state.phase).toBe("Attention");
    const raised = h.t.store.journal
      .readEvents()
      .find((e) => e.type === "escalation_raised");
    expect(raised).toMatchObject({ trigger: "no-progress", unit_id: "U1" });
    // The unit was not terminated: the run pauses with it still in-flight.
    expect(state.in_flight_intents.some((i) => i.unit_id === "U1")).toBe(true);
  });

  it("no-progress does not carry across a session boundary: a fresh runtime resets the poll streak (R76, L4)", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    // The specialist stays "running" with an unchanged lifecycle/usage.
    configureTerminalAdapter(h, { lifecycle: "running" });
    const ctx = stepContext(h);

    // Session 1: dispatch + first unchanged poll in one step, then a second
    // unchanged poll — streak = 2, just below the 3-poll escalation threshold
    // (fastConfig's no_progress_polls).
    const runtime1 = createStepRuntime();
    const first = await runStep(ctx, runtime1);
    expect(first.dispatched).toEqual([{ unit_id: "U1", take: 1 }]);
    await runStep(ctx, runtime1); // unchanged poll 2
    expect(runtime1.noProgressByUnit.get("U1")).toBe(2);
    expect(h.t.store.replay().state.phase).not.toBe("Attention");

    // Session 2 (a fresh runtime, as after driver downtime): one more unchanged
    // poll must NOT escalate — the streak restarts at 1 in the new session.
    const runtime2 = createStepRuntime();
    const resumed = await runStep(ctx, runtime2);
    expect(resumed.escalated).toHaveLength(0);
    expect(runtime2.noProgressByUnit.get("U1")).toBe(1);
    expect(h.t.store.replay().state.phase).not.toBe("Attention");
    // The unit was never terminated; it stays in-flight for the new session.
    expect(
      h.t.store.replay().state.in_flight_intents.some((i) => i.unit_id === "U1"),
    ).toBe(true);
  });

  it("max takes exceeded: the 3rd failed take → escalation_raised: repeatedly-fails (R77, U8.8)", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    h.adapter.launchError = new Error("paseo run failed: MISSING_PROVIDER");

    const { outcomes } = await driveSteps(h);
    // 3 dispatch attempts, then the take budget escalates.
    const last = outcomes[outcomes.length - 1];
    expect(last.escalated).toHaveLength(1);
    expect(last.escalated[0].trigger).toBe("repeatedly-fails");
    expect(last.escalated[0].reason).toContain("max takes exceeded");

    const state = h.t.store.replay().state;
    expect(state.phase).toBe("Attention");
    expect(state.units.U1.takes).toBe(3);
    const raised = h.t.store.journal
      .readEvents()
      .find((e) => e.type === "escalation_raised");
    expect(raised).toMatchObject({ trigger: "repeatedly-fails", unit_id: "U1" });
  });

  it("rework bound: max 2 rework cycles → escalation_raised: repeatedly-fails (R78, U8.14)", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      {
        // Rework exhausts before takes so the R78 path is the one that fires.
        config: fastConfig({ run: { max_takes: 5, max_rework_cycles: 2 } }),
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]);
          seedBuilderWorktree(w, "U1", 2, ["src/hello.ts"]);
          seedBuilderWorktree(w, "U1", 3, ["src/hello.ts"]);
        },
        runCommand: failRunner,
        verificationCommandsFor: () => ["npm test"],
      },
    );
    configureTerminalAdapter(h);

    const { outcomes } = await driveSteps(h);
    const last = outcomes[outcomes.length - 1];
    expect(last.escalated).toHaveLength(1);
    expect(last.escalated[0].trigger).toBe("repeatedly-fails");
    expect(last.escalated[0].reason).toContain("rework cycles exceeded");

    const events = h.t.store.journal.readEvents();
    const reworkStarts = events.filter((e) => e.type === "rework_started");
    expect(reworkStarts).toHaveLength(2);
    const state = h.t.store.replay().state;
    expect(state.units.U1.rework_cycles).toBe(2);
    expect(state.phase).toBe("Attention");
  });

  it("a failed acceptance routes to bounded rework: rework_started is journaled and the unit re-dispatches on a fresh take", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      {
        config: fastConfig({ run: { max_takes: 5, max_rework_cycles: 2 } }),
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]);
          seedBuilderWorktree(w, "U1", 2, ["src/hello.ts"]);
          seedBuilderWorktree(w, "U1", 3, ["src/hello.ts"]);
        },
        runCommand: failRunner,
        verificationCommandsFor: () => ["npm test"],
      },
    );
    configureTerminalAdapter(h);

    const { outcomes } = await driveSteps(h);
    expect(outcomes.some((o) => o.reworked.length > 0)).toBe(true);
    expect(h.t.store.replay().state.units.U1.rework_cycles).toBeGreaterThan(0);

    const events = h.t.store.journal.readEvents();
    const reworkStarts = events.filter((e) => e.type === "rework_started");
    expect(reworkStarts.length).toBeGreaterThan(0);
    // A fresh take was dispatched after the rework (the unit stayed eligible).
    const intents = events.filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U1");
    expect(intents.length).toBeGreaterThan(1);
  });

  it("a dispatch failure under budget keeps the unit eligible for a fresh take next step", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      {
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]);
          seedBuilderWorktree(w, "U1", 2, ["src/hello.ts"]);
        },
      },
    );
    // Fail the first launch only; the second succeeds.
    let calls = 0;
    h.adapter.onLaunch = () => {
      calls += 1;
      if (calls === 1) {
        h.adapter.launchError = new Error("transient adapter failure");
      } else {
        h.adapter.launchError = null;
        h.adapter.launchResult = { agentId: "agent-1", cwd: h.worktree, workspaceId: "wks_1" };
        h.adapter.statusFor = () => "idle";
        h.adapter.inspectFor = () => ({
          agentId: "agent-1",
          lifecycle: "idle",
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
          mode: "default",
          cwd: h.worktree,
          usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
          capabilities: {},
        });
      }
    };

    const { outcomes } = await driveSteps(h);
    // The failed take did not escalate and did not block: the run completed.
    expect(h.t.store.replay().state.units.U1.status).toBe("accepted");
    expect(h.t.store.replay().state.phase).toBe("AwaitingApproval");
    expect(outcomes.some((o) => o.dispatchFailed.length > 0)).toBe(true);
    expect(outcomes.some((o) => o.accepted.length > 0)).toBe(true);
  });
});

describe("verifier lifecycle (U5)", () => {
  function unitWith(acceptance: Array<{ id: string; text: string; tier: string }>): ReturnType<typeof makeUnit> {
    return makeUnit("U1", 1, { creates: ["src/hello.ts"], acceptance });
  }

  it("U5.AC2: every non-human criterion reaches the predicate only from a valid custodied verifier grade", async () => {
    const h = setupHarness(
      { U1: unitWith([{ id: "U1.AC1", text: "behaves per contract", tier: "deterministic" }]) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    const grades = state.criterion_grades.U1;
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({ criterion_id: "U1.AC1", source: "verifier", grade: "pass" });
    // The grades are durable journal references (KTD6) so resume re-evaluates
    // without parsing specialist prose.
    const recorded = h.t.store.journal
      .readEvents()
      .find((e) => e.type === "criterion_grades_recorded");
    expect(recorded?.grades).toEqual(grades);
    // The verifier result was custodied BEFORE the predicate read it (KTD4).
    const events = h.t.store.journal.readEvents();
    const verifierHarvest = events.find(
      (e) => e.type === "evidence_harvested" && e.role === "verifier",
    )?.seq ?? -1;
    const gradesSeq = events.find((e) => e.type === "criterion_grades_recorded")?.seq ?? -1;
    const decisionSeq = events.find((e) => e.type === "acceptance_decision")?.seq ?? -1;
    expect(verifierHarvest).toBeLessThan(gradesSeq);
    expect(gradesSeq).toBeLessThan(decisionSeq);
  });

  it("U5.AC3: deterministic certification needs no calibration profile (KD6)", async () => {
    const h = setupHarness(
      {
        U1: unitWith([
          { id: "U1.AC1", text: "mechanical", tier: "deterministic" },
          { id: "U1.AC2", text: "judged", tier: "calibrated-judge" },
        ]),
      },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    const grades = state.criterion_grades.U1;
    expect(grades.find((g) => g.criterion_id === "U1.AC1")).toMatchObject({
      grade: "pass",
      basis: expect.stringContaining("verifier-certified"),
    });
    // The calibrated verdict is ungraded (no profile) and escalates (R48).
    expect(grades.find((g) => g.criterion_id === "U1.AC2")).toMatchObject({
      grade: "ungraded",
      route: "escalate",
      basis: expect.stringContaining("verifier-not-calibrated"),
    });
    expect(state.phase).toBe("Attention");
    const raised = h.t.store.journal
      .readEvents()
      .find((e) => e.type === "escalation_raised");
    expect(raised?.trigger).toBe("no-checker-profile-clears-calibration-bar");
  });

  it("U5.AC3: a cleared calibration profile makes the calibrated-judge verdict authoritative", async () => {
    const base = makeTempDir();
    writeCalibrationProfile(base, {
      schema: "miah/calibration-profile/v1",
      provider: "opencode",
      model: "opencode-go/glm-5.2",
      tiers: {
        "calibrated-judge": Array.from({ length: 15 }, (_, i) => ({
          label: i % 2 === 0 ? ("pass" as const) : ("fail" as const),
          verdict: i % 2 === 0 ? ("pass" as const) : ("fail" as const),
        })),
      },
    });
    const h = setupHarness(
      {
        U1: unitWith([
          { id: "U1.AC1", text: "mechanical", tier: "deterministic" },
          { id: "U1.AC2", text: "judged", tier: "calibrated-judge" },
        ]),
      },
      { calibrationBasePath: base, seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    const grades = state.criterion_grades.U1;
    expect(grades.find((g) => g.criterion_id === "U1.AC2")).toMatchObject({
      grade: "pass",
      route: null,
      basis: expect.stringContaining("calibrated-verifier-verdict"),
    });
  });

  it("U5.AC3: a verifier-declared ungraded verdict escalates on deterministic and calibrated-judge criteria (KTD4/R48)", async () => {
    const h = setupHarness(
      {
        U1: unitWith([
          { id: "U1.AC1", text: "mechanical", tier: "deterministic" },
          { id: "U1.AC2", text: "judged", tier: "calibrated-judge" },
        ]),
      },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    h.verifierEnvelopeFor = (opts) => ({
      ...defaultVerifierEnvelope(opts),
      grades: [
        {
          criterion_id: "U1.AC1",
          declared_tier: "deterministic",
          verdict: "ungraded" as const,
          basis: "evidence insufficient for a mechanical certification",
          flagged_for_human: false,
          evidence: [],
        },
        {
          criterion_id: "U1.AC2",
          declared_tier: "calibrated-judge",
          verdict: "ungraded" as const,
          basis: "no basis for a judgment",
          flagged_for_human: false,
          evidence: [],
        },
      ],
    });
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    // The verifier's own ungraded declaration is preserved and routes to
    // escalation on both tiers — never converted to a rework-grade null.
    const grades = state.criterion_grades.U1;
    expect(grades.find((g) => g.criterion_id === "U1.AC1")).toMatchObject({
      grade: "ungraded",
      route: "escalate",
      basis: "verifier-ungraded: mechanical evidence insufficient",
    });
    expect(grades.find((g) => g.criterion_id === "U1.AC2")).toMatchObject({
      grade: "ungraded",
      route: "escalate",
      basis: "verifier-ungraded: judgment unavailable",
    });
    // The escalation pauses the run for the operator; no builder rework started.
    expect(state.units.U1.status).not.toBe("accepted");
    expect(state.units.U1.rework_cycles).toBe(0);
    expect(state.phase).toBe("Attention");
    expect(
      h.t.store.journal.readEvents().some((e) => e.type === "escalation_raised"),
    ).toBe(true);
  });

  it("U5.AC4: a human-tier criterion cannot pass by substitution and stays escalated until an operator grade", async () => {
    const h = setupHarness(
      { U1: unitWith([{ id: "U1.AC1", text: "operator decides", tier: "human" }]) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    // The verifier omitted the human criterion; no grade was recorded, the
    // unit is not accepted, and the run pauses for the operator.
    expect(state.units.U1.status).not.toBe("accepted");
    expect(state.criterion_grades.U1 ?? []).toHaveLength(0);
    expect(state.phase).toBe("Attention");
    const raised = h.t.store.journal
      .readEvents()
      .find((e) => e.type === "escalation_raised");
    // KTD7: a declared-human criterion escalates with missing-access-or-judgment.
    expect(raised?.trigger).toBe("missing-access-or-judgment");
  });

  it("U5.AC5: a valid verifier fail grade routes to bounded builder rework, not a verifier retry", async () => {
    const h = setupHarness(
      { U1: unitWith([{ id: "U1.AC1", text: "behaves per contract", tier: "deterministic" }]) },
      {
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]);
          seedBuilderWorktree(w, "U1", 2, ["src/hello.ts"]);
        },
        verifierEnvelopeFor: (opts) => {
          // The first frozen candidate (take 1) is graded fail; take 2 passes.
          if (opts.take === 1) {
            return {
              ...defaultVerifierEnvelope(opts),
              grades: [
                {
                  criterion_id: "U1.AC1",
                  declared_tier: "deterministic",
                  verdict: "fail" as const,
                  basis: "commands did not all pass",
                  flagged_for_human: false,
                  evidence: [],
                },
              ],
            };
          }
          return defaultVerifierEnvelope(opts);
        },
      },
    );
    configureTerminalAdapter(h);
    await driveSteps(h);

    const events = h.t.store.journal.readEvents();
    expect(events.some((e) => e.type === "rework_started" && e.unit_id === "U1")).toBe(true);
    // The fail routed to builder rework: no verifier retry on the same
    // candidate, no verifier-attempt escalation.
    expect(events.filter((e) => e.type === "verifier_attempt_failed")).toHaveLength(0);
    const state = h.t.store.replay().state;
    expect(state.units.U1.rework_cycles).toBeGreaterThan(0);
    expect(state.units.U1.takes).toBeGreaterThan(1);
    // The run still completes: take 2 passes verification.
    expect(state.units.U1.status).toBe("accepted");
  });

  it("U5.AC5: an invalid verifier result retries the same frozen candidate without spending a builder take", async () => {
    const h = setupHarness(
      { U1: unitWith([{ id: "U1.AC1", text: "behaves per contract", tier: "deterministic" }]) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    // First verifier attempt: envelope with a stale candidate binding (KTD4).
    let attempts = 0;
    h.verifierEnvelopeFor = (opts) => {
      attempts += 1;
      if (attempts === 1) {
        return { ...defaultVerifierEnvelope(opts), candidate_attempt: "stale-attempt" };
      }
      return defaultVerifierEnvelope(opts);
    };
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.units.U1.takes).toBe(1); // builder budget untouched
    expect(state.units.U1.verifier_attempts).toBe(1);
    const failed = h.t.store.journal
      .readEvents()
      .find((e) => e.type === "verifier_attempt_failed");
    expect(failed?.reason).toContain("candidate attempt mismatch");
  });

  it("U5.AC5: verifier-attempt exhaustion raises repeatedly-fails with a verifier-dispatch reason", async () => {
    const h = setupHarness(
      { U1: unitWith([{ id: "U1.AC1", text: "behaves per contract", tier: "deterministic" }]) },
      {
        config: fastConfig({ run: { max_takes: 3, max_rework_cycles: 2 } }),
        seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]),
      },
    );
    // No verifier envelope ever appears: every attempt is a failed attempt.
    h.verifierEnvelopeFor = () => null;
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    expect(state.phase).toBe("Attention");
    expect(state.units.U1.verifier_attempts).toBe(3);
    expect(state.units.U1.takes).toBe(1); // no builder takes were spent
    const raised = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "escalation_raised")
      .pop();
    expect(raised?.trigger).toBe("repeatedly-fails");
    expect(String(raised?.reason)).toContain("verifier attempts exceeded");
  });

  it("U5.AC5: the verifier-envelope seam is inert in production — a synthetic envelope never reaches disk", async () => {
    const h = setupHarness(
      { U1: unitWith([{ id: "U1.AC1", text: "behaves per contract", tier: "deterministic" }]) },
      {
        config: fastConfig({ run: { max_takes: 3, max_rework_cycles: 2 } }),
        seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    let seamCalls = 0;
    h.verifierEnvelopeFor = (opts) => {
      seamCalls += 1;
      return defaultVerifierEnvelope(opts);
    };
    configureTerminalAdapter(h);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await driveSteps(h);
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
    // Production never invokes the seam and never writes its synthetic
    // envelope to disk: every verifier attempt fails closed on the missing
    // envelope and no synthetic grade can ever be harvested (the "Miah
    // manufactures a grade" failure mode).
    expect(seamCalls).toBe(0);
    const state = h.t.store.replay().state;
    expect(state.phase).toBe("Attention");
    expect(state.units.U1.verifier_attempts).toBe(3);
    expect(state.units.U1.takes).toBe(1); // no builder takes were spent
    expect(state.criterion_grades.U1 ?? []).toHaveLength(0);
    const raised = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "escalation_raised")
      .pop();
    expect(raised?.trigger).toBe("repeatedly-fails");
    expect(String(raised?.reason)).toContain("verifier attempts exceeded");
  });

  it("U5.AC5: verifier launch failures retry the same candidate without builder takes", async () => {
    const h = setupHarness(
      { U1: unitWith([{ id: "U1.AC1", text: "behaves per contract", tier: "deterministic" }]) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    let launches = 0;
    h.adapter.onLaunch = () => {
      launches += 1;
      // Launch 1 is the builder; verifier launches 2 and 3 fail, 4 succeeds.
      h.adapter.launchError = launches >= 2 && launches <= 3 ? new Error("verifier launch failed") : null;
    };
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.units.U1.takes).toBe(1);
    expect(state.units.U1.verifier_attempts).toBe(2);
  });

  it("U5.AC7: a legacy contractless unit fails closed with scope-change-needed before any sensing", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"], verificationContract: null }) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);
    await driveSteps(h);

    const events = h.t.store.journal.readEvents();
    const raised = events.find((e) => e.type === "escalation_raised");
    expect(raised?.trigger).toBe("scope-change-needed");
    expect(String(raised?.reason)).toContain("no verification contract");
    // No commands ran (no builder evidence harvested) and no verifier was
    // dispatched: the unit stays blocked in Attention.
    expect(events.some((e) => e.type === "evidence_harvested" && e.unit_id === "U1")).toBe(false);
    expect(events.some((e) => e.role === "verifier")).toBe(false);
    expect(h.t.store.replay().state.phase).toBe("Attention");
  });

  it("U5.AC6: with no tester records, the lifecycle still completes against an explicit empty tester package", async () => {
    const h = setupHarness(
      { U1: unitWith([{ id: "U1.AC1", text: "behaves per contract", tier: "deterministic" }]) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    // The package recorded the absence explicitly (KTD2).
    const packageDir = path.join(
      h.worktree,
      ".miah",
      "verifier",
      "U1",
      "dispatch-builder-U1-t1",
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "manifest.json"), "utf8"));
    expect(manifest.tester_records).toEqual([]);
    // No tester dispatch exists anywhere in the run (F1 caveat).
    expect(
      h.t.store.journal.readEvents().some((e) => e.role === "tester"),
    ).toBe(false);
  });

  it("U5.AC1: a verifier-flagged criterion records an ungraded escalation input, not a Miah verdict", async () => {
    const h = setupHarness(
      {
        U1: unitWith([
          { id: "U1.AC1", text: "mechanical", tier: "deterministic" },
          { id: "U1.AC2", text: "judged", tier: "calibrated-judge" },
        ]),
      },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    h.verifierEnvelopeFor = (opts) => ({
      ...defaultVerifierEnvelope(opts),
      grades: [
        {
          criterion_id: "U1.AC1",
          declared_tier: "deterministic",
          verdict: "pass" as const,
          basis: "all commands passed",
          flagged_for_human: false,
          evidence: [],
        },
        {
          criterion_id: "U1.AC2",
          declared_tier: "calibrated-judge",
          verdict: "pass" as const,
          basis: "evidence is materially inadequate for a judgment",
          flagged_for_human: true,
          evidence: [],
        },
      ],
    });
    configureTerminalAdapter(h);
    await driveSteps(h);

    const state = h.t.store.replay().state;
    const flagged = state.criterion_grades.U1?.find((g) => g.criterion_id === "U1.AC2");
    expect(flagged).toMatchObject({
      grade: "ungraded",
      route: "escalate",
      basis: "verifier-flagged-for-human-judgment",
      source: "verifier",
    });
    // The unit is not accepted: the flag blocks until an operator grade (U6).
    expect(state.units.U1.status).not.toBe("accepted");
    expect(state.phase).toBe("Attention");
  });
});
