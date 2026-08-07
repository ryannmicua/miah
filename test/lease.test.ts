import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Lease, LeaseNotHeldError } from "../src/lease";
import {
  cleanupTempDirs,
  createTestStore,
  fastConfig,
  makeClock,
  makeTempDir,
  type Clock,
} from "./helpers";

afterEach(cleanupTempDirs);

/** A bare Lease on a temp path (no RunStore/journal wiring) with a fake clock. */
function bareLease(opts?: { ttl_s?: number; heartbeat_interval_s?: number }) {
  const dir = makeTempDir("miah-lease-");
  const clock = makeClock();
  const lease = new Lease(path.join(dir, "lease.lock"), {
    ttl_s: opts?.ttl_s ?? 2,
    heartbeat_interval_s: opts?.heartbeat_interval_s ?? 1,
    now: clock.fn,
  });
  return { dir, lease, clock };
}

/** Advance the fake clock by `ms` milliseconds. */
function tick(clock: Clock, ms: number): void {
  clock.now += ms;
}

describe("lease", () => {
  it("acquire writes lease.lock with holder_id, acquired_at, last_heartbeat_at, ttl_s", () => {
    const { dir, lease, clock } = bareLease({ ttl_s: 60 });
    const result = lease.acquire("holder-A");
    expect(result).toMatchObject({ ok: true, reason: "acquired" });

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "lease.lock"), "utf8"));
    expect(onDisk.holder_id).toBe("holder-A");
    expect(onDisk.ttl_s).toBe(60);
    expect(onDisk.acquired_at).toBe(clock.now);
    expect(onDisk.last_heartbeat_at).toBe(clock.now);
    expect(lease.read()).toEqual(onDisk);
  });

  it("re-acquiring with the same holder is an idempotent success", () => {
    const { lease } = bareLease();
    expect(lease.acquire("A").reason).toBe("acquired");
    expect(lease.acquire("A")).toMatchObject({ ok: true, reason: "already-held" });
  });

  it("holder B fails to acquire while holder A's heartbeat is fresh (R39, AE11)", () => {
    const { lease, clock } = bareLease({ ttl_s: 60 });
    lease.acquire("A");

    tick(clock, 5_000); // well inside the 60s TTL
    const attempt = lease.acquire("B");
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.reason).toBe("fresh-heartbeat");
      expect(attempt.lease.holder_id).toBe("A");
    }
    // B's failed attempt leaves A's lease.lock untouched (AE11).
    expect(lease.read()?.holder_id).toBe("A");
    expect(lease.holderId()).toBe("A");
  });

  it("heartbeat rewrites last_heartbeat_at; B still cannot acquire", () => {
    const { lease, clock } = bareLease({ ttl_s: 2 });
    lease.acquire("A");
    tick(clock, 1);

    lease.renew("A");
    const lastHeartbeat = lease.read()?.last_heartbeat_at;
    expect(lastHeartbeat).toBe(clock.now);

    expect(lease.acquire("B").ok).toBe(false);
  });

  it("after TTL with no heartbeat, holder B acquires by stale-takeover (R72)", () => {
    const { lease, clock } = bareLease({ ttl_s: 2 }); // TTL = 2000ms
    lease.acquire("A"); // last_heartbeat_at = clock.now

    tick(clock, 2_000); // exactly at the TTL boundary → still fresh, never steal
    const boundary = lease.acquire("B");
    expect(boundary.ok).toBe(false);

    tick(clock, 1); // one ms past TTL → stale
    const result = lease.acquire("B");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reason).toBe("stale-takeover");
      expect(result.lease.holder_id).toBe("B");
    }
  });

  it("a renewing holder is never stolen: heartbeat keeps the lease fresh", () => {
    const { lease, clock } = bareLease({ ttl_s: 2 }); // TTL = 2000ms
    lease.acquire("A"); // last_heartbeat = 0
    tick(clock, 1_000);
    lease.renew("A"); // last_heartbeat = 1000
    tick(clock, 1_000); // 1000ms elapsed since last heartbeat → still fresh

    expect(lease.acquire("B").ok).toBe(false);

    tick(clock, 1_001); // 2001ms elapsed since last heartbeat → stale
    const result = lease.acquire("B");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reason).toBe("stale-takeover");
    }
  });

  it("renew throws for a non-holder (the failed renewal attempt of R72)", () => {
    const { lease } = bareLease({ ttl_s: 2 });
    lease.acquire("A");
    expect(() => lease.renew("B")).toThrow(LeaseNotHeldError);
  });

  it("release appends a lease_released journal event and marks lease.lock terminal (R40)", () => {
    const t = createTestStore();
    t.store.lease.acquire("holder-A");
    t.store.append("run_start", { run_id: "r1", plan_hash: "h1" });
    t.store.lease.release("holder-A");

    const events = t.store.journal.readEvents();
    const released = events.find((e) => e.type === "lease_released");
    expect(released).toBeDefined();
    expect(released?.holder_id).toBe("holder-A");

    const onDisk = t.store.lease.read();
    expect(onDisk?.released).toBe(true);
    expect(typeof onDisk?.released_at).toBe("number");
    // A terminal lease is free for the next holder.
    expect(t.store.lease.acquire("holder-C").ok).toBe(true);
  });

  it("release records lease_acquired and lease_renewed events in order (R35)", () => {
    const t = createTestStore();
    t.store.lease.acquire("holder-A");
    t.store.lease.renew("holder-A");
    t.store.lease.release("holder-A");

    const types = t.store.journal.readEvents().map((e) => e.type);
    expect(types).toEqual(["lease_acquired", "lease_renewed", "lease_released"]);
  });

  it("release throws when called by a non-holder", () => {
    const { lease } = bareLease();
    lease.acquire("A");
    expect(() => lease.release("B")).toThrow(LeaseNotHeldError);
  });

  it("lease.lock survives 'restart': a fresh Lease reads the current holder (R39)", () => {
    const { dir, lease, clock } = bareLease();
    lease.acquire("holder-A");
    expect(lease.holderId()).toBe("holder-A");

    const resumed = new Lease(path.join(dir, "lease.lock"), {
      ttl_s: 2,
      heartbeat_interval_s: 1,
      now: clock.fn,
    });
    expect(resumed.read()?.holder_id).toBe("holder-A");
    expect(resumed.holderId()).toBe("holder-A");
    // A resumer cannot acquire while the resumed holder is fresh.
    expect(resumed.acquire("holder-R").ok).toBe(false);
  });

  it("cleans up leftover lease temp files from a killed acquire", () => {
    const { dir, lease } = bareLease();
    fs.writeFileSync(path.join(dir, "lease.lock.tmp-1234-deadbeef"), "stale temp", "utf8");
    lease.acquire("A");
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("maybeHeartbeat renews only after the heartbeat interval has elapsed", () => {
    const { lease, clock } = bareLease({ ttl_s: 10, heartbeat_interval_s: 3 });
    lease.acquire("A");
    expect(lease.maybeHeartbeat("A")).toBe(false); // interval not elapsed
    const hb1 = lease.read()?.last_heartbeat_at;

    tick(clock, 1_000); // still inside the 3s interval
    expect(lease.maybeHeartbeat("A")).toBe(false);
    expect(lease.read()?.last_heartbeat_at).toBe(hb1);

    tick(clock, 2_500); // 3.5s elapsed → interval elapsed
    expect(lease.maybeHeartbeat("A")).toBe(true);
    expect(lease.read()?.last_heartbeat_at).toBe(clock.now);
  });

  it("honors configurable TTL and heartbeat from Config (R72)", () => {
    const config = fastConfig({ lease: { heartbeat_interval_s: 5, ttl_s: 10 } });
    const t = createTestStore({ config });
    const lease = t.store.lease;

    lease.acquire("A");
    expect(lease.read()?.ttl_s).toBe(10);

    tick(t.clock, 9_000); // 9s elapsed, heartbeat fresh (9 < ttl 10)
    expect(lease.acquire("B").ok).toBe(false);

    tick(t.clock, 2_000); // 11s elapsed → stale
    const takeover = lease.acquire("B");
    expect(takeover.ok).toBe(true);
  });
});
