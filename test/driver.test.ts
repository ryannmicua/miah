/**
 * U8 driver tests (R3, R65-R67, R75-R79; audit U8.4, U8.7-U8.10).
 *
 * The driver acquires the lease, reconstructs + reconciles, loops the step
 * function until a stop condition, and releases the lease on every clean exit.
 * `--once` runs one step and exits. All specialists are scripted (injected
 * adapter) — no real agent is ever dispatched.
 */
import * as fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import { runDriver, writeStopRequested, readStopRequested } from "../src/driver";
import { createStepRuntime, runStep } from "../src/step";
import { cleanupTempDirs, fastConfig } from "./helpers";
import {
  configureTerminalAdapter,
  defaultVerifierEnvelope,
  makeUnit,
  passRunner,
  seedBuilderWorktree,
  setupHarness,
  stepContext,
  type StepHarness,
} from "./helpers/step-harness";

afterEach(cleanupTempDirs);

function driverOptions(h: StepHarness) {
  return {
    store: h.t.store,
    holderId: h.holderId,
    config: h.config,
    adapter: h.adapter,
    repoRoot: h.repoRoot,
    canonicalWorktree: h.canonicalWorktree,
    runCommand: passRunner,
    verifierEnvelopeFor: defaultVerifierEnvelope,
    now: h.clock.fn,
  };
}

function singleUnitHarness(lifecycle = "idle", opts: { seedTakes?: number[] } = {}): StepHarness {
  const takes = opts.seedTakes ?? [1];
  const h = setupHarness(
    { U1: makeUnit("U1", 1, { creates: ["src/hello.ts"] }) },
    {
      seed: (w) => {
        for (const take of takes) {
          seedBuilderWorktree(w, "U1", take, ["src/hello.ts"]);
        }
      },
    },
  );
  configureTerminalAdapter(h, { lifecycle });
  return h;
}

describe("driver", () => {
  it("loops one unit to completion: all accepted → AwaitingApproval → approval package → lease released (U8.4, R67)", async () => {
    const h = singleUnitHarness();
    const result = await runDriver(driverOptions(h));

    expect(result.status).toBe("complete");
    expect(result.phase).toBe("AwaitingApproval");
    expect(result.stepsRun).toBeGreaterThan(0);
    expect(result.approvalPackagePath).not.toBeNull();
    expect(fs.existsSync(result.approvalPackagePath as string)).toBe(true);

    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.phase).toBe("AwaitingApproval");

    // The approval package carries the run id, per-unit acceptance, usage, plan hash.
    const pkg = JSON.parse(fs.readFileSync(result.approvalPackagePath as string, "utf8"));
    expect(pkg.schema).toBe("miah/approval-package/v1");
    expect(pkg.run_id).toBe(h.t.layout.runId);
    expect(pkg.units.U1.status).toBe("accepted");
    expect(typeof pkg.plan_hash).toBe("string");
    expect(pkg.usage).toBeDefined();

    // The lease was released: a resumer can acquire immediately.
    expect(h.t.store.lease.holderId()).toBeNull();
    const reacquire = h.t.store.lease.acquire(h.holderId);
    expect(reacquire.ok).toBe(true);
  });

  it("stop requested at a step boundary → terminate in-flight → Stopping → lease released (R65, U8.9)", async () => {
    const h = singleUnitHarness("running");
    // A prior session left U1 in-flight (dispatch done, no terminal event yet).
    const runtime = createStepRuntime();
    const outcome = await runStep(stepContext(h), runtime);
    expect(outcome.dispatched).toEqual([{ unit_id: "U1", take: 1 }]);
    expect(h.t.store.replay().state.in_flight_intents).toHaveLength(1);

    // Operator records a stop while the driver is not running.
    writeStopRequested(h.t.layout);
    const result = await runDriver(driverOptions(h));

    expect(result.status).toBe("stopped");
    // The in-flight specialist was terminated via the adapter.
    expect(h.adapter.stopCalls.map((handle) => handle.agentId)).toContain("agent-1");
    const events = h.t.store.journal.readEvents();
    expect(events.some((e) => e.type === "phase_transition" && e.to === "Stopping")).toBe(true);
    expect(events.some((e) => e.type === "dispatch_terminated" && e.outcome === "stopped")).toBe(
      true,
    );
    // No new dispatch was created for the stopped run.
    expect(events.filter((e) => e.type === "dispatch_intent")).toHaveLength(1);
    // The flag was consumed and the lease released.
    expect(readStopRequested(h.t.layout)).toBe(false);
    expect(h.t.store.lease.holderId()).toBeNull();
    expect(h.t.store.replay().state.phase).toBe("Stopping");
  });

  it("a stop recorded while no driver is alive is honored on the next run, then a later run resumes (R65)", async () => {
    const h = singleUnitHarness("running", { seedTakes: [1, 2] });
    // Leave U1 in-flight, then request a stop while no driver is alive.
    const runtime = createStepRuntime();
    await runStep(stepContext(h), runtime);
    writeStopRequested(h.t.layout);

    const stopped = await runDriver(driverOptions(h));
    expect(stopped.status).toBe("stopped");
    expect(h.t.store.replay().state.phase).toBe("Stopping");

    // A subsequent run resumes from Stopping: the stopped unit gets a fresh take.
    configureTerminalAdapter(h, { lifecycle: "idle" });
    const resumed = await runDriver(driverOptions(h));
    expect(resumed.status).toBe("complete");
    expect(h.t.store.replay().state.units.U1.status).toBe("accepted");
    const intents = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U1");
    expect(intents).toHaveLength(2); // take 1 stopped, take 2 fresh
  });

  it("run --once advances one step and exits; the next --once continues (D6-a, U8.10)", async () => {
    const h = singleUnitHarness("running", { seedTakes: [1] });

    const first = await runDriver({ ...driverOptions(h), once: true });
    expect(first.status).toBe("advanced");
    expect(first.stepsRun).toBe(1);
    // U1 was dispatched and is in flight; nothing was accepted yet.
    const afterFirst = h.t.store.replay().state;
    expect(afterFirst.in_flight_intents).toHaveLength(1);
    expect(afterFirst.units.U1.status).toBe("in_flight");
    // The lease was released after the single step.
    expect(h.t.store.lease.holderId()).toBeNull();

    // The specialist finishes while the driver is dead; the next --once resumes.
    configureTerminalAdapter(h, { lifecycle: "idle" });
    const second = await runDriver({ ...driverOptions(h), once: true });
    expect(second.status).toBe("complete");
    expect(h.t.store.replay().state.units.U1.status).toBe("accepted");
    expect(h.t.store.replay().state.phase).toBe("AwaitingApproval");
    expect(h.t.store.lease.holderId()).toBeNull();
  });

  it("no-progress via the driver: 3 unchanged polls → Attention, escalation printed, lease released (R76, U8.7)", async () => {
    const h = singleUnitHarness("running");
    const result = await runDriver(driverOptions(h));

    expect(result.status).toBe("attention");
    expect(result.phase).toBe("Attention");
    expect(result.stepsRun).toBe(3);
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].trigger).toBe("no-progress");
    expect(result.escalations[0].unit_id).toBe("U1");
    expect(result.message).toContain("no-progress");
    expect(h.t.store.lease.holderId()).toBeNull();
  });

  it("max takes via the driver: 3rd failed take → repeatedly-fails → Attention, lease released (R77, U8.8)", async () => {
    const h = singleUnitHarness("idle");
    h.adapter.launchError = new Error("paseo run failed: MISSING_PROVIDER");

    const result = await runDriver(driverOptions(h));

    expect(result.status).toBe("attention");
    expect(result.phase).toBe("Attention");
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].trigger).toBe("repeatedly-fails");
    expect(result.escalations[0].reason).toContain("max takes exceeded");
    expect(h.t.store.replay().state.units.U1.takes).toBe(3);
    expect(h.t.store.lease.holderId()).toBeNull();
  });

  it("two dependent units complete end-to-end through the driver with the concurrency cap enforced (R14, R75)", async () => {
    const h = setupHarness(
      {
        U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
        U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b.ts"] }),
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

    const result = await runDriver(driverOptions(h));
    expect(result.status).toBe("complete");
    expect(result.phase).toBe("AwaitingApproval");
    const state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.units.U2.status).toBe("accepted");

    const events = h.t.store.journal.readEvents();
    const u1Accept = events.find((e) => e.type === "acceptance_decision" && e.unit_id === "U1")?.seq;
    const u2Intent = events.find((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U2")?.seq;
    expect(u1Accept as number).toBeLessThan(u2Intent as number);
  });

  it("a run already in AwaitingApproval resumes as complete without advancing a step", async () => {
    const h = singleUnitHarness();
    const first = await runDriver(driverOptions(h));
    expect(first.status).toBe("complete");

    // Resuming an already-complete (AwaitingApproval) run reports complete again.
    const second = await runDriver(driverOptions(h));
    expect(second.status).toBe("complete");
    expect(second.stepsRun).toBe(0);
  });

  it("a fresh run with no units available blocks with an R66 escalation rather than looping forever", async () => {
    // A harness whose only unit never becomes eligible: U2 blocked on a missing U1.
    const h = setupHarness({
      U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b.ts"] }),
    });
    configureTerminalAdapter(h);

    const result = await runDriver(driverOptions(h));
    expect(result.status).toBe("attention");
    expect(result.phase).toBe("Attention");
    expect(result.escalations.some((e) => e.trigger === "blocked-no-eligible-work")).toBe(true);
    expect(h.t.store.lease.holderId()).toBeNull();
  });

  it("reject --rework at AwaitingApproval: next run resumes, re-dispatches the marked unit, and completes (R67)", async () => {
    const h = setupHarness(
      {
        U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
        U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b.ts"] }),
      },
      {
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/a.ts"]);
          seedBuilderWorktree(w, "U2", 1, ["src/b.ts"]);
          seedBuilderWorktree(w, "U2", 2, ["src/b.ts"]);
        },
      },
    );
    configureTerminalAdapter(h);

    // Drive both units to acceptance -> AwaitingApproval.
    const first = await runDriver(driverOptions(h));
    expect(first.status).toBe("complete");
    expect(first.phase).toBe("AwaitingApproval");

    // The operator rejects U2 for rework at the gate (the durable marking
    // `miah reject --rework` writes: operator_decision + rework_started).
    const acquired = h.t.store.lease.acquire(h.holderId);
    expect(acquired.ok).toBe(true);
    h.t.store.append("operator_decision", {
      operator: "test-operator",
      decision: "reject",
      rework_units: ["U2"],
      end: null,
    });
    h.t.store.append("rework_started", { unit_id: "U2", via: "operator-reject" });
    h.t.store.lease.release(h.holderId);

    let state = h.t.store.replay().state;
    expect(state.phase).toBe("AwaitingApproval");
    expect(state.units.U2.status).toBe("rework");
    expect(state.units.U1.status).toBe("accepted");

    // The next `miah run` resumes instead of exiting at the gate.
    const resumed = await runDriver(driverOptions(h));
    expect(resumed.status).toBe("complete");
    expect(resumed.phase).toBe("AwaitingApproval");

    state = h.t.store.replay().state;
    expect(state.units.U2.status).toBe("accepted");
    expect(state.units.U1.status).toBe("accepted");
    // U2 was re-dispatched (take 2) and completed, not just marked.
    const intents = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U2");
    expect(intents).toHaveLength(2);
    const phaseEvents = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "phase_transition" && e.to === "Ready");
    expect(phaseEvents.some((e) => e.from === "AwaitingApproval")).toBe(true);
    expect(h.t.store.lease.holderId()).toBeNull();
  });

  it("amend at AwaitingApproval: next run resumes, re-dispatches the affected unit, and completes (R67)", async () => {
    const h = setupHarness(
      {
        U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
        U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b.ts"] }),
      },
      {
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/a.ts"]);
          seedBuilderWorktree(w, "U2", 1, ["src/b.ts"]);
          seedBuilderWorktree(w, "U2", 2, ["src/b.ts"]);
        },
      },
    );
    configureTerminalAdapter(h);

    const first = await runDriver(driverOptions(h));
    expect(first.status).toBe("complete");
    expect(first.phase).toBe("AwaitingApproval");

    // The operator amends at the gate: affected accepted units are durably
    // marked for re-dispatch (rework_started, via amendment) while the phase
    // stays AwaitingApproval (runAmend's durable marking).
    const acquired = h.t.store.lease.acquire(h.holderId);
    expect(acquired.ok).toBe(true);
    h.t.store.append("operator_decision", { operator: "test-operator", decision: "amend" });
    h.t.store.append("amendment_applied", {
      new_hash: "b".repeat(64),
      previous_hash: "a".repeat(64),
      version: 2,
      changed_units: ["U2"],
      affected_units: ["U2"],
    });
    h.t.store.append("rework_started", { unit_id: "U2", via: "amendment" });
    h.t.store.lease.release(h.holderId);

    let state = h.t.store.replay().state;
    expect(state.phase).toBe("AwaitingApproval");
    expect(state.units.U2.status).toBe("rework");

    const resumed = await runDriver(driverOptions(h));
    expect(resumed.status).toBe("complete");
    expect(resumed.phase).toBe("AwaitingApproval");

    state = h.t.store.replay().state;
    expect(state.units.U2.status).toBe("accepted");
    expect(state.units.U1.status).toBe("accepted");
    const intents = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U2");
    expect(intents).toHaveLength(2);
    expect(h.t.store.lease.holderId()).toBeNull();
  });
});
