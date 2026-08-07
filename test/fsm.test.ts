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
  INITIAL_PHASE_SENTINEL,
  isValidTransition,
  RUN_PHASES,
  transitionPhase,
} from "../src/fsm";
import { cleanupTempDirs, createTestStore, type TestStore } from "./helpers";

function setupStore(): TestStore {
  const t = createTestStore({ holderId: "holder-A" });
  const acquired = t.store.lease.acquire("holder-A");
  if (!acquired.ok) {
    throw new Error(`lease acquire failed: ${acquired.reason}`);
  }
  return t;
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
});
