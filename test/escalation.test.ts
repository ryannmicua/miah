/**
 * U8 escalation tests (R66, R82; audit U8.13).
 *
 * The trigger set covers every R82 condition; `raiseEscalation` appends
 * `escalation_raised` with a stable escalation id; `unresolvedEscalations`
 * pairs raised/resolved so the driver can report what blocks the run (R66).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ESCALATION_TRIGGERS,
  raiseEscalation,
  unresolvedEscalations,
} from "../src/escalation";
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

describe("escalation", () => {
  it("the trigger set includes every R82 trigger (U8.13)", () => {
    for (const trigger of [
      "max-takes-exceeded",
      "max-rework-cycles-exceeded",
      "no-progress",
      "scope-change-needed",
      "security-risk",
      "destructive-side-effect",
      "unresolved-high-severity-failure",
      "missing-access-or-judgment",
      "cost-ceiling-exceeded",
      "no-checker-profile-clears-calibration-bar",
    ]) {
      expect(ESCALATION_TRIGGERS).toContain(trigger);
    }
    // The R77/R78 "repeatedly-fails" escalation and the R66 blocked trigger.
    expect(ESCALATION_TRIGGERS).toContain("repeatedly-fails");
    expect(ESCALATION_TRIGGERS).toContain("blocked-no-eligible-work");
  });

  it("raiseEscalation journals escalation_raised with a stable esc-<seq> id (R35)", () => {
    const t = setupStore();
    const nextSeq = t.store.journal.currentSeq() + 1;
    const result = raiseEscalation(t.store, {
      unit_id: "U1",
      trigger: "no-progress",
      reason: "no lifecycle change for 3 polls (R76)",
    });
    expect(result.escalation_id).toBe(`esc-${nextSeq}`);
    expect(result.event).toMatchObject({
      type: "escalation_raised",
      unit_id: "U1",
      trigger: "no-progress",
      reason: "no lifecycle change for 3 polls (R76)",
    });
    expect(result.event.seq).toBe(nextSeq);
  });

  it("unresolvedEscalations returns open escalations and closes them on escalation_resolved", () => {
    const t = setupStore();
    const a = raiseEscalation(t.store, { unit_id: "U1", trigger: "no-progress", reason: "a" });
    const b = raiseEscalation(t.store, { unit_id: "U2", trigger: "repeatedly-fails", reason: "b" });
    const open = unresolvedEscalations(t.store);
    expect(open.map((e) => e.escalation_id)).toEqual([a.escalation_id, b.escalation_id]);
    expect(open[0]).toMatchObject({ unit_id: "U1", trigger: "no-progress", reason: "a" });

    // Resolving closes the most recent open escalation (U9 resolve flow).
    t.store.append("escalation_resolved", { escalation_id: b.escalation_id, decision: "rework" });
    const remaining = unresolvedEscalations(t.store);
    expect(remaining.map((e) => e.escalation_id)).toEqual([a.escalation_id]);
  });

  it("unresolvedEscalations is reconstructable from the journal alone (R42)", () => {
    const t = setupStore();
    const a = raiseEscalation(t.store, { unit_id: "U1", trigger: "cost-ceiling-exceeded", reason: "over budget" });
    const reopened = unresolvedEscalations(t.store);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({
      escalation_id: a.escalation_id,
      trigger: "cost-ceiling-exceeded",
    });
  });

  it("an escalation id survives replay: esc-<seq> is deterministic", () => {
    const t = setupStore();
    const first = raiseEscalation(t.store, { unit_id: "U3", trigger: "no-progress", reason: "x" });
    const events = t.store.journal.readEvents();
    const raised = events.find((event) => event.type === "escalation_raised");
    expect(raised?.escalation_id).toBe(first.escalation_id);
    expect(first.escalation_id).toBe(`esc-${first.event.seq}`);
  });
});
