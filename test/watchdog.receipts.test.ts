/**
 * U0 tests — reap receipts (R23-R27, F2/F4/F8/F9/F10/F12).
 */
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, afterEach } from "vitest";
import {
  REAP_RECEIPT_SCHEMA,
  safeReceiptFilename,
  writeReceipt,
  readReceipt,
  listReceipts,
  matchReceipt,
  consume,
  drainReapReceipts,
  type ReapReceipt,
} from "../src/watchdog/receipts";
import type { InFlightIntent, UnitId } from "../src/types";
import { createTestStore, cleanupTempDirs, makeClock } from "./helpers";

afterEach(() => {
  cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Journal a dispatch_intent + dispatch_created so the intent is in-flight. */
function journalInFlightIntent(store: any, intent: InFlightIntent): void {
  store.append("dispatch_intent", {
    unit_id: intent.unit_id,
    role: intent.role,
    take: intent.take,
    idempotency_key: intent.idempotency_key,
    packet_hash: intent.packet_hash,
    deadline: intent.deadline,
    provider: intent.provider,
    model: intent.model,
  });
  if (intent.agent_id !== null) {
    store.append("dispatch_created", {
      unit_id: intent.unit_id,
      role: intent.role,
      take: intent.take,
      attempt: intent.idempotency_key,
      agent_id: intent.agent_id,
      workspace_id: intent.workspace_id,
      base_commit: intent.base_commit,
    });
  }
}

function makeIntent(overrides: Partial<InFlightIntent> = {}): InFlightIntent {
  return {
    seq: 1,
    unit_id: "U1",
    role: "builder",
    take: 1,
    idempotency_key: "dispatch-builder-U1-t1",
    packet_hash: "ph-abc",
    deadline: "2026-01-01T00:00:00.000Z",
    provider: "codex",
    model: "gpt-5.4",
    agent_id: "agent-123",
    workspace_id: "ws-456",
    base_commit: null,
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<ReapReceipt> = {}): ReapReceipt {
  const intent = overrides as unknown as InFlightIntent;
  const intentId = overrides.intent_id ?? "dispatch-builder-U1-t1";
  return {
    schema: REAP_RECEIPT_SCHEMA,
    intent_id: intentId,
    agent_id: overrides.agent_id ?? "agent-123",
    workspace_id: overrides.workspace_id ?? "ws-456",
    deadline: overrides.deadline ?? "2026-01-01T00:00:00.000Z",
    reap_timestamp: overrides.reap_timestamp ?? Date.now(),
    adapter_outcome: overrides.adapter_outcome ?? "terminated",
    error: overrides.error ?? null,
    unit_id: overrides.unit_id ?? "U1",
    role: overrides.role ?? "builder",
    take: overrides.take ?? 1,
    run_id: overrides.run_id ?? "run-test",
    reaper: overrides.reaper ?? "miah-wd-123",
    version: overrides.version ?? "0.1.0",
  };
}

// ---------------------------------------------------------------------------
// Safe filename sanitization (F2/F10)
// ---------------------------------------------------------------------------

describe("safeReceiptFilename", () => {
  it("sanitizes uppercase, spaces, and punctuation to lowercase with dashes", () => {
    const result = safeReceiptFilename("My Attempt Key!@#$%^&*()");
    expect(result).toMatch(/^[a-z0-9_-]+-[a-f0-9]{8}\.json$/);
    expect(result).not.toMatch(/[A-Z]/);
    expect(result).not.toMatch(/!|@|#|\$|%|\^|&|\*|\(/);
  });

  it("collapses consecutive replaced characters", () => {
    const result = safeReceiptFilename("abc   def");
    expect(result).not.toMatch(/---/);
  });

  it("trims leading and trailing dashes", () => {
    const result = safeReceiptFilename("--hello--");
    // Result is "hello-<hash>.json" — no leading dash, no double-dash before hash
    expect(result).toMatch(/^hello-[a-f0-9]{8}\.json$/);
  });

  it("prefixes reserved Windows device names", () => {
    const cases = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT9", "con", "nul"];
    for (const name of cases) {
      const result = safeReceiptFilename(name);
      expect(result.startsWith("receipt-")).toBe(true);
    }
  });

  it("does not prefix non-reserved names like con-foo", () => {
    const result = safeReceiptFilename("con-foo");
    expect(result.startsWith("receipt-")).toBe(false);
  });

  it("produces distinct filenames for two attempts with identical sanitized prefixes", () => {
    const a = "a".repeat(200) + "X";
    const b = "a".repeat(200) + "Y";
    const fa = safeReceiptFilename(a);
    const fb = safeReceiptFilename(b);
    expect(fa).not.toBe(fb);
  });

  it("caps long names to 209-char stem (200 + 1 dash + 8 hash)", () => {
    const longAttempt = "x".repeat(10000);
    const result = safeReceiptFilename(longAttempt);
    const stem = result.replace(/\.json$/, "");
    expect(stem.length).toBeLessThanOrEqual(209);
  });

  it("falls back to receipt-<hash>.json for empty sanitized string", () => {
    const result = safeReceiptFilename("!!!@@@###");
    // The sanitized string becomes "receipt" (fallback), then hash appended
    expect(result).toMatch(/^receipt-[a-f0-9]{8}\.json$/);
  });

  it("strips trailing dots and spaces", () => {
    const result = safeReceiptFilename("hello...");
    // The trailing dots are replaced by the sanitizer, result is "hello-<hash>.json"
    expect(result).toMatch(/^hello-[a-f0-9]{8}\.json$/);
    // Must not have consecutive dots before .json
    expect(result).not.toMatch(/\.\./);
  });
});

// ---------------------------------------------------------------------------
// Write and read round-trip
// ---------------------------------------------------------------------------

describe("writeReceipt / readReceipt", () => {
  it("round-trips a receipt with every field intact", () => {
    const ts = createTestStore();
    const receipt = makeReceipt();
    const filePath = writeReceipt(ts.layout.reapReceiptsDir, receipt);
    const result = readReceipt(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt).toEqual(receipt);
    }
  });

  it("writing twice for the same attempt leaves exactly one file with the second write", () => {
    const ts = createTestStore();
    const r1 = makeReceipt({ reap_timestamp: 1000 });
    const r2 = makeReceipt({ reap_timestamp: 2000 });
    writeReceipt(ts.layout.reapReceiptsDir, r1);
    writeReceipt(ts.layout.reapReceiptsDir, r2);
    const files = listReceipts(ts.layout.reapReceiptsDir);
    expect(files).toHaveLength(1);
    const readResult = readReceipt(files[0]);
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.receipt.reap_timestamp).toBe(2000);
    }
  });

  it("writing for two different attempts leaves two files", () => {
    const ts = createTestStore();
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt({ intent_id: "attempt-A" }));
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt({ intent_id: "attempt-B" }));
    expect(listReceipts(ts.layout.reapReceiptsDir)).toHaveLength(2);
  });

  it("reports a truncated file as malformed", () => {
    const ts = createTestStore();
    fs.mkdirSync(ts.layout.reapReceiptsDir, { recursive: true });
    const file = path.join(ts.layout.reapReceiptsDir, "truncated.json");
    fs.writeFileSync(file, '{"schema":"miah/reap-receipt/v1","intent_id":"x"');
    const result = readReceipt(file);
    expect(result.ok).toBe(false);
  });

  it("reports a non-receipt shape as malformed (missing intent_id)", () => {
    const ts = createTestStore();
    fs.mkdirSync(ts.layout.reapReceiptsDir, { recursive: true });
    const file = path.join(ts.layout.reapReceiptsDir, "not-receipt.json");
    fs.writeFileSync(file, JSON.stringify({ schema: REAP_RECEIPT_SCHEMA }));
    const result = readReceipt(file);
    expect(result.ok).toBe(false);
  });

  it("reports wrong schema as malformed", () => {
    const ts = createTestStore();
    fs.mkdirSync(ts.layout.reapReceiptsDir, { recursive: true });
    const file = path.join(ts.layout.reapReceiptsDir, "future.json");
    fs.writeFileSync(file, JSON.stringify({ schema: "miah/reap-receipt/v2", intent_id: "x", unit_id: "U1", reap_timestamp: 1 }));
    const result = readReceipt(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("wrong-schema");
    }
  });

  it("missing reap-receipts directory lists as empty", () => {
    const ts = createTestStore();
    expect(listReceipts(ts.layout.reapReceiptsDir)).toEqual([]);
  });

  it("missing file reads as not-found", () => {
    const result = readReceipt("/nonexistent/path/file.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing");
    }
  });

  it("schema version enforcement (F9): v1 accepted, v2 rejected, missing rejected", () => {
    const ts = createTestStore();
    fs.mkdirSync(ts.layout.reapReceiptsDir, { recursive: true });

    const v1File = path.join(ts.layout.reapReceiptsDir, "v1.json");
    fs.writeFileSync(v1File, JSON.stringify(makeReceipt()));
    expect(readReceipt(v1File).ok).toBe(true);

    const v2File = path.join(ts.layout.reapReceiptsDir, "v2.json");
    fs.writeFileSync(v2File, JSON.stringify({ schema: "miah/reap-receipt/v2", intent_id: "x", unit_id: "U1", reap_timestamp: 1 }));
    expect(readReceipt(v2File).ok).toBe(false);

    const noSchemaFile = path.join(ts.layout.reapReceiptsDir, "no-schema.json");
    fs.writeFileSync(noSchemaFile, JSON.stringify({ intent_id: "x", unit_id: "U1", reap_timestamp: 1 }));
    expect(readReceipt(noSchemaFile).ok).toBe(false);
  });

  it("temp file is cleaned up on rename failure", () => {
    const ts = createTestStore();
    const receipt = makeReceipt();
    const filename = safeReceiptFilename(receipt.intent_id);
    const target = path.join(ts.layout.reapReceiptsDir, filename);
    fs.mkdirSync(ts.layout.reapReceiptsDir, { recursive: true });
    // Make target a directory so rename fails
    fs.mkdirSync(target);
    try {
      writeReceipt(ts.layout.reapReceiptsDir, receipt);
    } catch {
      // expected
    }
    // No temp file should remain
    const files = fs.readdirSync(ts.layout.reapReceiptsDir);
    const temps = files.filter((f) => f.includes(".tmp-"));
    expect(temps).toHaveLength(0);
    // Clean up the directory we created
    fs.rmSync(target, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Match predicate
// ---------------------------------------------------------------------------

describe("matchReceipt", () => {
  it("returns the intent when attempt key matches and unit_id/take agree", () => {
    const intent = makeIntent();
    const receipt = makeReceipt();
    expect(matchReceipt(receipt, [intent])).toBe(intent);
  });

  it("returns null when attempt key matches but unit_id disagrees", () => {
    const intent = makeIntent({ unit_id: "U1" });
    const receipt = makeReceipt({ unit_id: "U2" });
    expect(matchReceipt(receipt, [intent])).toBeNull();
  });

  it("returns null when no in-flight intent carries the attempt key", () => {
    const intent = makeIntent({ idempotency_key: "other" });
    const receipt = makeReceipt({ intent_id: "dispatch-builder-U1-t1" });
    expect(matchReceipt(receipt, [intent])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Consume (F8 crash-consistent ordering)
// ---------------------------------------------------------------------------

describe("consume", () => {
  it("appends gap_recorded then dispatch_terminated and deletes the file", () => {
    const ts = createTestStore();
    // Acquire the lease so append works
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent();
    const receipt = makeReceipt();
    const receiptPath = writeReceipt(ts.layout.reapReceiptsDir, receipt);

    consume(ts.store, receipt, intent, receiptPath);

    const journalEvents = ts.store.journal.readEvents();
    const gapEvent = journalEvents.find((e) => e.type === "gap_recorded");
    const termEvent = journalEvents.find((e) => e.type === "dispatch_terminated");
    expect(gapEvent).toBeDefined();
    expect(termEvent).toBeDefined();
    expect(gapEvent!.seq).toBeLessThan(termEvent!.seq);
    expect((gapEvent as any).criterion).toBe("deadline");
    expect((termEvent as any).outcome).toBe("deadline-exceeded");
    expect((termEvent as any).attempt).toBe(receipt.intent_id);
    // File should be deleted
    expect(listReceipts(ts.layout.reapReceiptsDir)).toHaveLength(0);
  });

  it("crash between gap and terminal: next drain re-matches and appends terminal", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent();
    journalInFlightIntent(ts.store, intent);
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt());

    // Simulate crash after gap but before terminal: append only gap, then reset
    ts.store.append("gap_recorded", {
      unit_id: intent.unit_id,
      criterion: "deadline",
      reason: "simulated partial consume",
    });
    // Receipt file still exists (crash before delete)
    expect(listReceipts(ts.layout.reapReceiptsDir)).toHaveLength(1);

    // Next drain re-matches (intent still in-flight) and appends terminal
    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(1);
    // Should now have 2 gap_recorded events (the simulated one + the re-consume)
    // and 1 dispatch_terminated
    const journalEvents = ts.store.journal.readEvents();
    const termEvents = journalEvents.filter((e) => e.type === "dispatch_terminated");
    expect(termEvents).toHaveLength(1);
  });

  it("crash between terminal and delete: receipt present, next drain deletes it", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent();
    const receipt = makeReceipt();
    writeReceipt(ts.layout.reapReceiptsDir, receipt);

    // Simulate: both events appended but delete didn't happen
    // We already have the receipt on disk, just append the events manually
    ts.store.append("gap_recorded", {
      unit_id: intent.unit_id,
      criterion: "deadline",
      reason: "deadline-exceeded; receipt consumed",
    });
    ts.store.append("dispatch_terminated", {
      unit_id: intent.unit_id,
      role: intent.role,
      take: intent.take,
      attempt: receipt.intent_id,
      agent_id: intent.agent_id,
      workspace_id: intent.workspace_id,
      outcome: "deadline-exceeded",
      idempotency_key: intent.idempotency_key,
    });

    // Receipt still on disk
    expect(listReceipts(ts.layout.reapReceiptsDir)).toHaveLength(1);

    // Next drain: intent no longer in-flight, receipt deleted
    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(0);
    expect(summary.discarded).toBe(1);
    expect(listReceipts(ts.layout.reapReceiptsDir)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Drain (shared helper)
// ---------------------------------------------------------------------------

describe("drainReapReceipts", () => {
  it("drains one matching receipt: journals and deletes", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent();
    journalInFlightIntent(ts.store, intent);
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt());

    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(1);
    expect(summary.discarded).toBe(0);
    expect(summary.errors).toHaveLength(0);
    expect(listReceipts(ts.layout.reapReceiptsDir)).toHaveLength(0);
  });

  it("discards an already-closed receipt and journals nothing", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent();
    journalInFlightIntent(ts.store, intent);
    // Close the dispatch first
    ts.store.append("dispatch_terminated", {
      unit_id: intent.unit_id,
      outcome: "success",
      attempt: intent.idempotency_key,
    });
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt());

    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(0);
    expect(summary.discarded).toBe(1);
  });

  it("discards malformed receipts and does not throw", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    fs.mkdirSync(ts.layout.reapReceiptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(ts.layout.reapReceiptsDir, "malformed.json"),
      "not-json",
    );

    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(0);
    expect(summary.discarded).toBe(1);
  });

  it("drains two receipts in one pass", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    journalInFlightIntent(ts.store, makeIntent({ idempotency_key: "attempt-A" }));
    journalInFlightIntent(ts.store, makeIntent({ idempotency_key: "attempt-B" }));
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt({ intent_id: "attempt-A" }));
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt({ intent_id: "attempt-B" }));

    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(2);
    expect(listReceipts(ts.layout.reapReceiptsDir)).toHaveLength(0);
  });

  it("returns empty summary for missing reap-receipts directory", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(0);
    expect(summary.discarded).toBe(0);
  });

  it("exactly one dispatch_terminated per attempt across the full lifecycle", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent();
    journalInFlightIntent(ts.store, intent);
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt());
    drainReapReceipts(ts.store);
    const events = ts.store.journal.readEvents();
    const terms = events.filter(
      (e) => e.type === "dispatch_terminated" && (e as any).attempt === intent.idempotency_key,
    );
    expect(terms).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Characterization gate (F4) — prove recordDeadlineRefusal produces identical artifacts
// ---------------------------------------------------------------------------

describe("recordDeadlineRefusal characterization (F4)", () => {
  it("produces gap_recorded then dispatch_terminated with deadline-exceeded", async () => {
    const { recordDeadlineRefusal } = await import("../src/dispatch");
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");

    const intent = {
      unit_id: "U1" as UnitId,
      role: "builder",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      deadline: "2026-01-01T00:00:00.000Z",
    };

    const { gapEvent, terminatedEvent } = recordDeadlineRefusal(
      ts.store,
      intent as any,
      { agentId: "agent-123", workspaceId: "ws-456" },
    );

    expect(gapEvent.type).toBe("gap_recorded");
    expect(terminatedEvent.type).toBe("dispatch_terminated");
    expect(gapEvent.seq).toBeLessThan(terminatedEvent.seq);

    const gapPayload = gapEvent as any;
    expect(gapPayload.unit_id).toBe("U1");
    expect(gapPayload.criterion).toBe("deadline");
    expect(gapPayload.reason).toContain("deadline");

    const termPayload = terminatedEvent as any;
    expect(termPayload.unit_id).toBe("U1");
    expect(termPayload.role).toBe("builder");
    expect(termPayload.take).toBe(1);
    expect(termPayload.attempt).toBe("dispatch-builder-U1-t1");
    expect(termPayload.agent_id).toBe("agent-123");
    expect(termPayload.workspace_id).toBe("ws-456");
    expect(termPayload.outcome).toBe("deadline-exceeded");
    expect(termPayload.idempotency_key).toBe("dispatch-builder-U1-t1");
  });
});

// ---------------------------------------------------------------------------
// Negative authorities (R7) — no acceptance, grade, escalation, or phase events
// ---------------------------------------------------------------------------

describe("negative authorities (R7)", () => {
  it("no forbidden events produced by consume or drain", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent();
    writeReceipt(ts.layout.reapReceiptsDir, makeReceipt());
    drainReapReceipts(ts.store);

    const events = ts.store.journal.readEvents();
    const forbidden = events.filter(
      (e) =>
        e.type.startsWith("acceptance_") ||
        e.type.startsWith("grade_") ||
        e.type.startsWith("escalation_resolved_") ||
        e.type === "phase_transition",
    );
    expect(forbidden).toHaveLength(0);
  });
});
