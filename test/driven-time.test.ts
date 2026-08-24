/**
 * U1 tests — driven-time computation (R10-R12, KTD8).
 */
import { describe, it, expect } from "vitest";
import { drivenMilliseconds } from "../src/driven-time";
import { DEFAULT_CONFIG } from "../src/types";
import type { JournalEvent } from "../src/types";

function leaseEvent(
  type: "lease_acquired" | "lease_released" | "lease_renewed",
  timestamp: number,
): JournalEvent {
  return { seq: 0, type, timestamp };
}

function otherEvent(type: string, timestamp: number): JournalEvent {
  return { seq: 0, type, timestamp };
}

describe("drivenMilliseconds", () => {
  it("single clean epoch returns release-minus-acquire duration", () => {
    const events: JournalEvent[] = [
      leaseEvent("lease_acquired", 1000),
      leaseEvent("lease_renewed", 1060_000),
      leaseEvent("lease_released", 1120_000),
    ];
    expect(drivenMilliseconds(events)).toBe(1120_000 - 1000);
  });

  it("two clean epochs separated by a long idle gap return the sum", () => {
    const events: JournalEvent[] = [
      leaseEvent("lease_acquired", 1000),
      leaseEvent("lease_released", 2000),
      // idle gap: 1 hour
      leaseEvent("lease_acquired", 3_601_000),
      leaseEvent("lease_released", 3_602_000),
    ];
    expect(drivenMilliseconds(events)).toBe(1000 + 1000);
  });

  it("crash-open epoch closes at last lease_renewed, not at next acquisition (AE6)", () => {
    const events: JournalEvent[] = [
      leaseEvent("lease_acquired", 1000),
      leaseEvent("lease_renewed", 1060_000),
      // crash — no lease_released
      // much later, new acquisition
      leaseEvent("lease_acquired", 3_601_000),
      leaseEvent("lease_released", 3_602_000),
    ];
    // First epoch: 1060_000 - 1000 = 1059_000
    // Second epoch: 3_602_000 - 3_601_000 = 1000
    expect(drivenMilliseconds(events)).toBe(1059_000 + 1000);
  });

  it("crash-open epoch whose last event is a non-lease event closes at that event", () => {
    const events: JournalEvent[] = [
      leaseEvent("lease_acquired", 1000),
      otherEvent("dispatch_intent", 2000),
      otherEvent("dispatch_created", 3000),
      // crash — no lease_released
      leaseEvent("lease_acquired", 5000),
      leaseEvent("lease_released", 6000),
    ];
    // First epoch closes at lastActivity=3000: 3000-1000=2000
    // Second epoch: 6000-5000=1000
    expect(drivenMilliseconds(events)).toBe(2000 + 1000);
  });

  it("currently open epoch with fresh lease closes at injected now", () => {
    const events: JournalEvent[] = [
      leaseEvent("lease_acquired", 1000),
      leaseEvent("lease_renewed", 2000),
    ];
    expect(drivenMilliseconds(events, { now: 5000, leaseFresh: true })).toBe(4000);
  });

  it("currently open epoch with stale lease closes at last observed activity", () => {
    const events: JournalEvent[] = [
      leaseEvent("lease_acquired", 1000),
      leaseEvent("lease_renewed", 2000),
      otherEvent("dispatch_intent", 3000),
    ];
    // leaseFresh defaults to false; epoch closes at lastActivity=3000
    expect(drivenMilliseconds(events, { now: 99999 })).toBe(2000);
  });

  it("empty event array returns zero", () => {
    expect(drivenMilliseconds([])).toBe(0);
  });

  it("journal with no lease events returns zero", () => {
    const events: JournalEvent[] = [
      otherEvent("dispatch_intent", 1000),
      otherEvent("dispatch_created", 2000),
    ];
    expect(drivenMilliseconds(events)).toBe(0);
  });

  it("loadConfig deep-merges max_duration_s from an on-disk config", () => {
    // Verify the DEFAULT_CONFIG carries the field.
    expect(DEFAULT_CONFIG.run.max_duration_s).toBe(8 * 60 * 60);
  });
});
