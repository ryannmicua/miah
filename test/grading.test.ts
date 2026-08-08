/**
 * U7 grading ladder tests (R28, R47, R48, R74; plan Test Scenarios).
 *
 * Covers the three tiers and their exact semantics: `deterministic` grades
 * pass/fail from verification exit codes; `calibrated-judge` makes a reviewer
 * verdict authoritative only when the profile clears the R74 bar, else the
 * verdict is an ungraded input that escalates (R48/R20); `human` is ungraded
 * until the operator decides (R47).
 */
import { describe, expect, it } from "vitest";
import {
  gradeCriterion,
  tierMeetsOrExceeds,
  tierRank,
  type CalibrationResolver,
} from "../src/grading";
import { computeCalibrationMetrics, type CalibrationCase } from "../src/calibration";
import { DEFAULT_CONFIG } from "../src/types";

const BAR = DEFAULT_CONFIG.calibration;

function clearedCorpus(): CalibrationCase[] {
  return Array.from({ length: 15 }, (_, i) => ({
    label: "pass" as const,
    verdict: "pass" as const,
    example: `case ${i}`,
  }));
}

/** A resolver that returns cleared metrics only when `cleared` is true. */
function resolver(cleared: boolean): CalibrationResolver {
  return (provider, model, tier) =>
    computeCalibrationMetrics(provider, model, tier, cleared ? clearedCorpus() : [], BAR);
}

describe("grading", () => {
  it("ranks deterministic above calibrated-judge above human (R47)", () => {
    expect(tierRank("deterministic")).toBeGreaterThan(tierRank("calibrated-judge"));
    expect(tierRank("calibrated-judge")).toBeGreaterThan(tierRank("human"));
    expect(tierRank(null)).toBe(0);
    expect(tierRank("unknown")).toBe(0);
  });

  it("a deterministic pass satisfies a criterion declared at a lower tier (at or above, R47)", () => {
    expect(tierMeetsOrExceeds("deterministic", "calibrated-judge")).toBe(true);
    expect(tierMeetsOrExceeds("deterministic", "human")).toBe(true);
    expect(tierMeetsOrExceeds("calibrated-judge", "deterministic")).toBe(false);
    expect(tierMeetsOrExceeds("human", "deterministic")).toBe(false);
    expect(tierMeetsOrExceeds("calibrated-judge", "calibrated-judge")).toBe(true);
  });

  it("deterministic: test pass -> pass, test failure -> fail (R47)", () => {
    const pass = gradeCriterion({ criterion: "C1", tier: "deterministic", verificationAllPassed: true });
    expect(pass).toMatchObject({ grade: "pass", route: null, basis: "verification:all-passed" });
    const fail = gradeCriterion({ criterion: "C1", tier: "deterministic", verificationAllPassed: false });
    expect(fail).toMatchObject({ grade: "fail", route: "rework", basis: "verification:failed" });
  });

  it("deterministic: no verification evidence is an ungraded input (R52)", () => {
    const ungraded = gradeCriterion({ criterion: "C1", tier: "deterministic" });
    expect(ungraded).toMatchObject({ grade: "ungraded", route: "rework", basis: "no-verification-evidence" });
  });

  it("calibrated-judge: a reviewer that is not calibrated -> verdict ungraded -> escalate (R48/R20, audit U7.6)", () => {
    const graded = gradeCriterion(
      {
        criterion: "C2",
        tier: "calibrated-judge",
        reviewerVerdict: "pass",
        reviewerProvider: "opencode",
        reviewerModel: "glm-5.2",
      },
      { resolveCalibration: resolver(false) },
    );
    expect(graded).toMatchObject({ grade: "ungraded", route: "escalate", tier: "calibrated-judge" });
    expect(graded.basis).toContain("not-calibrated");
  });

  it("calibrated-judge: no calibration resolver at all means no authority (default-empty, R48)", () => {
    const graded = gradeCriterion({
      criterion: "C2",
      tier: "calibrated-judge",
      reviewerVerdict: "pass",
      reviewerProvider: "opencode",
      reviewerModel: "glm-5.2",
    });
    expect(graded).toMatchObject({ grade: "ungraded", route: "escalate" });
  });

  it("calibrated-judge: a calibrated reviewer's pass verdict is authoritative (R74, audit U7.7)", () => {
    const graded = gradeCriterion(
      {
        criterion: "C2",
        tier: "calibrated-judge",
        reviewerVerdict: "pass",
        reviewerProvider: "opencode",
        reviewerModel: "glm-5.2",
      },
      { resolveCalibration: resolver(true) },
    );
    expect(graded).toMatchObject({ grade: "pass", route: null });
    expect(graded.basis).toContain("calibrated-reviewer-verdict");
  });

  it("calibrated-judge: a calibrated reviewer's fail verdict is authoritative fail (R74)", () => {
    const graded = gradeCriterion(
      {
        criterion: "C2",
        tier: "calibrated-judge",
        reviewerVerdict: "fail",
        reviewerProvider: "opencode",
        reviewerModel: "glm-5.2",
      },
      { resolveCalibration: resolver(true) },
    );
    expect(graded).toMatchObject({ grade: "fail", route: "rework" });
  });

  it("calibrated-judge: a missing reviewer verdict is an ungraded input (missing envelope, R43/R52)", () => {
    const graded = gradeCriterion({
      criterion: "C2",
      tier: "calibrated-judge",
      reviewerVerdict: null,
      reviewerProvider: "opencode",
      reviewerModel: "glm-5.2",
    });
    expect(graded).toMatchObject({ grade: "ungraded", route: "rework", basis: expect.stringContaining("no-reviewer-verdict") });
  });

  it("calibrated-judge: unrecorded reviewer provenance cannot clear the bar (R20)", () => {
    const graded = gradeCriterion(
      { criterion: "C2", tier: "calibrated-judge", reviewerVerdict: "pass" },
      { resolveCalibration: resolver(true) },
    );
    expect(graded).toMatchObject({ grade: "ungraded", route: "escalate", basis: expect.stringContaining("provenance") });
  });

  it("human: ungraded and escalating until the operator decides (R47, audit U7.14)", () => {
    const pending = gradeCriterion({ criterion: "C3", tier: "human" });
    expect(pending).toMatchObject({ grade: "ungraded", route: "escalate", basis: "awaiting-operator-judgment" });
    const approved = gradeCriterion({ criterion: "C3", tier: "human", operatorDecision: "approve" });
    expect(approved).toMatchObject({ grade: "pass", route: null, basis: "operator-approval" });
    const rejected = gradeCriterion({ criterion: "C3", tier: "human", operatorDecision: "reject" });
    expect(rejected).toMatchObject({ grade: "fail", route: "rework", basis: "operator-rejection" });
  });

  it("an undeclared tier carries no grading authority and escalates fail-closed (R28)", () => {
    const graded = gradeCriterion({ criterion: "C4", tier: null });
    expect(graded).toMatchObject({ grade: "ungraded", route: "escalate" });
    expect(graded.basis).toContain("undeclared-tier");
  });
});
