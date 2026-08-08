/**
 * U7 gap pairing tests (R50, R52; audit U7.11).
 *
 * `gap_recorded(unit, criterion, reason)` opens a gap; `gap_closed(unit,
 * criterion, close_reason)` closes it. The pairing is enforced: a close with no
 * matching open gap is refused, and the close reason must be in the R50 set.
 */
import * as fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeGap, findOpenGap, hasOpenGap, recordGap, GAP_CLOSE_REASONS } from "../src/gap";
import { cleanupTempDirs, createTestStore, type TestStore } from "./helpers";

function setupStore(): TestStore {
  const t = createTestStore({ holderId: "holder-A" });
  const acquired = t.store.lease.acquire("holder-A");
  if (!acquired.ok) {
    throw new Error(`lease acquire failed: ${acquired.reason}`);
  }
  fs.writeFileSync(t.layout.planSnapshotPath, "---\n", "utf8");
  fs.writeFileSync(t.layout.unitsJsonPath, `${JSON.stringify({ U1: { id: "U1", number: 1, title: "one", goal: null, requirements: null, creates: [], inputs: [], dependsOn: [], acceptance: null } }, null, 2)}\n`, "utf8");
  return t;
}

afterEach(cleanupTempDirs);

describe("gap", () => {
  it("gap_recorded opens a gap visible in the reconstructed state (R52)", () => {
    const t = setupStore();
    const event = recordGap(t.store, "U1", "criterion-a", "missing-evidence");
    expect(event).toMatchObject({ type: "gap_recorded", unit_id: "U1", criterion: "criterion-a", reason: "missing-evidence" });
    const open = t.store.stateSnapshot().open_gaps;
    expect(hasOpenGap(open, "U1", "criterion-a")).toBe(true);
    const gap = findOpenGap(open, "U1", "criterion-a");
    expect(gap?.recorded_seq).toBe(event.seq);
  });

  it("gap_closed requires a matching open gap (pairing enforced, R50)", () => {
    const t = setupStore();
    const closed = closeGap(t.store, "U1", "criterion-a", "rework-take");
    expect(closed.ok).toBe(false);
    expect(closed.error).toContain("no open gap");
    expect(closed.event).toBeNull();
    // Nothing was journaled.
    expect(t.store.journal.readEvents().some((e) => e.type === "gap_closed")).toBe(false);
  });

  it("gap_closed refuses a close reason outside the R50 set (R50)", () => {
    const t = setupStore();
    recordGap(t.store, "U1", "criterion-a", "missing-evidence");
    const bad = closeGap(t.store, "U1", "criterion-a", "i-fixed-it-silently");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("invalid gap close reason");
    expect(hasOpenGap(t.store.stateSnapshot().open_gaps, "U1", "criterion-a")).toBe(true);
  });

  it("gap_closed closes the open gap with the close reason recorded (R50)", () => {
    const t = setupStore();
    recordGap(t.store, "U1", "criterion-a", "missing-evidence");
    const closed = closeGap(t.store, "U1", "criterion-a", "operator-approval");
    expect(closed.ok).toBe(true);
    expect(closed.event).toMatchObject({ type: "gap_closed", unit_id: "U1", criterion: "criterion-a", close_reason: "operator-approval" });
    expect(hasOpenGap(t.store.stateSnapshot().open_gaps, "U1", "criterion-a")).toBe(false);
  });

  it("closing one gap does not close a different open gap on the same unit (R50 pairing)", () => {
    const t = setupStore();
    recordGap(t.store, "U1", "criterion-a", "reason-a");
    recordGap(t.store, "U1", "criterion-b", "reason-b");
    closeGap(t.store, "U1", "criterion-a", "rework-take");
    expect(hasOpenGap(t.store.stateSnapshot().open_gaps, "U1", "criterion-a")).toBe(false);
    expect(hasOpenGap(t.store.stateSnapshot().open_gaps, "U1", "criterion-b")).toBe(true);
  });

  it("the R50 close-reason set is exactly the mandated four", () => {
    expect(GAP_CLOSE_REASONS).toEqual([
      "rework-take",
      "re-verification-success",
      "operator-approval",
      "deadline-still-in-effect-cleared",
    ]);
  });
});
