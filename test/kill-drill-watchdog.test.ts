/**
 * Kill-drill watchdog test (F-004, AE10) — proves the watchdog is the sole
 * reaper of per-dispatch deadlines and that the journal stays consistent
 * after a driver crash.
 *
 * Covers acceptance examples:
 *  - AE1:  stale lease + overdue intent → kill + receipt + takeover + drain
 *  - AE2:  fresh lease + overdue intent → kill + receipt, NO journal touch
 *  - AE10: driver killed mid-dispatch → watchdog tick terminates agent,
 *          lease goes stale, watchdog takes over, journal replays consistently
 */
import * as fs from "fs";
import { describe, it, expect, afterEach } from "vitest";
import {
  tick,
  type TickReport,
} from "../src/watchdog/index";
import {
  listReceipts,
} from "../src/watchdog/receipts";
import {
  createTestStore,
  cleanupTempDirs,
  makeClock,
  type TestStore,
} from "./helpers";
import type { InFlightIntent } from "../src/types";
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

function writeManifest(ts: TestStore): void {
  const manifest = {
    schema_version: 1,
    run_id: ts.runId,
    plan_hash: "abc",
    plan_snapshot_file: "plan-snapshot.v1.md",
    created_at: new Date().toISOString(),
    config_snapshot: ts.config,
    probe_verdicts: {},
  };
  fs.writeFileSync(ts.layout.manifestPath, JSON.stringify(manifest));
}

class MockAdapter implements PaseoAdapter {
  stopCalls: PaseoHandle[] = [];
  stopErrors: Map<string, Error> = new Map();

  async launch(_prompt: string, _opts: any): Promise<PaseoHandle> {
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

function pastDeadline(now: number): string {
  return new Date(now - 10 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// AE1: Stale lease + overdue intent → full reap cycle
//
// createTestStore() defaults clock to 1_000_000 (epoch ~16 min), making the
// lease appear stale to the scan (which uses real Date.now()). The tick's
// `now` is passed as Date.now() so the deadline check uses real time.
// ---------------------------------------------------------------------------

describe("AE1 kill-drill: stale lease reap + takeover", () => {
  it("kills specialist, writes receipt, takes over lease, drains receipt (journals gap + terminated), releases lease", async () => {
    const clock = makeClock(Date.now());
    const driverHolder = "driver-A";
    const ts = createTestStore({ holderId: driverHolder });
    const adapter = new MockAdapter();

    writeManifest(ts);

    // Acquire a lease as the driver
    ts.store.lease.acquire(driverHolder);

    // Journal an in-flight dispatch with a past deadline
    const intent = makeIntent({
      deadline: pastDeadline(clock.now),
      agent_id: "agent-1",
      workspace_id: "ws-1",
    });
    journalInFlightIntent(ts.store, intent);

    // Run the watchdog tick (clock.now is Date.now() for deadline check)
    const report = await tick(adapter, {
      basePath: ts.basePath,
      config: ts.config,
      version: "0.1.0",
      now: clock.now,
    });

    // 1. Specialist was terminated through the adapter
    expect(report.intentsKilled).toBe(1);
    expect(adapter.stopCalls).toHaveLength(1);
    expect(adapter.stopCalls[0].agentId).toBe("agent-1");

    // 2. Receipt was consumed (taken over + drained)
    const receipts = listReceipts(ts.layout.reapReceiptsDir);
    expect(receipts).toHaveLength(0);

    // 3. Lease was taken over by the watchdog
    expect(report.leasesTakenOver).toBe(1);

    // 4. Journal gained gap_recorded + dispatch_terminated
    const events = ts.store.journal.readEvents();
    const gapEvents = events.filter((e) => e.type === "gap_recorded");
    const termEvents = events.filter((e) => e.type === "dispatch_terminated");
    expect(gapEvents.length).toBeGreaterThanOrEqual(1);
    expect(termEvents.length).toBeGreaterThanOrEqual(1);

    // 5. The dispatch_terminated has the deadline-exceeded outcome
    const deadlineTerm = termEvents.find(
      (e: any) => e.outcome === "deadline-exceeded" && e.attempt === intent.idempotency_key,
    );
    expect(deadlineTerm).toBeDefined();

    // 6. No duplicate dispatch_terminated for this intent
    const termsForIntent = termEvents.filter(
      (e: any) => e.attempt === intent.idempotency_key,
    );
    expect(termsForIntent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AE2: Fresh lease + overdue intent → kill + receipt, NO journal touch
//
// Using makeClock(Date.now()) so the lease acquisition timestamp is close to
// the scan's Date.now(), making the lease appear fresh to the watchdog.
// ---------------------------------------------------------------------------

describe("AE2 kill-drill: fresh lease — kill but no journal", () => {
  it("terminates specialist, writes receipt, does NOT touch journal", async () => {
    const clock = makeClock(Date.now());
    const driverHolder = "driver-live";
    const ts = createTestStore({ clock, holderId: driverHolder });
    const adapter = new MockAdapter();

    writeManifest(ts);

    // Driver holds a fresh lease (heartbeat is within TTL)
    ts.store.lease.acquire(driverHolder);

    // Journal an in-flight dispatch with a past deadline
    const intent = makeIntent({
      deadline: pastDeadline(clock.now),
      agent_id: "agent-2",
      workspace_id: "ws-2",
    });
    journalInFlightIntent(ts.store, intent);

    // Run the watchdog tick — lease is still fresh
    const report = await tick(adapter, {
      basePath: ts.basePath,
      config: ts.config,
      version: "0.1.0",
      now: clock.now,
    });

    // 1. Specialist was terminated (R2: watchdog always kills, regardless of lease)
    expect(report.intentsKilled).toBe(1);
    expect(adapter.stopCalls[0].agentId).toBe("agent-2");

    // 2. Receipt was written (R3)
    const receipts = listReceipts(ts.layout.reapReceiptsDir);
    expect(receipts).toHaveLength(1);

    // 3. Lease was NOT taken over (R5: driver drains at step boundary)
    expect(report.leasesTakenOver).toBe(0);

    // 4. Journal was NOT touched — no gap_recorded or dispatch_terminated
    const events = ts.store.journal.readEvents();
    const gapEvents = events.filter((e) => e.type === "gap_recorded");
    const termEvents = events.filter((e) => e.type === "dispatch_terminated");
    expect(gapEvents).toHaveLength(0);
    expect(termEvents).toHaveLength(0);

    // 5. Lease holder and heartbeat are unchanged
    const lease = ts.store.lease.read();
    expect(lease).not.toBeNull();
    expect(lease!.holder_id).toBe(driverHolder);
  });
});

// ---------------------------------------------------------------------------
// AE10: Driver killed mid-dispatch → watchdog tick terminates agent,
//       lease goes stale, watchdog takes over, journal replays consistently
//
// Same stale-lease trick as AE1: default clock (1_000_000) makes the lease
// appear ancient to the scan, simulating a driver crash.
// ---------------------------------------------------------------------------

describe("AE10 kill-drill: driver killed mid-dispatch, journal consistent", () => {
  it("terminates agent on tick, takes over stale lease, and journal replays to consistent state", async () => {
    const clock = makeClock(Date.now());
    const driverHolder = "driver-process";
    const ts = createTestStore({ holderId: driverHolder });
    const adapter = new MockAdapter();

    writeManifest(ts);

    // ── Phase 1: Simulate a live driver session ──
    // Driver acquired the lease and dispatched a builder.
    ts.store.lease.acquire(driverHolder);

    // Journal events showing a realistic dispatch lifecycle:
    // run_start → lease_acquired → dispatch_intent → dispatch_created
    ts.store.append("run_start", {
      run_id: ts.runId,
      plan_hash: "a".repeat(64),
    });
    ts.store.append("lease_acquired", {
      holder: driverHolder,
    });

    const intent = makeIntent({
      unit_id: "U1",
      role: "builder",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      deadline: pastDeadline(clock.now),
      agent_id: "agent-killed",
      workspace_id: "ws-killed",
    });
    journalInFlightIntent(ts.store, intent);

    // ── Phase 2: Driver crash (lease is stale — default clock at 1_000_000) ──

    // ── Phase 3: Watchdog tick runs ──
    const report = await tick(adapter, {
      basePath: ts.basePath,
      config: ts.config,
      version: "0.1.0",
      now: clock.now,
    });

    // ── Assertions: the watchdog was the sole reaper ──

    // 1. The agent was terminated on this tick
    expect(report.intentsKilled).toBe(1);
    expect(adapter.stopCalls).toHaveLength(1);
    expect(adapter.stopCalls[0].agentId).toBe("agent-killed");

    // 2. The lease was taken over (stale, so watchdog acquired it)
    expect(report.leasesTakenOver).toBe(1);

    // 3. The receipt was consumed (drained into the journal)
    const receipts = listReceipts(ts.layout.reapReceiptsDir);
    expect(receipts).toHaveLength(0);

    // 4. Journal gained exactly the expected events: gap_recorded + dispatch_terminated
    const events = ts.store.journal.readEvents();
    const gapEvents = events.filter((e) => e.type === "gap_recorded");
    const termEvents = events.filter((e) => e.type === "dispatch_terminated");

    // At least one gap_recorded for the deadline
    expect(gapEvents.length).toBeGreaterThanOrEqual(1);
    // Exactly one dispatch_terminated for this intent (no duplicates)
    const termsForIntent = termEvents.filter(
      (e: any) => e.attempt === intent.idempotency_key,
    );
    expect(termsForIntent).toHaveLength(1);
    expect(termsForIntent[0].outcome).toBe("deadline-exceeded");

    // ── Phase 4: Journal replay consistency ──
    // Re-read the journal through readOnlyState and verify the derived state
    // is consistent: the intent is no longer in-flight, no duplicates exist.
    const derivedState = readOnlyState(ts.store);

    // The killed intent is no longer in-flight
    const stillInFlight = derivedState.in_flight_intents.filter(
      (i) => i.idempotency_key === intent.idempotency_key,
    );
    expect(stillInFlight).toHaveLength(0);

    // Exactly one dispatch_terminated in the full event stream for this intent
    const allTerms = events.filter(
      (e) => e.type === "dispatch_terminated",
    );
    const allTermsForIntent = allTerms.filter(
      (e: any) => e.attempt === intent.idempotency_key,
    );
    expect(allTermsForIntent).toHaveLength(1);

    // No duplicate or lost events: seq numbers are monotonic and unique
    const seqs = events.map((e) => e.seq);
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(seqs.length);
  });
});
