/**
 * The D5 grading ladder (R28, R47) and the grader that maps evidence to a
 * verdict for one acceptance criterion.
 *
 * Tiers, highest authority first: `deterministic` (test/exit-code/schema/file/
 * hash bits — a mechanical pass, R47), `calibrated-judge` (a verifier verdict
 * that gains acceptance authority ONLY when its calibration profile clears the
 * R74 bar — the pass is operator-assisted, never granted by family membership,
 * R47/R48), and `human` (operator judgment, the natural fallback, R47).
 *
 * A criterion is graded `pass` / `fail` / `ungraded`. An `ungraded` verdict
 * carries no acceptance authority: the calibrated-judge tier escalates when no
 * profile clears the bar (R48/R20), and the human tier escalates until the
 * operator supplies a decision.
 *
 * Grade sources (KTD6): Miah never creates a grade. The inputs here are the
 * verifier's envelope entries (KD1) and operator decisions (KD4); grading maps
 * those inputs through the ladder and applies the calibration authority gate.
 *
 * The `tier` field on each graded record is the tier the evidence actually
 * occupied; the acceptance predicate compares it against each criterion's
 * declared tier ("pass at or above the declared tier", R47/R51 — except that
 * human-tier criteria are satisfied only by an operator grade, R16).
 */
import type { CalibrationMetrics } from "./calibration";
import { GRADING_TIERS, type CriterionGradeRef, type GradingTier } from "./types";

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
  /** The stable criterion id this verdict speaks to (KTD1), when known. */
  criterion_id?: string | null;
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
 * Materialize durable grade references (KTD6) into the acceptance predicate's
 * verdict records. Resume re-evaluates from these durable references, never
 * from specialist prose.
 */
export function gradesFromRefs(refs: CriterionGradeRef[]): CriterionGrade[] {
  return refs.map((ref) => ({
    criterion_id: ref.criterion_id,
    criterion: ref.criterion,
    tier: ref.tier as CriterionGrade["tier"],
    grade: ref.grade,
    route: ref.route,
    basis: ref.basis,
  }));
}

/**
 * The evidence available to grade one criterion. The verifier verdict for the
 * calibrated-judge tier is read from the verifier's v2 envelope by the caller
 * (U5); grading is pure and never parses files itself.
 */
export interface CriterionEvidence {
  /** The acceptance criterion text. */
  criterion: string;
  /** The tier the evidence occupies. */
  tier: GradingTier | null;
  /**
   * deterministic: the verifier's certification verdict from the mechanical
   * evidence (contract commands all-passed, evidence genuine and complete,
   * KTD6/KD6) — never Miah's own reading of `all_passed`. `ungraded` is the
   * verifier's own declaration (KTD4) that it withholds a verdict; `null`
   * means the envelope entry is missing entirely (R43).
   */
  verifierVerdict?: "pass" | "fail" | "ungraded" | null;
  /** calibrated-judge: verifier provider/model for the calibration lookup (R20). */
  verifierProvider?: string | null;
  verifierModel?: string | null;
  /** human: the operator decision (U6), if any. */
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

/**
 * deterministic: the verifier's certification verdict passes through (KD6:
 * deterministic certification needs no calibration authority — custody already
 * proves evidence integrity; the verifier certifies completeness and
 * genuineness over the custody-verified artifacts, R3).
 */
function gradeDeterministic(evidence: CriterionEvidence): CriterionGrade {
  if (evidence.verifierVerdict === "pass") {
    return { criterion: evidence.criterion, tier: "deterministic", grade: "pass", route: null, basis: "verifier-certified:all-passed" };
  }
  if (evidence.verifierVerdict === "fail") {
    return { criterion: evidence.criterion, tier: "deterministic", grade: "fail", route: "rework", basis: "verifier-certified:failed" };
  }
  if (evidence.verifierVerdict === "ungraded") {
    // KTD4/R48: the verifier itself declared the mechanical evidence
    // insufficient for a verdict — authority-respecting escalation, never
    // builder rework on a grade the verifier did not give.
    return { criterion: evidence.criterion, tier: "deterministic", grade: "ungraded", route: "escalate", basis: "verifier-ungraded: mechanical evidence insufficient" };
  }
  return { criterion: evidence.criterion, tier: "deterministic", grade: "ungraded", route: "rework", basis: "no-verifier-certification" };
}

/**
 * calibrated-judge: the verifier verdict is authoritative only when the
 * verifier's profile clears the R74 bar; otherwise the verdict is an ungraded
 * input that escalates per R48/R20.
 */
function gradeCalibratedJudge(evidence: CriterionEvidence, deps: GradeDeps): CriterionGrade {
  const verdict = evidence.verifierVerdict;
  if (verdict === "ungraded") {
    // KTD4/R48: the verifier declared judgment unavailable — the escalation
    // is the verifier's own authority respected, not builder rework.
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "ungraded", route: "escalate", basis: "verifier-ungraded: judgment unavailable" };
  }
  if (verdict !== "pass" && verdict !== "fail") {
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "ungraded", route: "rework", basis: "no-verifier-verdict (missing envelope, R43)" };
  }
  const provider = evidence.verifierProvider;
  const model = evidence.verifierModel;
  if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) {
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "ungraded", route: "escalate", basis: "verifier-provenance-unrecorded (R20)" };
  }
  const metrics = deps.resolveCalibration ? deps.resolveCalibration(provider, model, "calibrated-judge") : null;
  if (metrics === null || !metrics.bar_cleared) {
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "ungraded", route: "escalate", basis: "verifier-not-calibrated (R48/R20)" };
  }
  if (verdict === "pass") {
    return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "pass", route: null, basis: "calibrated-verifier-verdict:pass" };
  }
  return { criterion: evidence.criterion, tier: "calibrated-judge", grade: "fail", route: "rework", basis: "calibrated-verifier-verdict:fail" };
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
