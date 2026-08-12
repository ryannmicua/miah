import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyEvent,
  deriveState,
  emptyDerivedState,
  readStateSnapshot,
  replayFromSnapshot,
  writeStateSnapshot,
} from "../src/replay";
import { JournalCorruptionError } from "../src/journal";
import {
  cleanupTempDirs,
  createTestStore,
  makeEvent,
  makeUnits,
  buildScenarioEvents,
} from "./helpers";

afterEach(cleanupTempDirs);

/** The precise 17-event stream whose derived state we assert exactly. */
function preciseEvents() {
  const intent = (unit: string, take: number) => ({
    unit_id: unit,
    role: "builder",
    take,
    idempotency_key: `k-${unit}-${take}`,
    packet_hash: "ph",
    deadline: "deadline",
    provider: "codex",
    model: "gpt-5.4",
  });
  return [
    makeEvent(1, "run_start", { run_id: "r1", plan_hash: "h1" }),
    makeEvent(2, "phase_transition", { from: "Admitting", to: "Ready" }),
    makeEvent(3, "dispatch_intent", intent("U1", 1)),
    makeEvent(4, "dispatch_created", { unit_id: "U1", agent_id: "ag-1", workspace_id: "ws-1", base_commit: "bc-1" }),
    makeEvent(5, "dispatch_terminated", { unit_id: "U1", outcome: "success" }),
    makeEvent(6, "acceptance_decision", { unit_id: "U1", decision: "accept" }),
    makeEvent(7, "dispatch_intent", intent("U2", 1)),
    makeEvent(8, "gap_recorded", { unit_id: "U2", criterion: "c1", reason: "missing test output" }),
    makeEvent(9, "dispatch_failed", { unit_id: "U2", reason: "adapter error", idempotency_key: "k-U2-1" }),
    makeEvent(10, "rework_started", { unit_id: "U2" }),
    makeEvent(11, "dispatch_intent", intent("U2", 2)),
    makeEvent(12, "dispatch_created", { unit_id: "U2", agent_id: "ag-2", workspace_id: "ws-2", base_commit: "bc-2" }),
    makeEvent(13, "dispatch_terminated", { unit_id: "U2", outcome: "success" }),
    makeEvent(14, "gap_closed", { unit_id: "U2", criterion: "c1", close_reason: "harvested" }),
    makeEvent(15, "acceptance_decision", { unit_id: "U2", decision: "accept" }),
    makeEvent(16, "dispatch_intent", intent("U3", 1)),
    makeEvent(17, "phase_transition", { from: "Implementing", to: "Reviewing" }),
  ];
}

describe("replay", () => {
  it("reconstructs derived state exactly: acceptance, in-flight intents, gaps, phase (R42)", () => {
    const state = deriveState(preciseEvents(), { units: makeUnits() });

    expect(state.seq).toBe(17);
    expect(state.run_id).toBe("r1");
    expect(state.plan_hash).toBe("h1");
    expect(state.phase).toBe("Reviewing");
    expect(state.terminal).toBeNull();

    expect(state.units.U1).toEqual({ status: "accepted", takes: 1, rework_cycles: 0, last_acceptance: "accept", verifier_attempts: 0 });
    expect(state.units.U2).toEqual({ status: "accepted", takes: 2, rework_cycles: 1, last_acceptance: "accept", verifier_attempts: 0 });
    // U3 has an open intent and no created/terminated: still in flight.
    expect(state.units.U3).toMatchObject({ status: "in_flight", takes: 1 });

    expect(state.in_flight_intents).toEqual([
      {
        seq: 16,
        unit_id: "U3",
        role: "builder",
        take: 1,
        idempotency_key: "k-U3-1",
        packet_hash: "ph",
        deadline: "deadline",
        provider: "codex",
        model: "gpt-5.4",
        agent_id: null,
        workspace_id: null,
        base_commit: null,
      },
    ]);

    expect(state.open_gaps).toEqual([]);
  });

  it("keeps an unclosed gap open and derives blocked from the dependency graph", () => {
    // Through U2's second dispatch; gap never closed, U2 never accepted.
    const events = preciseEvents().slice(0, 13);
    const state = deriveState(events, { units: makeUnits() });
    expect(state.open_gaps).toEqual([
      { unit_id: "U2", criterion: "c1", reason: "missing test output", recorded_seq: 8 },
    ]);
    expect(state.units.U1.status).toBe("accepted");
    // U2's second take terminated successfully but was never accepted: the
    // candidate now awaits verification (KTD5), not a fresh builder dispatch.
    expect(state.units.U2.status).toBe("awaiting_verification");
    expect(state.units.U2.rework_cycles).toBe(1);
    expect(state.units.U2.verifier_attempts).toBe(0);
    expect(state.awaiting_verification.U2).toMatchObject({ take: 2, attempt: "k-U2-2", agent_id: "ag-2", workspace_id: "ws-2", base_commit: "bc-2" });
    expect(state.units.U3.status).toBe("blocked"); // U3 depends on U2, which is not accepted
  });

  it("a unit is not_started (not blocked) once its dependency is accepted", () => {
    const dispatchU1 = [
      makeEvent(1, "dispatch_intent", { unit_id: "U1", take: 1, idempotency_key: "k" }),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "a", workspace_id: "w", base_commit: "b" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1" }),
    ];
    const units = makeUnits();

    // U1 dispatched but not yet accepted → U1 not_started, U2 and U3 blocked.
    const partial = deriveState(dispatchU1, { units });
    expect(partial.units.U1.status).toBe("not_started");
    expect(partial.units.U2.status).toBe("blocked");
    expect(partial.units.U3.status).toBe("blocked");

    // U1 accepted → U2 unblocks (but U3 is still blocked on U2).
    const acceptU1 = deriveState(
      [...dispatchU1, makeEvent(4, "acceptance_decision", { unit_id: "U1", decision: "accept" })],
      { units },
    );
    expect(acceptU1.units.U1.status).toBe("accepted");
    expect(acceptU1.units.U2.status).toBe("not_started");
    expect(acceptU1.units.U3.status).toBe("blocked");

    // U2 accepted too → U3 unblocks to not_started.
    const acceptU2 = deriveState(
      [
        ...dispatchU1,
        makeEvent(4, "acceptance_decision", { unit_id: "U1", decision: "accept" }),
        makeEvent(5, "dispatch_intent", { unit_id: "U2", take: 1, idempotency_key: "k2" }),
        makeEvent(6, "dispatch_created", { unit_id: "U2", agent_id: "a", workspace_id: "w", base_commit: "b" }),
        makeEvent(7, "dispatch_terminated", { unit_id: "U2" }),
        makeEvent(8, "acceptance_decision", { unit_id: "U2", decision: "accept" }),
      ],
      { units },
    );
    expect(acceptU2.units.U2.status).toBe("accepted");
    expect(acceptU2.units.U3.status).toBe("not_started");
  });

  it("deriving without a units graph does not invent blocked statuses", () => {
    const events = preciseEvents();
    const state = deriveState(events);
    expect(state.units.U3.status).toBe("in_flight");
    expect(state.units.U1.status).toBe("accepted");
  });

  it("append 100 events; replay reconstructs all statuses correctly (U3.4)", () => {
    const t = createTestStore();
    fs.writeFileSync(t.layout.unitsJsonPath, JSON.stringify(makeUnits()));
    t.store.lease.acquire("holder-A");
    for (const s of buildScenarioEvents(100)) {
      t.store.append(s.type, s.payload);
    }

    // lease_acquired is seq 1; the 100 scenario events are seqs 2..101, so the
    // latest snapshot (seq 100) leaves exactly one tail event to scan.
    const replay = t.store.replay();
    expect(replay.scanned).toBe(1);
    expect(replay.snapshotSeq).toBe(100);

    const full = deriveState(t.store.journal.readEvents(), { units: makeUnits() });
    expect(JSON.stringify(replay.state)).toBe(JSON.stringify(full));
    expect(replay.state.seq).toBe(101);
    for (const unit of ["U1", "U2", "U3"]) {
      expect(["accepted", "in_flight", "rework", "blocked", "not_started", "awaiting_verification", "verifying"]).toContain(
        replay.state.units[unit]?.status,
      );
    }
  });

  it("snapshot at seq 50; replay from snapshot is identical to full replay (U3.5, R42)", () => {
    const t = createTestStore();
    fs.writeFileSync(t.layout.unitsJsonPath, JSON.stringify(makeUnits()));
    t.store.lease.acquire("holder-A");
    const scenario = buildScenarioEvents(60);
    for (const s of scenario) {
      t.store.append(s.type, s.payload);
    }

    // Snapshot exists at seq 50; the tail 51..61 must be scanned (lease event
    // at seq 1 shifts the scenario to 2..61).
    expect(fs.existsSync(path.join(t.layout.snapshotsDir, "state-50.json"))).toBe(true);
    const replay = replayFromSnapshot({
      journalPath: t.layout.journalPath,
      snapshotsDir: t.layout.snapshotsDir,
      units: makeUnits(),
    });
    expect(replay.snapshotSeq).toBe(50);
    expect(replay.scanned).toBe(11);

    const full = deriveState(t.store.journal.readEvents(), { units: makeUnits() });
    expect(JSON.stringify(replay.state)).toBe(JSON.stringify(full));
    expect(replay.state.seq).toBe(61);
  });

  it("a torn/unreadable snapshot degrades to a full journal replay", () => {
    const t = createTestStore();
    t.store.lease.acquire("holder-A");
    for (const s of buildScenarioEvents(60)) {
      t.store.append(s.type, s.payload);
    }
    // A "latest" snapshot that does not parse: replay must fall back to the journal.
    fs.writeFileSync(`${t.layout.snapshotsDir}/state-999.json`, "NOT-JSON", "utf8");

    const replay = replayFromSnapshot({
      journalPath: t.layout.journalPath,
      snapshotsDir: t.layout.snapshotsDir,
    });
    expect(replay.snapshotSeq).toBeNull();
    expect(replay.scanned).toBe(61); // lease_acquired + 60 scenario events
    const full = deriveState(t.store.journal.readEvents());
    expect(JSON.stringify(replay.state)).toBe(JSON.stringify(full));
  });

  it("writeStateSnapshot writes derived state only and readStateSnapshot reads it back", () => {
    const t = createTestStore();
    const state = deriveState(preciseEvents(), { units: makeUnits() });
    const filePath = writeStateSnapshot(state, t.layout.snapshotsDir);
    expect(filePath.endsWith("state-17.json")).toBe(true);

    const info = readStateSnapshot(t.layout.snapshotsDir);
    expect(info?.seq).toBe(17);
    expect(JSON.stringify(info?.state)).toBe(JSON.stringify(state));
  });

  it("rejects duplicate or out-of-order seq as corruption", () => {
    const events = [
      makeEvent(1, "run_start", {}),
      makeEvent(2, "acceptance_decision", { unit_id: "U1", decision: "accept" }),
      makeEvent(2, "acceptance_decision", { unit_id: "U1", decision: "accept" }),
    ];
    expect(() => deriveState(events)).toThrow(JournalCorruptionError);

    const outOfOrder = [
      makeEvent(2, "run_start", {}),
      makeEvent(1, "run_start", {}),
    ];
    expect(() => deriveState(outOfOrder)).toThrow(JournalCorruptionError);
  });

  it("applyEvent is deterministic and idempotent-friendly on an empty state", () => {
    const state = applyEvent(emptyDerivedState(), makeEvent(1, "run_start", { run_id: "r", plan_hash: "h" }));
    expect(state).toEqual({
      seq: 1,
      phase: "not-started",
      run_id: "r",
      plan_hash: "h",
      terminal: null,
      units: {},
      in_flight_intents: [],
      open_gaps: [],
      awaiting_verification: {},
      criterion_grades: {},
    });
  });
});

describe("role-aware dispatch replay (KTD5)", () => {
  const intent = (unit: string, take: number, role = "builder") => ({
    unit_id: unit,
    role,
    take,
    idempotency_key: `k-${unit}-${take}`,
    packet_hash: "ph",
    deadline: "deadline",
    provider: "codex",
    model: "gpt-5.4",
  });

  it("U2.AC1: a successful builder termination preserves the candidate and derives awaiting_verification", () => {
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "ag-1", workspace_id: "ws-1", base_commit: "bc-1" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("awaiting_verification");
    expect(state.units.U1.takes).toBe(1);
    expect(state.awaiting_verification.U1).toEqual({
      take: 1,
      attempt: "k-U1-1",
      agent_id: "ag-1",
      workspace_id: "ws-1",
      base_commit: "bc-1",
      deadline: "deadline",
      envelope_path: ".miah/envelope-builder-U1-t1.json",
    });
    expect(state.in_flight_intents).toHaveLength(0);
  });

  it("U2.AC1: a non-success builder termination does not preserve a candidate", () => {
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "ag-1", workspace_id: "ws-1" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1", outcome: "envelope-missing", idempotency_key: "k-U1-1" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("not_started");
    expect(state.awaiting_verification.U1).toBeUndefined();
  });

  it("U2.AC2: verifier intent derives verifying without incrementing builder takes", () => {
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "ag-1", workspace_id: "ws-1" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
      makeEvent(4, "dispatch_intent", intent("U1", 1, "verifier")),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("verifying");
    expect(state.units.U1.takes).toBe(1);
    expect(state.awaiting_verification.U1).toBeDefined();
    expect(state.in_flight_intents).toHaveLength(1);
    expect(state.in_flight_intents[0].role).toBe("verifier");
  });

  it("U2.AC2: verifier termination returns to awaiting_verification; launch failures count as verifier attempts, not builder takes", () => {
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "ag-1", workspace_id: "ws-1" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
      makeEvent(4, "dispatch_intent", intent("U1", 1, "verifier")),
      makeEvent(5, "dispatch_failed", { unit_id: "U1", role: "verifier", idempotency_key: "k-U1-1" }),
      makeEvent(6, "dispatch_intent", intent("U1", 1, "verifier")),
      makeEvent(7, "dispatch_created", { unit_id: "U1", agent_id: "ag-v", workspace_id: "ws-1" }),
      makeEvent(8, "dispatch_terminated", { unit_id: "U1", outcome: "invalid-result", idempotency_key: "k-U1-1" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("awaiting_verification");
    expect(state.units.U1.takes).toBe(1); // builder takes unchanged
    expect(state.units.U1.rework_cycles).toBe(0); // no rework from verifier attempts
    expect(state.units.U1.verifier_attempts).toBe(2);
    expect(state.awaiting_verification.U1).toMatchObject({ take: 1, workspace_id: "ws-1" });
    expect(state.in_flight_intents).toHaveLength(0);
  });

  it("U2.AC2: a valid verifier success does not count as a failed attempt", () => {
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "ag-1", workspace_id: "ws-1" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
      makeEvent(4, "dispatch_intent", intent("U1", 1, "verifier")),
      makeEvent(5, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("awaiting_verification");
    expect(state.units.U1.verifier_attempts).toBe(0);
  });

  it("U2.AC3: roleless historical events correlate to their intent and derive builder semantics", () => {
    // Historical journal: intent carries role; created/terminated do not.
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "ag-1", workspace_id: "ws-1", base_commit: "bc-1" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1", outcome: "success" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("awaiting_verification");
    expect(state.awaiting_verification.U1).toMatchObject({ take: 1, agent_id: "ag-1" });
  });

  it("U2.AC3: roleless historical events without a correlatable intent default to builder, not awaiting", () => {
    // A lone historical terminated with no intent and no outcome: the KTD5
    // builder fallback applies, but a missing outcome never preserves a
    // candidate.
    const events = [makeEvent(1, "dispatch_terminated", { unit_id: "U1" })];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("not_started");
    expect(state.awaiting_verification.U1).toBeUndefined();
  });

  it("U2.AC3: historical reviewer journals remain readable and replayable", () => {
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1, "reviewer")),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "ag-r", workspace_id: "ws-r" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1", outcome: "success" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    // Reviewer is the historical verifier (KTD8/R17): a reviewer termination
    // derives verifier semantics — the unit returns to awaiting_verification
    // and is never reset to not_started. No builder candidate exists in this
    // journal, so none is preserved.
    expect(state.units.U1.status).toBe("awaiting_verification");
    expect(state.awaiting_verification.U1).toBeUndefined();
    expect(state.in_flight_intents).toHaveLength(0);
  });

  it("U2.AC3: a historical reviewer termination does not clobber the awaiting-verification candidate", () => {
    // Builder take 1 preserves the frozen candidate; the historical reviewer
    // (pre-rename verifier) terminates after it. The reviewer termination must
    // replay as verifier-equivalent: candidate preserved, unit stays
    // awaiting_verification, never reset to not_started (R17/KTD8).
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_created", { unit_id: "U1", agent_id: "ag-1", workspace_id: "ws-1", base_commit: "bc-1" }),
      makeEvent(3, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
      makeEvent(4, "dispatch_intent", intent("U1", 1, "reviewer")),
      makeEvent(5, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("awaiting_verification");
    expect(state.awaiting_verification.U1).toMatchObject({ take: 1, attempt: "k-U1-1", agent_id: "ag-1" });
    expect(state.units.U1.takes).toBe(1); // reviewer termination never adds a builder take
    expect(state.in_flight_intents).toHaveLength(0);
  });

  it("U2.AC3: rework_started consumes the candidate and resets verifier attempts", () => {
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
      makeEvent(3, "dispatch_intent", intent("U1", 1, "verifier")),
      makeEvent(4, "dispatch_failed", { unit_id: "U1", role: "verifier", idempotency_key: "k-U1-1" }),
      makeEvent(5, "rework_started", { unit_id: "U1" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("rework");
    expect(state.units.U1.verifier_attempts).toBe(0);
    expect(state.awaiting_verification.U1).toBeUndefined();
  });

  it("acceptance consumes the candidate", () => {
    const events = [
      makeEvent(1, "dispatch_intent", intent("U1", 1)),
      makeEvent(2, "dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k-U1-1" }),
      makeEvent(3, "acceptance_decision", { unit_id: "U1", decision: "accept" }),
    ];
    const state = deriveState(events, { units: makeUnits() });
    expect(state.units.U1.status).toBe("accepted");
    expect(state.awaiting_verification.U1).toBeUndefined();
  });
});
