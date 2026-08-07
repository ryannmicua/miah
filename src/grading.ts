/**
 * The D5 grading ladder (R28, R47) and the grader that maps evidence to a
 * verdict for one acceptance criterion.
 *
 * Tiers, highest authority first: `deterministic` (test/exit-code/schema/file/
 * hash bits — a mechanical pass, R47), `calibrated-judge` (a reviewer verdict
 * that gains acceptance authority ONLY when its calibration profile clears the
 * R74 bar — the pass is operator-assisted, never granted by family membership,
 * R47/R48), and `human` (operator judgment, the natural fallback, R47).
 *
 * A criterion is graded `pass` / `fail` / `ungraded`. An `ungraded` verdict
 * carries no acceptance authority: the calibrated-judge tier escalates when no
 * profile clears the bar (R48/R20), and the human tier escalates until
 * `miah resolve` (U9) supplies an operator decision.
 *
 * The `tier` field on each graded record is the tier the evidence actually
 * occupied; the acceptance predicate compares it against each criterion's
 * declared tier ("pass at or above the declared tier", R47/R51).
 */
import type { CalibrationMetrics } from "./calibration";
import { GRADING_TIERS, type GradingTier } from "./types";

/** Authority rank per tier: higher rank satisfies a criterion declared at any lower-or-equal rank. */
export const TIER_RANK: Record<string, number> = {
  deterministic: 3,
  "calibrated-judge": 2,
  human: 1,
};

/** Numeric authority rank of a tier; an unknown/absent tier has rank 0 (no authority). */
export function tierRank(tier: string | null | undefined): number {
  if (tier === null || tier === undefined) {
    return 0;
  }
  return TIER_RANK[tier] ?? 0;
}

/** True when an evidence record at `actual` satisfies a criterion declared at `declared`. */
export function tierMeetsOrExceeds(
  actual: string | null | undefined,
  declared: string | null | undefined,
): boolean {
  return tierRank(actual) >= tierRank(declared);
}

/** A graded verdict for one criterion. */
export type CriterionGradeValue = "pass" | "fail" | "ungraded";

/** Routing hint for a non-pass verdict (D7): rework or operator escalation. */
export type GradeRoute = "escalate" | "rework" | null;

/** The outcome of grading one acceptance criterion. */
export interface CriterionGrade {
  /** The acceptance criterion text this verdict speaks to. */
  criterion: string;
  /** The tier the evidence actually occupied (R47 ladder). */
  tier: GradingTier;
  grade: CriterionGradeValue;
  route: GradeRoute;
  /** Audit basis: what supported (or withheld) this grade. */
  basis: string;
}

/**
 * The evidence available to grade one criterion. The reviewer verdict for the
 * calibrated-judge tier is read from the reviewer's result envelope by the
 * caller (U5/U8); grading is pure and never parses files itself.
 */
export interface CriterionEvidence {
  /** The acceptance criterion text. */
  criterion: string;
  /** The tier the evidence occupies. */
  tier: GradingTier | null;
  /**
   * deterministic: true when the unit's verification contract all-passed
   * (`EvidenceRecord.verification.all_passed`, U6).
   */
  verificationAllPassed?: boolean;
  /**
   * calibrated-judge: the reviewer verdict extracted from the envelope
   * (R43/R49). Absent (undefined/null) means the envelope carried no verdict.
   */
  reviewerVerdict?: "pass" | "fail" | null;
  /** calibrated-judge: reviewer provider/model for the calibration lookup (R20). */
  reviewerProvider?: string | null;
  reviewerModel?: string | null;
  /** human: the operator decision from `miah resolve` (U9), if any. */
  operatorDecision?: "approve" | "reject" | null;
}

/** Looks up the calibration metrics for a (provider, model, tier) triple. */
export type CalibrationResolver = (
  provider: string,
  model: string,
  tier: string,
) => CalibrationMetrics | null;

/** Dependencies for grading. */
export interface GradeDeps {
  /** Calibration lookup; absent resolves every calibrated-judge verdict as not calibrated (R48). */
  resolveCalibration?: CalibrationResolver;
}

/** True when `tier` is one of the D5 ladder tiers (R28). */
export function isGradingTier(tier: string | null | undefined): tier is GradingTier {
  return tier !== null && tier !== undefined && (GRADING_TIERS as readonly string[]).includes(tier);
}

/**
 * Grade one criterion on the ladder (R47). A null/unknown tier is fail-closed:
 * it carries no grading authority and escalates.
 */
export function gradeCriterion(evidence: CriterionEvidence, deps: GradeDeps = {}): CriterionGrade {
  if (!isGradingTier(evidence.tier)) {
    return {
      criterion: evidence.criterion,
      tier: "human",
      grade: "ungraded",
      route: "escalate",
      basis: "undeclared-tier: no grading authority (R28)",
    };
  }
  switch (evidence.tier) {
    case "deterministic":
      return gradeDeterministic(evidence);
    case "calibrated-judge":
      return gradeCalibratedJudge(evidence, deps);
    case "human":
      return gradeHuman(evidence);
  }
}

/** deterministic: pass/fail from the verification-contract exit codes (R45/R47). */
function gradeDeterministic(evidence: CriterionEvidence): CriterionGrade {
  if (evidence.verificationAllPassed === true) {
    return { criterion: evidence.criterion, tier: "deterministic", grade: "pass", route: null, basis: "verification:all-passed" };
  }
  if (evidence.verificationAllPassed === false) {
    return { criterion: evidence.criterion, tier: "deterministic", grade: "fail", route: "rework", basis: "verification:failed" };
  }
  return { criterion: evidence.criterion, tier: "deterministic", grade: "ungraded", route: "rework", basis: "no-verification-evidence" };
}

/**
 * calibrated-judge: the reviewer verdict is authoritative only when the
 * reviewer's profile clears the R74 bar; otherwise the verdict is an ungraded
 * input that escalates per R48/R20.
 */
function gradeCalibratedJudge(evidence: CriterionEvidence, deps: GradeDeps): CriterionGrade {
  const verdict = evidence.reviewerVerdict;
  if (verdict !== "pass" && verdict !== "fail") {
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "ungraded", route: "rework", basis: "no-reviewer-verdict (missing envelope, R43)" };
  }
  const provider = evidence.reviewerProvider;
  const model = evidence.reviewerModel;
  if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) {
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "ungraded", route: "escalate", basis: "reviewer-provenance-unrecorded (R20)" };
  }
  const metrics = deps.resolveCalibration ? deps.resolveCalibration(provider, model, "calibrated-judge") : null;
  if (metrics === null || !metrics.bar_cleared) {
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "ungraded", route: "escalate", basis: "reviewer-not-calibrated (R48/R20)" };
  }
  if (verdict === "pass") {
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "pass", route: null, basis: "calibrated-reviewer-verdict:pass" };
  }
  return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "fail", route: "rework", basis: "calibrated-reviewer-verdict:fail" };
}

/**
 * human: operator judgment is the only authority (R47); the criterion is
 * ungraded (and escalates) until `miah resolve` supplies a decision (U9).
 */
function gradeHuman(evidence: CriterionEvidence): CriterionGrade {
  if (evidence.operatorDecision === "approve") {
    return { criterion: evidence.criterion, tier: "human", grade: "pass", route: null, basis: "operator-approval" };
  }
  if (evidence.operatorDecision === "reject") {
    return { criterion: evidence.criterion, tier: "human", grade: "fail", route: "rework", basis: "operator-rejection" };
  }
  return { criterion: evidence.criterion, tier: "human", grade: "ungraded", route: "escalate", basis: "awaiting-operator-judgment" };
}
