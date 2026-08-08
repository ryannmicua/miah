/**
 * U8 FSM tests (KTD14, R64, R35; audit U8.12).
 *
 * The run-phase machine: Admitting → Ready → Implementing → Reviewing →
 * AwaitingApproval → Complete, plus Attention and Stopping (reachable from any
 * phase). Transitions are journaled as `phase_transition` events; replay
 * derives the run phase from them (R42).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePhase,
  hasReworkMarkedUnits,
  INITIAL_PHASE_SENTINEL,
  isValidTransition,
  RUN_PHASES,
  transitionPhase,
} from "../src/fsm";
import { emptyDerivedState } from "../src/replay";
import { cleanupTempDirs, createTestStore, type TestStore } from "./helpers";

function setupStore(): TestStore {
  const t = createTestStore({ holderId: "holder-A" });
  const acquired = t.store.lease.acquire("holder-A");
  if (!acquired.ok) {
    throw new Error(`lease acquire failed: ${acquired.reason}`);
  }
  return t;
}

function acceptedUnit(): { status: "accepted"; takes: number; rework_cycles: number; last_acceptance: "accept" } {
  return { status: "accepted", takes: 1, rework_cycles: 0, last_acceptance: "accept" };
}

function reworkUnit(): { status: "rework"; takes: number; rework_cycles: number; last_acceptance: "not_accepted" } {
  return { status: "rework", takes: 1, rework_cycles: 1, last_acceptance: "not_accepted" };
}

function notStartedUnit(): { status: "not_started"; takes: number; rework_cycles: number; last_acceptance: null } {
  return { status: "not_started", takes: 0, rework_cycles: 0, last_acceptance: null };
}

function stateWithUnits(
  units: Record<string, ReturnType<typeof acceptedUnit>>,
): ReturnType<typeof emptyDerivedState> {
  return { ...emptyDerivedState(), units };
}

/** Walk a store through the happy path into AwaitingApproval. */
function driveToAwaitingApproval(t: TestStore): void {
  transitionPhase(t.store, "Admitting", "Ready");
  transitionPhase(t.store, "Ready", "Implementing");
  transitionPhase(t.store, "Implementing", "Reviewing");
  transitionPhase(t.store, "Reviewing", "AwaitingApproval");
  t.store.append("acceptance_decision", { unit_id: "U1", decision: "accept" });
}

afterEach(cleanupTempDirs);

describe("fsm", () => {
  it("defines the KTD14 phase set: Admitting, Ready, Implementing, Reviewing, AwaitingApproval, Attention, Stopping, Complete (U8.12)", () => {
    expect([...RUN_PHASES].sort()).toEqual(
      [
        "Admitting",
        "Ready",
        "Implementing",
        "Reviewing",
        "AwaitingApproval",
        "Attention",
        "Stopping",
        "Complete",
      ].sort(),
    );
  });

  it("permits the KTD14 happy-path transitions", () => {
    expect(isValidTransition("Admitting", "Ready")).toBe(true);
    expect(isValidTransition("Ready", "Implementing")).toBe(true);
    expect(isValidTransition("Implementing", "Reviewing")).toBe(true);
    expect(isValidTransition("Reviewing", "Implementing")).toBe(true);
    expect(isValidTransition("Reviewing", "AwaitingApproval")).toBe(true);
    expect(isValidTransition("AwaitingApproval", "Complete")).toBe(true);
    // The initial sentinel phase may open the machine.
    expect(isValidTransition(INITIAL_PHASE_SENTINEL, "Ready")).toBe(true);
    expect(isValidTransition(INITIAL_PHASE_SENTINEL, "Admitting")).toBe(true);
  });

  it("permits any→Attention and any→Stopping", () => {
    for (const from of [...RUN_PHASES, INITIAL_PHASE_SENTINEL]) {
      expect(isValidTransition(from, "Attention")).toBe(true);
      expect(isValidTransition(from, "Stopping")).toBe(true);
    }
  });

  it("rejects invalid transitions (never silently corrupt phase history)", () => {
    expect(isValidTransition("Ready", "AwaitingApproval")).toBe(false);
    expect(isValidTransition("Implementing", "Ready")).toBe(false);
    expect(isValidTransition("AwaitingApproval", "Implementing")).toBe(false);
    expect(isValidTransition("Complete", "Ready")).toBe(false);
    expect(isValidTransition("Complete", "Implementing")).toBe(false);
    expect(isValidTransition("Implementing", "Complete")).toBe(false);
    expect(isValidTransition("unknown-phase", "Ready")).toBe(false);
  });

  it("transitionPhase journals a phase_transition event with from/to (R35)", () => {
    const t = setupStore();
    const event = transitionPhase(t.store, "Admitting", "Ready");
    expect(event).not.toBeNull();
    expect(event).toMatchObject({ type: "phase_transition", from: "Admitting", to: "Ready" });
    // Replay derives the phase from the event.
    expect(t.store.replay().state.phase).toBe("Ready");
  });

  it("transitionPhase is a no-op (no append) when from === to", () => {
    const t = setupStore();
    transitionPhase(t.store, "Ready", "Implementing");
    const before = t.store.journal.currentSeq();
    const result = transitionPhase(t.store, "Implementing", "Implementing");
    expect(result).toBeNull();
    expect(t.store.journal.currentSeq()).toBe(before);
  });

  it("transitionPhase throws on an invalid transition (no partial journal write)", () => {
    const t = setupStore();
    const before = t.store.journal.currentSeq();
    expect(() => transitionPhase(t.store, "Ready", "AwaitingApproval")).toThrow(
      /invalid phase transition/,
    );
    expect(t.store.journal.currentSeq()).toBe(before);
  });

  it("ensurePhase transitions from the run's current reconstructed phase", () => {
    const t = setupStore();
    transitionPhase(t.store, "Admitting", "Ready");
    const event = ensurePhase(t.store, "Implementing");
    expect(event).toMatchObject({ type: "phase_transition", from: "Ready", to: "Implementing" });
    expect(t.store.replay().state.phase).toBe("Implementing");
  });

  it("a full single-unit run journals ready → implementing → reviewing → awaitingApproval (U8.4 FSM leg)", () => {
    const t = setupStore();
    transitionPhase(t.store, "Admitting", "Ready");
    transitionPhase(t.store, "Ready", "Implementing");
    transitionPhase(t.store, "Implementing", "Reviewing");
    transitionPhase(t.store, "Reviewing", "AwaitingApproval");
    const phases = t.store
      .journal
      .readEvents()
      .filter((event) => event.type === "phase_transition")
      .map((event) => event.to);
    expect(phases).toEqual(["Ready", "Implementing", "Reviewing", "AwaitingApproval"]);
    expect(t.store.replay().state.phase).toBe("AwaitingApproval");
  });

  it("the phase survives a replay-from-scratch (R42 reconstruction)", () => {
    const t = setupStore();
    transitionPhase(t.store, "Admitting", "Ready");
    transitionPhase(t.store, "Ready", "Attention");
    const { state } = t.store.replay();
    expect(state.phase).toBe("Attention");
  });

  it("AwaitingApproval → Ready is NOT allowed without rework-marked units (R67)", () => {
    expect(isValidTransition("AwaitingApproval", "Ready")).toBe(false);
    const allAccepted = stateWithUnits({ U1: acceptedUnit() });
    expect(isValidTransition("AwaitingApproval", "Ready", allAccepted)).toBe(false);
    const emptyState = emptyDerivedState();
    expect(isValidTransition("AwaitingApproval", "Ready", emptyState)).toBe(false);
  });

  it("AwaitingApproval → Ready IS allowed when rework-marked units exist (R67)", () => {
    const withRework = stateWithUnits({ U1: acceptedUnit(), U2: reworkUnit() });
    expect(isValidTransition("AwaitingApproval", "Ready", withRework)).toBe(true);

    const withNotStarted = stateWithUnits({ U1: acceptedUnit(), U2: notStartedUnit() });
    expect(isValidTransition("AwaitingApproval", "Ready", withNotStarted)).toBe(true);
  });

  it("AwaitingApproval → Complete remains the normal gate exit regardless of units (R67)", () => {
    const withRework = stateWithUnits({ U1: acceptedUnit(), U2: reworkUnit() });
    expect(isValidTransition("AwaitingApproval", "Complete", withRework)).toBe(true);
    expect(isValidTransition("AwaitingApproval", "Complete")).toBe(true);
  });

  it("hasReworkMarkedUnits is true for rework or not_started, false otherwise", () => {
    expect(hasReworkMarkedUnits(stateWithUnits({ U1: acceptedUnit() }))).toBe(false);
    expect(hasReworkMarkedUnits(emptyDerivedState())).toBe(false);
    expect(hasReworkMarkedUnits(stateWithUnits({ U1: reworkUnit() }))).toBe(true);
    expect(hasReworkMarkedUnits(stateWithUnits({ U1: notStartedUnit() }))).toBe(true);
  });

  it("transitionPhase journals AwaitingApproval → Ready when rework-marked units exist (R67)", () => {
    const t = setupStore();
    driveToAwaitingApproval(t);
    t.store.append("rework_started", { unit_id: "U1", via: "operator-reject" });
    expect(t.store.stateSnapshot().units.U1.status).toBe("rework");

    const event = transitionPhase(t.store, "AwaitingApproval", "Ready");
    expect(event).toMatchObject({ type: "phase_transition", from: "AwaitingApproval", to: "Ready" });
    expect(t.store.replay().state.phase).toBe("Ready");
  });

  it("transitionPhase throws on AwaitingApproval → Ready without rework-marked units (no partial journal write)", () => {
    const t = setupStore();
    driveToAwaitingApproval(t);
    expect(t.store.stateSnapshot().units.U1.status).toBe("accepted");

    const before = t.store.journal.currentSeq();
    expect(() => transitionPhase(t.store, "AwaitingApproval", "Ready")).toThrow(
      /invalid phase transition/,
    );
    expect(t.store.journal.currentSeq()).toBe(before);
    expect(t.store.replay().state.phase).toBe("AwaitingApproval");
  });

  it("ensurePhase resumes a gate-sitting run with rework-marked units via AwaitingApproval → Ready", () => {
    const t = setupStore();
    driveToAwaitingApproval(t);
    t.store.append("rework_started", { unit_id: "U1", via: "amendment" });

    const event = ensurePhase(t.store, "Ready");
    expect(event).toMatchObject({ type: "phase_transition", from: "AwaitingApproval", to: "Ready" });
    expect(t.store.replay().state.phase).toBe("Ready");
  });
});
