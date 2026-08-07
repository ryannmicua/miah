/**
 * U8 step-function tests (R14, R37, R75-R81; audit U8.4-U8.8, U8.11, U8.14).
 *
 * The step function: reconstruct state → reconcile intents → evaluate budget
 * predicates → find eligible units → dispatch within the concurrency cap →
 * poll in-flight → harvest → accept → integrate → transition phase. Every
 * dispatch runs against the scripted in-memory adapter (no real agents).
 */
import * as fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import { fastConfig, cleanupTempDirs } from "./helpers";
import {
  configureTerminalAdapter,
  driveSteps,
  failRunner,
  makeUnit,
  seedBuilderWorktree,
  setupHarness,
  type StepHarness,
} from "./helpers/step-harness";

afterEach(cleanupTempDirs);

describe("step", () => {
  it("drives one unit through the full cycle: ready → implement → review → accept → awaitingApproval (U8.4)", async () => {
    const h = setupHarness(
      { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
      { seed: (w) => seedBuilderWorktree(w, "U1", 1, ["src/hello.ts"]) },
    );
    configureTerminalAdapter(h);

    const { outcomes } = await driveSteps(h);

    // Step 0 dispatches the builder; the next step terminates, harvests, accepts.
    expect(outcomes[0].dispatched).toEqual([{ unit_id: "U1", take: 1 }]);
    const last = outcomes[outcomes.length - 1];
    expect(last.harvested).toEqual([{ unit_id: "U1", take: 1, role: "builder" }]);
    expect(last.accepted).toEqual([{ unit_id: "U1" }]);
    expect(last.escalated).toHaveLength(0);

    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.units.U1.last_acceptance).toBe("accept");
    expect(state.open_gaps).toHaveLength(0);
    expect(state.phase).toBe("AwaitingApproval");

    // The FSM leg appears in journal order (U8.4).
    const transitions = h.t.store.journal
      .readEvents()
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
      (e) => e.type === "dispatch_intent" && e.unit_id === "U2",
    )?.seq;
    expect(u1Accept).toBeDefined();
    expect(u2Intent).toBeDefined();
    expect(u1Accept as number).toBeLessThan(u2Intent as number);
    // U2 never went in-flight before U1 was accepted.
    const u2Created = events.find((e) => e.type === "dispatch_created" && e.unit_id === "U2")?.seq;
    expect(u2Created as number).toBeGreaterThan(u1Accept as number);
  });

  it("two independent units under cap=1 run sequentially: U1 finishes before U2 starts (R75, U8.6)", async () => {
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
    const u1Intent = events.find((e) => e.type === "dispatch_intent" && e.unit_id === "U1")?.seq;
    const u1Accept = events.find(
      (e) => e.type === "acceptance_decision" && e.unit_id === "U1",
    )?.seq;
    const u1Terminated = events.find(
      (e) => e.type === "dispatch_terminated" && e.unit_id === "U1",
    )?.seq;
    const u2Intent = events.find((e) => e.type === "dispatch_intent" && e.unit_id === "U2")?.seq;
    expect(u1Intent).toBeLessThan(u1Accept as number);
    expect(u1Terminated as number).toBeLessThan(u2Intent as number);
    // U2's dispatch happens strictly after U1 was accepted.
    expect(u1Accept as number).toBeLessThan(u2Intent as number);
    expect(h.t.store.replay().state.phase).toBe("AwaitingApproval");
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
    const intents = events.filter((e) => e.type === "dispatch_intent" && e.unit_id === "U1");
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
