/**
 * U7 acceptance predicate tests (R47-R51, R61; plan Test Scenarios, audit
 * U7.5-U7.10).
 *
 * The predicate: every criterion on the unit needs a passing evidence record at
 * or above its declared tier with no open gap referencing it. All pass -> accept;
 * any failure (or any open evidence-integrity gap) -> not_accepted, routed to
 * rework or escalation per D7.
 */
import * as fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAcceptance,
  evaluateAcceptance,
} from "../src/acceptance";
import { gradeCriterion, type CriterionGrade } from "../src/grading";
import { resolveCalibrationMetrics } from "../src/calibration";
import { closeGap, recordGap } from "../src/gap";
import type { AcceptanceCriterion, OpenGap, PlanUnit } from "../src/types";
import { cleanupTempDirs, createTestStore, type TestStore } from "./helpers";

const DET_A = { text: "criterion-a", tier: "deterministic" };
const CJ_B = { text: "criterion-b", tier: "calibrated-judge" };
const HUM_C = { text: "criterion-c", tier: "human" };

function unit(acceptance: AcceptanceCriterion[] | null): PlanUnit {
  return {
    id: "U1",
    number: 1,
    title: "one",
    goal: null,
    requirements: "R47",
    creates: [],
    inputs: [],
    dependsOn: [],
    acceptance,
  };
}

function pass(record: Partial<CriterionGrade> = {}): CriterionGrade {
  return { criterion: "criterion-a", tier: "deterministic", grade: "pass", route: null, basis: "verification:all-passed", ...record };
}

function gap(unitId: string, criterion: string, reason = "missing-evidence"): OpenGap {
  return { unit_id: unitId, criterion, reason, recorded_seq: 1 };
}

function setupStore(): TestStore {
  const t = createTestStore({ holderId: "holder-A" });
  const acquired = t.store.lease.acquire("holder-A");
  if (!acquired.ok) {
    throw new Error(`lease acquire failed: ${acquired.reason}`);
  }
  fs.writeFileSync(t.layout.planSnapshotPath, "---\n", "utf8");
  fs.writeFileSync(t.layout.unitsJsonPath, `${JSON.stringify({ U1: unit([DET_A]) }, null, 2)}\n`, "utf8");
  return t;
}

afterEach(cleanupTempDirs);

describe("acceptance", () => {
  it("all criteria pass at the deterministic tier -> accept (R51, audit U7.5)", () => {
    const verdict = evaluateAcceptance({
      unit: unit([DET_A]),
      records: [pass()],
      openGaps: [],
    });
    expect(verdict.decision).toBe("accept");
    expect(verdict.route).toBeNull();
    expect(verdict.reason).toBeNull();
    expect(verdict.criteria).toEqual([
      { criterion: "criterion-a", declaredTier: "deterministic", pass: true, reason: null, route: null },
    ]);
  });

  it("a deterministic criterion with a failed verification is not accepted and routes to rework (R51)", () => {
    const verdict = evaluateAcceptance({
      unit: unit([DET_A]),
      records: [pass({ grade: "fail", route: "rework", basis: "verification:failed" })],
      openGaps: [],
    });
    expect(verdict.decision).toBe("not_accepted");
    expect(verdict.route).toBe("rework");
    expect(verdict.criteria[0].pass).toBe(false);
  });

  it("a deterministic pass satisfies a criterion declared at a lower tier (at or above, R47)", () => {
    const verdict = evaluateAcceptance({
      unit: unit([{ ...CJ_B, tier: "calibrated-judge" }]),
      // A passing deterministic-tier record for the same criterion text.
      records: [pass({ criterion: "criterion-b" })],
      openGaps: [],
    });
    expect(verdict.decision).toBe("accept");
  });

  it("a lower-tier pass does not satisfy a criterion declared deterministic (R47)", () => {
    const verdict = evaluateAcceptance({
      unit: unit([DET_A]),
      records: [pass({ tier: "human", grade: "pass", basis: "operator-approval" })],
      openGaps: [],
    });
    expect(verdict.decision).toBe("not_accepted");
    expect(verdict.route).toBe("rework");
  });

  it("two criteria with identical text but different IDs join grades by criterion id, not text (KTD1/KTD4)", () => {
    const verdict = evaluateAcceptance({
      unit: unit([
        { id: "U1.AC1", text: "same wording", tier: "deterministic" },
        { id: "U1.AC2", text: "same wording", tier: "deterministic" },
      ]),
      // Both records carry the same display text but different stable ids:
      // the pass on AC1 must never satisfy AC2, and the fail on AC2 must not
      // pollute AC1.
      records: [
        pass({ criterion_id: "U1.AC1", criterion: "same wording", basis: "verifier-certified:all-passed" }),
        pass({ criterion_id: "U1.AC2", criterion: "same wording", grade: "fail", route: "rework", basis: "verifier-certified:failed" }),
      ],
      openGaps: [],
    });
    expect(verdict.decision).toBe("not_accepted");
    expect(verdict.route).toBe("rework");
    expect(verdict.criteria[0]).toMatchObject({ pass: true, reason: null });
    expect(verdict.criteria[1]).toMatchObject({ pass: false, reason: "no qualifying pass at or above declared tier" });
  });

  it("one criterion at calibrated-judge with an uncalibrated verifier -> verdict ungraded -> escalate (R48/R20)", () => {
    const ungraded = gradeCriterion({
      criterion: "criterion-b",
      tier: "calibrated-judge",
      verifierVerdict: "pass",
      verifierProvider: "opencode",
      verifierModel: "glm-5.2",
    });
    const verdict = evaluateAcceptance({
      unit: unit([CJ_B]),
      records: [ungraded],
      openGaps: [],
    });
    expect(ungraded).toMatchObject({ grade: "ungraded", route: "escalate" });
    expect(verdict.decision).toBe("not_accepted");
    expect(verdict.route).toBe("escalate");
    expect(verdict.reason).toContain("ungraded");
  });

  it("one criterion at calibrated-judge with a calibrated verifier -> verdict authoritative -> accept if pass (R74)", () => {
    const t = setupStore();
    // A verifier profile that clears the R74 bar.
    const file = `${t.basePath}/calibration/opencode-glm-5.2.json`;
    fs.mkdirSync(`${t.basePath}/calibration`, { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        schema: "miah/calibration-profile/v1",
        provider: "opencode",
        model: "glm-5.2",
        tiers: {
          "calibrated-judge": Array.from({ length: 15 }, (_, i) => ({ label: "pass", verdict: "pass", example: `case ${i}` })),
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const graded = gradeCriterion(
      {
        criterion: "criterion-b",
        tier: "calibrated-judge",
        verifierVerdict: "pass",
        verifierProvider: "opencode",
        verifierModel: "glm-5.2",
      },
      {
        resolveCalibration: (provider, model, tier) =>
          resolveCalibrationMetrics(provider, model, tier, t.config.calibration, t.basePath),
      },
    );
    expect(graded.grade).toBe("pass");
    const verdict = evaluateAcceptance({ unit: unit([CJ_B]), records: [graded], openGaps: [] });
    expect(verdict.decision).toBe("accept");
  });

  it("an open gap on a criterion -> not_accepted regardless of evidence (R51, audit U7.9)", () => {
    const verdict = evaluateAcceptance({
      unit: unit([DET_A]),
      records: [pass()],
      openGaps: [gap("U1", "criterion-a")],
    });
    expect(verdict.decision).toBe("not_accepted");
    expect(verdict.route).toBe("rework");
    expect(verdict.reason).toContain("open gap");
    expect(verdict.criteria[0].pass).toBe(false);
  });

  it("gap_closed for the criterion -> re-evaluate -> accept (R50, audit U7.10)", () => {
    const t = setupStore();
    recordGap(t.store, "U1", "criterion-a", "missing-evidence");
    const blocked = evaluateAcceptance({
      unit: unit([DET_A]),
      records: [pass()],
      openGaps: t.store.stateSnapshot().open_gaps,
    });
    expect(blocked.decision).toBe("not_accepted");

    const closed = closeGap(t.store, "U1", "criterion-a", "re-verification-success");
    expect(closed.ok).toBe(true);

    const after = evaluateAcceptance({
      unit: unit([DET_A]),
      records: [pass()],
      openGaps: t.store.stateSnapshot().open_gaps,
    });
    expect(after.decision).toBe("accept");
  });

  it("an evidence-integrity gap (missing declared output) blocks acceptance (R52/R61)", () => {
    const verdict = evaluateAcceptance({
      unit: unit([DET_A]),
      records: [pass()],
      openGaps: [gap("U1", "src/foo.py", "missing-declared-output")],
    });
    expect(verdict.decision).toBe("not_accepted");
    expect(verdict.blockingGaps).toHaveLength(1);
    expect(verdict.route).toBe("rework");
    expect(verdict.reason).toContain("src/foo.py");
  });

  it("a unit with no declared criteria has nothing to fail (accept)", () => {
    const verdict = evaluateAcceptance({ unit: unit(null), records: [], openGaps: [] });
    expect(verdict.decision).toBe("accept");
  });

  it("applyAcceptance journals acceptance_decision accept without escalation (R35)", () => {
    const t = setupStore();
    const verdict = evaluateAcceptance({ unit: unit([DET_A]), records: [pass()], openGaps: [] });
    const applied = applyAcceptance(t.store, verdict);
    expect(applied.decisionEvent).toMatchObject({ type: "acceptance_decision", unit_id: "U1", decision: "accept" });
    expect(applied.escalationEvent).toBeNull();
    expect(t.store.stateSnapshot().units.U1.status).toBe("accepted");
  });

  it("applyAcceptance journals escalation_raised when the verdict routes to escalation (R82)", () => {
    const t = setupStore();
    const ungraded = gradeCriterion({
      criterion: "criterion-b",
      tier: "calibrated-judge",
      verifierVerdict: "pass",
      verifierProvider: "opencode",
      verifierModel: "glm-5.2",
    });
    const verdict = evaluateAcceptance({ unit: unit([CJ_B]), records: [ungraded], openGaps: [] });
    const applied = applyAcceptance(t.store, verdict);
    expect(applied.decisionEvent).toMatchObject({ type: "acceptance_decision", decision: "not_accepted", route: "escalate" });
    expect(applied.escalationEvent).toMatchObject({
      type: "escalation_raised",
      unit_id: "U1",
      trigger: "no-checker-profile-clears-calibration-bar",
    });
  });

  it("a human-tier criterion with no operator decision escalates (R47)", () => {
    // The grading ladder grades the human-tier criterion ungraded/escalate until
    // `miah resolve` supplies an operator decision (U9).
    const pending = gradeCriterion({ criterion: "criterion-c", tier: "human" });
    expect(pending).toMatchObject({ grade: "ungraded", route: "escalate" });
    const verdict = evaluateAcceptance({ unit: unit([HUM_C]), records: [pending], openGaps: [] });
    expect(verdict.decision).toBe("not_accepted");
    expect(verdict.route).toBe("escalate");
    expect(verdict.reason).toContain("ungraded");
  });
});
