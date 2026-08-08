import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Journal,
  JournalCorruptionError,
  readJournalFile,
  repairJournalTail,
} from "../src/journal";
import { LeaseNotHeldError } from "../src/lease";
import { DEFAULT_CONFIG } from "../src/types";
import { cleanupTempDirs, createTestStore, makeTempDir, type TestStore } from "./helpers";

afterEach(cleanupTempDirs);

describe("journal", () => {
  it("appends JSONL events with global monotonic seq; lease acquire journals seq 1 (R35)", () => {
    const t: TestStore = createTestStore();
    const acquired = t.store.lease.acquire("holder-A");
    expect(acquired.ok).toBe(true);

    const a = t.store.journal.append("holder-A", "phase_transition", { from: "Admitting", to: "Ready" });
    const b = t.store.journal.append("holder-A", "acceptance_decision", { unit_id: "U1", decision: "accept" });

    expect(a.seq).toBe(2);
    expect(b.seq).toBe(3);
    expect(a.type).toBe("phase_transition");
    expect(typeof a.timestamp).toBe("number");

    const lines = fs.readFileSync(t.layout.journalPath, "utf8").trimEnd().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ seq: 1, type: "lease_acquired", holder_id: "holder-A" });
    expect(JSON.parse(lines[1])).toMatchObject({ seq: 2, type: "phase_transition", from: "Admitting" });
    expect(JSON.parse(lines[2])).toMatchObject({ seq: 3, unit_id: "U1", decision: "accept" });
  });

  it("is append-only: a new Journal instance sees the existing seq and continues", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");
    t.store.journal.append("holder-A", "run_start", { run_id: "r1", plan_hash: "h1" });
    t.store.journal.append("holder-A", "phase_transition", { to: "Ready" });

    const fresh = new Journal(t.layout.journalPath, {
      verifyHolder: (id) => t.store.lease.assertActiveHolder(id),
      now: t.clock.fn,
    });
    expect(fresh.currentSeq()).toBe(3);
    const third = fresh.append("holder-A", "acceptance_decision", { unit_id: "U1", decision: "accept" });
    expect(third.seq).toBe(4);
    expect(fresh.readEvents()).toHaveLength(4);
  });

  it("refuses append from a non-lease-holder (single-writer, R15/R34)", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");

    const other = new Journal(t.layout.journalPath, {
      verifyHolder: (id) => t.store.lease.assertActiveHolder(id),
      now: t.clock.fn,
    });
    expect(() => other.append("holder-B", "dispatch_intent", { unit_id: "U1" })).toThrow(
      LeaseNotHeldError,
    );

    t.store.journal.append("holder-A", "dispatch_intent", { unit_id: "U1" });
    expect(t.store.journal.readEvents()).toHaveLength(2);
  });

  it("refuses append when no lease is held at all", () => {
    const t: TestStore = createTestStore();
    expect(() => t.store.journal.append("holder-A", "run_start", {})).toThrow(LeaseNotHeldError);
  });

  it("refuses append after the lease is released (single-writer remains enforced)", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");
    t.store.journal.append("holder-A", "run_start", { run_id: "r1", plan_hash: "h1" });
    t.store.lease.release("holder-A");
    expect(() => t.store.journal.append("holder-A", "phase_transition", { to: "Stopping" })).toThrow(
      LeaseNotHeldError,
    );
  });

  it("ignores a malformed trailing line on read and restores the last complete event on repair", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");
    const first = t.store.journal.append("holder-A", "run_start", { run_id: "r1", plan_hash: "h1" });
    const second = t.store.journal.append("holder-A", "phase_transition", { to: "Ready" });
    expect(first.seq).toBe(2);
    expect(second.seq).toBe(3);

    // Simulate a crash mid-append: a partial trailing line with no newline.
    fs.appendFileSync(
      t.layout.journalPath,
      `{"seq":4,"type":"dispatch_intent","timestamp":5,"unit_id":"U`,
      "utf8",
    );

    const before = readJournalFile(t.layout.journalPath);
    expect(before.truncated).toBe(true);
    expect(before.events.map((e) => e.seq)).toEqual([1, 2, 3]);

    expect(repairJournalTail(t.layout.journalPath)).toBe(true);
    const after = readJournalFile(t.layout.journalPath);
    expect(after.truncated).toBe(false);
    expect(after.events.map((e) => e.seq)).toEqual([1, 2, 3]);

    // The next append continues from the restored last complete event (seq 3).
    const third = t.store.journal.append("holder-A", "acceptance_decision", { unit_id: "U1", decision: "accept" });
    expect(third.seq).toBe(4);
    expect(t.store.journal.readEvents().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("treats a malformed non-tail line as corruption, never silent data loss", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");
    t.store.journal.append("holder-A", "run_start", { run_id: "r1", plan_hash: "h1" });
    t.store.journal.append("holder-A", "phase_transition", { to: "Ready" });
    t.store.journal.append("holder-A", "acceptance_decision", { unit_id: "U1", decision: "accept" });

    const lines = fs.readFileSync(t.layout.journalPath, "utf8").trimEnd().split(/\r?\n/);
    fs.writeFileSync(t.layout.journalPath, `${lines[0]}\nNOT-JSON\n${lines[3]}\n`, "utf8");

    expect(() => readJournalFile(t.layout.journalPath)).toThrow(JournalCorruptionError);
    expect(() => repairJournalTail(t.layout.journalPath)).toThrow(JournalCorruptionError);
  });

  it("repairing an all-malformed single partial line yields an empty journal", () => {
    const dir = makeTempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    fs.writeFileSync(journalPath, `{"seq":1,"type":"run_start",`, "utf8");
    expect(repairJournalTail(journalPath)).toBe(true);
    expect(fs.readFileSync(journalPath, "utf8")).toBe("");
    expect(readJournalFile(journalPath).events).toEqual([]);
  });

  it("writes derived-state snapshots every K=50 events storing derived state only (R41, D7-a)", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");

    // 25 cycles × 4 events = 100 events → snapshots at seq 50 and 100.
    for (let i = 1; i <= 25; i++) {
      t.store.append("dispatch_intent", {
        unit_id: "U1",
        role: "builder",
        take: i,
        idempotency_key: `k-${i}`,
        packet_hash: `ph-${i}`,
        deadline: `deadline-${i}`,
        provider: "codex",
        model: "gpt-5.4",
        raw_context: `RAW-SPECIALIST-PROSE-${i}-${"x".repeat(96)}`,
      });
      t.store.append("dispatch_created", {
        unit_id: "U1",
        agent_id: `agent-${i}`,
        workspace_id: `ws-${i}`,
        base_commit: `bc-${i}`,
      });
      t.store.append("dispatch_terminated", { unit_id: "U1", outcome: "success" });
      t.store.append("acceptance_decision", { unit_id: "U1", decision: "accept" });
    }

    const snapshotFiles = fs
      .readdirSync(t.layout.snapshotsDir)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    expect(snapshotFiles).toEqual(["state-50.json", "state-100.json"]);

    const snapshot = JSON.parse(
      fs.readFileSync(path.join(t.layout.snapshotsDir, "state-50.json"), "utf8"),
    );
    expect(snapshot.seq).toBe(50);
    // Derived state only (R41, D7-a): statuses/ids/phase — the raw payload field
    // `raw_context` must never be stored.
    expect(Object.keys(snapshot).sort()).toEqual(
      ["in_flight_intents", "open_gaps", "phase", "plan_hash", "run_id", "seq", "terminal", "units"].sort(),
    );
    expect(Object.keys(snapshot.units.U1).sort()).toEqual(
      ["last_acceptance", "rework_cycles", "status", "takes"].sort(),
    );
    expect(JSON.stringify(snapshot)).not.toContain("RAW-SPECIALIST-PROSE");
  });

  it("uses a configurable cadence other than the default 50", () => {
    const t: TestStore = createTestStore({
      config: { ...DEFAULT_CONFIG, journal: { snapshot_cadence: 3 } },
    });
    t.store.lease.acquire("holder-A");
    for (let i = 0; i < 8; i++) {
      t.store.append("phase_transition", { to: `P${i}` });
    }
    // lease_acquired is seq 1, then 8 transitions → seqs 2..9; cadence 3 hits 3, 6, 9.
    const files = fs
      .readdirSync(t.layout.snapshotsDir)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    expect(files).toEqual(["state-3.json", "state-6.json", "state-9.json"]);
  });
});
