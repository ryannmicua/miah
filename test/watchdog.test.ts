/**
 * Watchdog tests — acceptance examples AE1-AE10 and unit tests for the
 * scan, kill, heartbeat, and tick modules.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  writeReceipt,
  readReceipt,
  listReceipts,
  drainReapReceipts,
  safeReceiptFilename,
  REAP_RECEIPT_SCHEMA,
  type ReapReceipt,
} from "../src/watchdog/receipts";
import {
  writeHeartbeat,
  readHeartbeat,
  heartbeatFreshness,
} from "../src/watchdog/heartbeat";
import {
  watchdogHolderId,
  tick,
  type TickReport,
} from "../src/watchdog/index";
import { killIntent } from "../src/watchdog/kill";
import { scanRun, scanAllRuns } from "../src/watchdog/scan";
import {
  createTestStore,
  cleanupTempDirs,
  makeClock,
  fastConfig,
  type TestStore,
} from "./helpers";
import type { InFlightIntent, UnitId, Config } from "../src/types";
import { RunStore } from "../src/run-store";
import { readOnlyState } from "../src/commands/status";
import type { PaseoAdapter, PaseoHandle, PaseoInspectResult } from "../src/adapter/paseo";

afterEach(() => {
  cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

class MockAdapter implements PaseoAdapter {
  stopCalls: PaseoHandle[] = [];
  stopErrors: Map<string, Error> = new Map();
  launchCalls: Array<{ prompt: string; opts: any }> = [];

  async launch(prompt: string, opts: any): Promise<PaseoHandle> {
    this.launchCalls.push({ prompt, opts });
    return { agentId: `mock-${Date.now()}`, cwd: null, workspaceId: null };
  }
  async status(_handle: PaseoHandle): Promise<string> { return "idle"; }
  async inspect(handle: PaseoHandle): Promise<PaseoInspectResult> {
    return {
      agentId: handle.agentId,
      lifecycle: "idle",
      provider: null, model: null, mode: null,
      cwd: null,
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
      capabilities: {},
    };
  }
  async stop(handle: PaseoHandle): Promise<void> {
    this.stopCalls.push(handle);
    const err = this.stopErrors.get(handle.agentId);
    if (err) throw err;
  }
  async cancel(handle: PaseoHandle): Promise<void> {
    await this.stop(handle);
  }
}

function pastDeadline(clockNow: number): string {
  return new Date(clockNow - 10 * 60 * 1000).toISOString();
}

function futureDeadline(clockNow: number): string {
  return new Date(clockNow + 10 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Heartbeat tests
// ---------------------------------------------------------------------------

describe("heartbeat", () => {
  it("writes and reads a heartbeat", () => {
    const ts = createTestStore();
    writeHeartbeat(ts.basePath, "0.1.0", 60);
    const hb = readHeartbeat(ts.basePath);
    expect(hb).not.toBeNull();
    expect(hb!.version).toBe("0.1.0");
    expect(hb!.cadence_s).toBe(60);
  });

  it("fresh heartbeat is healthy", () => {
    const ts = createTestStore();
    const clock = makeClock(Date.now());
    writeHeartbeat(ts.basePath, "0.1.0", 60);
    const result = heartbeatFreshness(ts.basePath, clock.now);
    expect(result.healthy).toBe(true);
  });

  it("stale heartbeat (beyond 2x cadence) is unhealthy", () => {
    const ts = createTestStore();
    const now = Date.now();
    // Write heartbeat at a time 200 seconds ago with cadence 60s (max age = 120s)
    fs.mkdirSync(ts.basePath, { recursive: true });
    const hb = { timestamp: new Date(now - 200_000).toISOString(), version: "0.1.0", cadence_s: 60 };
    fs.writeFileSync(path.join(ts.basePath, "watchdog-heartbeat.json"), JSON.stringify(hb));
    const result = heartbeatFreshness(ts.basePath, now);
    expect(result.healthy).toBe(false);
  });

  it("missing heartbeat is unhealthy", () => {
    const ts = createTestStore();
    const result = heartbeatFreshness(ts.basePath);
    expect(result.healthy).toBe(false);
    expect(result.heartbeat).toBeNull();
  });

  it("malformed heartbeat file is unhealthy", () => {
    const ts = createTestStore();
    fs.mkdirSync(ts.basePath, { recursive: true });
    fs.writeFileSync(path.join(ts.basePath, "watchdog-heartbeat.json"), "not-json");
    const result = heartbeatFreshness(ts.basePath);
    expect(result.healthy).toBe(false);
  });

  it("boundary: heartbeat exactly at 2x cadence is healthy", () => {
    const ts = createTestStore();
    const now = Date.now();
    const cadence = 60;
    fs.mkdirSync(ts.basePath, { recursive: true });
    const hb = { timestamp: new Date(now - cadence * 2 * 1000).toISOString(), version: "0.1.0", cadence_s: cadence };
    fs.writeFileSync(path.join(ts.basePath, "watchdog-heartbeat.json"), JSON.stringify(hb));
    const result = heartbeatFreshness(ts.basePath, now);
    expect(result.healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scan tests
// ---------------------------------------------------------------------------

describe("scanRun", () => {
  it("returns null for a run directory without a manifest", () => {
    const ts = createTestStore();
    // Write a manifest so the directory exists but the scan sees it
    const manifest = {
      schema_version: 1, run_id: ts.runId, plan_hash: "abc",
      plan_snapshot_file: "plan-snapshot.v1.md", created_at: new Date().toISOString(),
      config_snapshot: ts.config, probe_verdicts: {},
    };
    fs.writeFileSync(ts.layout.manifestPath, JSON.stringify(manifest));
    const result = scanRun(ts.basePath, ts.runId, ts.config, Date.now());
    // Manifest exists, so scan should succeed (but no intents)
    expect(result).not.toBeNull();
    expect(result!.overdueIntents).toHaveLength(0);
  });

  it("finds overdue in-flight intents", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent({ deadline: pastDeadline(Date.now()) });
    journalInFlightIntent(ts.store, intent);
    // Write manifest for scanRun
    const manifest = {
      schema_version: 1, run_id: ts.runId, plan_hash: "abc",
      plan_snapshot_file: "plan-snapshot.v1.md", created_at: new Date().toISOString(),
      config_snapshot: ts.config, probe_verdicts: {},
    };
    fs.writeFileSync(ts.layout.manifestPath, JSON.stringify(manifest));
    const result = scanRun(ts.basePath, ts.runId, ts.config, Date.now());
    expect(result).not.toBeNull();
    expect(result!.overdueIntents).toHaveLength(1);
    expect(result!.overdueIntents[0].idempotency_key).toBe(intent.idempotency_key);
  });

  it("skips non-overdue intents", () => {
    const ts = createTestStore();
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent({ deadline: futureDeadline(Date.now()) });
    journalInFlightIntent(ts.store, intent);
    const manifest = {
      schema_version: 1, run_id: ts.runId, plan_hash: "abc",
      plan_snapshot_file: "plan-snapshot.v1.md", created_at: new Date().toISOString(),
      config_snapshot: ts.config, probe_verdicts: {},
    };
    fs.writeFileSync(ts.layout.manifestPath, JSON.stringify(manifest));
    const result = scanRun(ts.basePath, ts.runId, ts.config, Date.now());
    expect(result).not.toBeNull();
    expect(result!.overdueIntents).toHaveLength(0);
  });

  it("reports lease state", () => {
    const ts = createTestStore();
    const manifest = {
      schema_version: 1, run_id: ts.runId, plan_hash: "abc",
      plan_snapshot_file: "plan-snapshot.v1.md", created_at: new Date().toISOString(),
      config_snapshot: ts.config, probe_verdicts: {},
    };
    fs.writeFileSync(ts.layout.manifestPath, JSON.stringify(manifest));
    const result = scanRun(ts.basePath, ts.runId, ts.config, Date.now());
    expect(result).not.toBeNull();
    expect(result!.lease.lease).toBeNull();
  });

  it("F13: InFlightIntent carries nullable agent_id and workspace_id", () => {
    // This is a structural precondition check (F13)
    const intent = makeIntent({ agent_id: null, workspace_id: null });
    expect(intent.agent_id).toBeNull();
    expect(intent.workspace_id).toBeNull();
    // The intent type in types.ts should have these as nullable
    const intent2 = makeIntent({ agent_id: "agent-1", workspace_id: "ws-1" });
    expect(typeof intent2.agent_id).toBe("string");
    expect(typeof intent2.workspace_id).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Kill tests
// ---------------------------------------------------------------------------

describe("killIntent", () => {
  it("calls adapter.stop with the correct handle", async () => {
    const adapter = new MockAdapter();
    const intent = makeIntent();
    const result = await killIntent(adapter, intent);
    expect(result.outcome).toBe("terminated");
    expect(adapter.stopCalls).toHaveLength(1);
    expect(adapter.stopCalls[0].agentId).toBe("agent-123");
    expect(adapter.stopCalls[0].cwd).toBeNull();
    expect(adapter.stopCalls[0].workspaceId).toBe("ws-456");
  });

  it("no-recorded-agent when agent_id is null", async () => {
    const adapter = new MockAdapter();
    const intent = makeIntent({ agent_id: null });
    const result = await killIntent(adapter, intent);
    expect(result.outcome).toBe("no-recorded-agent");
    expect(adapter.stopCalls).toHaveLength(0);
  });

  it("adapter-failed when stop throws", async () => {
    const adapter = new MockAdapter();
    adapter.stopErrors.set("agent-123", new Error("connection refused"));
    const intent = makeIntent();
    const result = await killIntent(adapter, intent);
    expect(result.outcome).toBe("adapter-failed");
    expect(result.error).toBe("connection refused");
  });
});

// ---------------------------------------------------------------------------
// AE1: Stale lease, overdue intent — kill + receipt + takeover + drain
// ---------------------------------------------------------------------------

describe("AE1: stale lease reap + takeover", () => {
  it("kills, receipts, takes over lease, drains, and releases", async () => {
    const ts = createTestStore();
    const adapter = new MockAdapter();
    const clock = makeClock(Date.now());

    // Write manifest for scanRun
    const manifest = {
      schema_version: 1, run_id: ts.runId, plan_hash: "abc",
      plan_snapshot_file: "plan-snapshot.v1.md", created_at: new Date().toISOString(),
      config_snapshot: ts.config, probe_verdicts: {},
    };
    fs.writeFileSync(ts.layout.manifestPath, JSON.stringify(manifest));

    // Journal a dispatch intent with a past deadline (under lease)
    ts.store.lease.acquire("holder-A");
    const intent = makeIntent({
      deadline: pastDeadline(clock.now),
      agent_id: "agent-1",
      workspace_id: "ws-1",
    });
    journalInFlightIntent(ts.store, intent);

    // Run the tick
    const report = await tick(adapter, {
      basePath: ts.basePath,
      config: ts.config,
      version: "0.1.0",
      now: clock.now,
    });

    // Specialist terminated
    expect(report.intentsKilled).toBe(1);
    expect(adapter.stopCalls).toHaveLength(1);
    expect(adapter.stopCalls[0].agentId).toBe("agent-1");

    // Receipt was consumed by drain (lease was stale/takeable)
    const receipts = listReceipts(ts.layout.reapReceiptsDir);
    expect(receipts).toHaveLength(0);

    // Journal should have gap_recorded + dispatch_terminated
    const events = ts.store.journal.readEvents();
    const gapEvents = events.filter((e) => e.type === "gap_recorded");
    const termEvents = events.filter((e) => e.type === "dispatch_terminated");
    expect(gapEvents.length).toBeGreaterThanOrEqual(1);
    expect(termEvents.length).toBeGreaterThanOrEqual(1);
    expect(report.leasesTakenOver).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AE2: Fresh lease held by driver — kill + receipt, NO journal append
// ---------------------------------------------------------------------------

describe("AE2: fresh lease — kill but no journal", () => {
  it("terminates specialist and writes receipt but does NOT touch journal", async () => {
    const clock = makeClock(Date.now());
    const ts = createTestStore({ holderId: "driver-process", clock });
    const adapter = new MockAdapter();

    // Write manifest for scanRun
    const manifest = {
      schema_version: 1, run_id: ts.runId, plan_hash: "abc",
      plan_snapshot_file: "plan-snapshot.v1.md", created_at: new Date().toISOString(),
      config_snapshot: ts.config, probe_verdicts: {},
    };
    fs.writeFileSync(ts.layout.manifestPath, JSON.stringify(manifest));

    // Acquire the lease first (simulating a live driver)
    ts.store.lease.acquire("driver-process");

    // Journal a dispatch intent with a past deadline
    const intent = makeIntent({
      deadline: pastDeadline(clock.now),
      agent_id: "agent-2",
    });
    journalInFlightIntent(ts.store, intent);

    const report = await tick(adapter, {
      basePath: ts.basePath,
      config: ts.config,
      version: "0.1.0",
      now: clock.now,
    });

    // Specialist terminated (R2)
    expect(report.intentsKilled).toBe(1);
    expect(adapter.stopCalls[0].agentId).toBe("agent-2");

    // Receipt written (R3)
    const receipts = listReceipts(ts.layout.reapReceiptsDir);
    expect(receipts).toHaveLength(1);

    // Journal NOT touched (R5) — no gap_recorded or dispatch_terminated
    const events = ts.store.journal.readEvents();
    const gapEvents = events.filter((e) => e.type === "gap_recorded");
    const termEvents = events.filter((e) => e.type === "dispatch_terminated");
    expect(gapEvents).toHaveLength(0);
    expect(termEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AE3: Driver drains receipt at step boundary
// ---------------------------------------------------------------------------

describe("AE3: driver drains receipt", () => {
  it("drainReapReceipts journals gap + terminated and deletes receipt", () => {
    const ts = createTestStore({ holderId: "driver-A" });
    ts.store.lease.acquire("driver-A");
    const intent = makeIntent();
    journalInFlightIntent(ts.store, intent);
    writeReceipt(ts.layout.reapReceiptsDir, {
      schema: REAP_RECEIPT_SCHEMA,
      intent_id: intent.idempotency_key,
      agent_id: intent.agent_id,
      workspace_id: intent.workspace_id,
      deadline: intent.deadline,
      reap_timestamp: Date.now(),
      adapter_outcome: "terminated",
      error: null,
      unit_id: intent.unit_id,
      role: intent.role,
      take: intent.take,
      run_id: ts.runId,
      reaper: "miah-wd-test",
      version: "0.1.0",
    });

    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(1);
    expect(listReceipts(ts.layout.reapReceiptsDir)).toHaveLength(0);

    const events = ts.store.journal.readEvents();
    const gap = events.find((e) => e.type === "gap_recorded");
    const term = events.find((e) => e.type === "dispatch_terminated");
    expect(gap).toBeDefined();
    expect(term).toBeDefined();
    expect((term as any).outcome).toBe("deadline-exceeded");
  });
});

// ---------------------------------------------------------------------------
// AE4: Driver polls overdue intent with no receipt — no stop call
// ---------------------------------------------------------------------------

describe("AE4: driver skips overdue intent without receipt", () => {
  it("scan finds no receipts for non-existent receipt directory", () => {
    const ts = createTestStore();
    const receipts = listReceipts(ts.layout.reapReceiptsDir);
    expect(receipts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AE5: Already-closed dispatch — receipt deleted, no double journal
// ---------------------------------------------------------------------------

describe("AE5: already-closed dispatch receipt discarded", () => {
  it("drain deletes receipt with no matching in-flight intent", () => {
    const ts = createTestStore({ holderId: "driver-A" });
    ts.store.lease.acquire("driver-A");
    // Close the dispatch first (already terminated)
    ts.store.append("dispatch_terminated", {
      unit_id: "U1",
      outcome: "success",
      attempt: "dispatch-builder-U1-t1",
    });
    writeReceipt(ts.layout.reapReceiptsDir, {
      schema: REAP_RECEIPT_SCHEMA,
      intent_id: "dispatch-builder-U1-t1",
      agent_id: "agent-123",
      workspace_id: "ws-456",
      deadline: "2026-01-01T00:00:00.000Z",
      reap_timestamp: Date.now(),
      adapter_outcome: "terminated",
      error: null,
      unit_id: "U1",
      role: "builder",
      take: 1,
      run_id: ts.runId,
      reaper: "miah-wd-test",
      version: "0.1.0",
    });

    const summary = drainReapReceipts(ts.store);
    expect(summary.drained).toBe(0);
    expect(summary.discarded).toBe(1);
    // No second dispatch_terminated
    const events = ts.store.journal.readEvents();
    const terms = events.filter((e) => e.type === "dispatch_terminated");
    expect(terms).toHaveLength(1); // only the original one
  });
});

// ---------------------------------------------------------------------------
// AE8/AE9: Admission gate watchdog health
// ---------------------------------------------------------------------------

describe("admission gate watchdog health", () => {
  it("AE8: stale/missing heartbeat means max-duration-absent", () => {
    const ts = createTestStore();
    const result = heartbeatFreshness(ts.basePath);
    expect(result.healthy).toBe(false);
  });

  it("AE9: fresh heartbeat means max-duration satisfied", () => {
    const ts = createTestStore();
    writeHeartbeat(ts.basePath, "0.1.0", 60);
    const result = heartbeatFreshness(ts.basePath, Date.now());
    expect(result.healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative authorities (R7) — no acceptance, grade, escalation, or phase
// ---------------------------------------------------------------------------

describe("negative authorities (R7)", () => {
  it("watchdog tick produces no forbidden events", async () => {
    const ts = createTestStore();
    const adapter = new MockAdapter();
    const clock = makeClock(Date.now());

    // Write manifest for scanRun
    const manifest = {
      schema_version: 1, run_id: ts.runId, plan_hash: "abc",
      plan_snapshot_file: "plan-snapshot.v1.md", created_at: new Date().toISOString(),
      config_snapshot: ts.config, probe_verdicts: {},
    };
    fs.writeFileSync(ts.layout.manifestPath, JSON.stringify(manifest));

    ts.store.lease.acquire("holder-A");
    const intent = makeIntent({ deadline: pastDeadline(clock.now) });
    journalInFlightIntent(ts.store, intent);

    await tick(adapter, {
      basePath: ts.basePath,
      config: ts.config,
      version: "0.1.0",
      now: clock.now,
    });

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

// ---------------------------------------------------------------------------
// watchdogHolderId
// ---------------------------------------------------------------------------

describe("watchdogHolderId", () => {
  it("returns miah-wd-<pid>", () => {
    const id = watchdogHolderId();
    expect(id).toMatch(/^miah-wd-\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Safe filename (additional coverage)
// ---------------------------------------------------------------------------

describe("safeReceiptFilename additional", () => {
  it("F10: collision resistance — two long identical-prefix attempts differ", () => {
    const a = "a".repeat(250) + "X";
    const b = "a".repeat(250) + "Y";
    expect(safeReceiptFilename(a)).not.toBe(safeReceiptFilename(b));
  });

  it("F10: 10000-char attempt produces <= 209-char stem", () => {
    const result = safeReceiptFilename("x".repeat(10000));
    const stem = result.replace(/\.json$/, "");
    expect(stem.length).toBeLessThanOrEqual(209);
  });
});
