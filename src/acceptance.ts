/**
 * Acceptance predicate (R47-R51) and the integration self-containedness check
 * (R54), plus the journaled acceptance transition.
 *
 * Acceptance requires, for EVERY acceptance criterion on the unit, a passing
 * evidence record at or above the criterion's declared tier (R47:
 * deterministic > calibrated-judge > human) with no open evidence gap
 * referencing that criterion (R51). Any criterion that lacks such a pass — or
 * any open evidence-integrity gap on the unit (missing declared output R61,
 * T2-T3 divergence R46, broken custody R45, integration smuggle R54) — makes
 * the unit `not_accepted` and routes it to bounded rework or an operator
 * escalation per D7 (R52, R82).
 *
 * The integration self-containedness check (R54): the accepted `creates:`
 * paths are copied from the specialist worktree into a checkout of the
 * canonical worktree at the run base commit (R89; the checkout itself is U8's
 * orchestration — this primitive receives the already-checked-out directory),
 * and the unit's verification-contract commands run there. Any verification
 * failure in the integrated checkout means a `creates:` artifact depends on an
 * undeclared file from the builder's worktree (an integration smuggle): a
 * `gap_recorded: integration-smuggle` event is journaled and the unit cannot be
 * accepted (R54, AE17).
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { JournalEvent, OpenGap, PlanUnit } from "./types";
import { tierMeetsOrExceeds, type CriterionGrade } from "./grading";
import { deliverableFiles } from "./postflight";
import {
  createExecCommandRunner,
  type CommandResult,
  type CommandRunner,
} from "./evidence";
import type { RunStore } from "./run-store";

/** The synthetic criterion an integration-smuggle gap references. */
export const INTEGRATION_GAP_CRITERION = "integration-self-containedness";

/** The `gap_recorded` reason for an integration smuggle (R54). */
export const INTEGRATION_GAP_REASON = "integration-smuggle: undeclared dependency";

/** Per-criterion result of the acceptance predicate (R51). */
export interface CriterionResult {
  criterion: string;
  declaredTier: string | null;
  pass: boolean;
  /** Why the criterion failed, or null when it passed. */
  reason: string | null;
  /** Routing hint for a failed criterion (D7). */
  route: "rework" | "escalate" | null;
}

/** The acceptance predicate verdict for one unit (R51). */
export interface AcceptanceVerdict {
  unit_id: string;
  decision: "accept" | "not_accepted";
  criteria: CriterionResult[];
  /** Open evidence-integrity gaps (not keyed to a declared criterion) blocking acceptance. */
  blockingGaps: OpenGap[];
  /** Unit routing when not accepted (D7). */
  route: "rework" | "escalate" | null;
  /** Single most relevant failure reason, or null. */
  reason: string | null;
}

/** Input to the acceptance predicate. */
export interface AcceptanceInput {
  unit: PlanUnit;
  /** Graded evidence records produced by the grading ladder (U7 grading.ts). */
  records: CriterionGrade[];
  /** Open gaps from the reconstructed state (R42/R50 pairing). */
  openGaps: OpenGap[];
}

/**
 * The acceptance predicate (R47-R51): every criterion needs a passing evidence
 * record at or above its declared tier with no open gap referencing it.
 */
export function evaluateAcceptance(input: AcceptanceInput): AcceptanceVerdict {
  const { unit, records, openGaps } = input;
  const criteria = unit.acceptance ?? [];
  const criterionTexts = new Set(criteria.map((criterion) => criterion.text));

  const blockingGaps = openGaps.filter(
    (gap) => gap.unit_id === unit.id && !criterionTexts.has(gap.criterion),
  );

  const results: CriterionResult[] = criteria.map((criterion) => {
    const gap = openGaps.find(
      (open) => open.unit_id === unit.id && open.criterion === criterion.text,
    );
    if (gap !== undefined) {
      return {
        criterion: criterion.text,
        declaredTier: criterion.tier,
        pass: false,
        reason: `open gap: ${gap.reason}`,
        route: "rework",
      };
    }
    const qualifying = records.filter(
      (record) =>
        record.criterion === criterion.text &&
        record.grade === "pass" &&
        tierMeetsOrExceeds(record.tier, criterion.tier),
    );
    if (qualifying.length > 0) {
      return { criterion: criterion.text, declaredTier: criterion.tier, pass: true, reason: null, route: null };
    }
    const forCriterion = records.filter((record) => record.criterion === criterion.text);
    const escalate = forCriterion.some(
      (record) => record.grade === "ungraded" && record.route === "escalate",
    );
    return {
      criterion: criterion.text,
      declaredTier: criterion.tier,
      pass: false,
      reason: escalate
        ? "verdict is ungraded (calibration bar not cleared / operator judgment required, R48)"
        : "no qualifying pass at or above declared tier",
      route: escalate ? "escalate" : "rework",
    };
  });

  const failed = results.filter((result) => !result.pass);
  const blockedReason =
    blockingGaps.length > 0
      ? `open evidence gap(s): ${blockingGaps.map((g) => `${g.criterion} (${g.reason})`).join(", ")}`
      : null;

  if (failed.length === 0 && blockingGaps.length === 0) {
    return { unit_id: unit.id, decision: "accept", criteria: results, blockingGaps, route: null, reason: null };
  }

  const escalate = failed.some((result) => result.route === "escalate");
  const route = blockingGaps.length > 0 ? "rework" : escalate ? "escalate" : "rework";
  const reason = blockedReason ?? failed[0]?.reason ?? "not accepted";
  return { unit_id: unit.id, decision: "not_accepted", criteria: results, blockingGaps, route, reason };
}

/** The journaled acceptance transition. */
export interface ApplyAcceptanceResult {
  /** The `acceptance_decision` event (R35). */
  decisionEvent: JournalEvent;
  /** An `escalation_raised` event when the verdict routes to escalation (R82). */
  escalationEvent: JournalEvent | null;
}

/**
 * Journal an acceptance decision. When the verdict is `not_accepted` and the
 * route is escalation, also appends `escalation_raised` (R82 trigger: no
 * checker profile clears the calibration bar, or operator judgment required).
 */
export function applyAcceptance(
  store: RunStore,
  verdict: AcceptanceVerdict,
): ApplyAcceptanceResult {
  const decisionEvent = store.append("acceptance_decision", {
    unit_id: verdict.unit_id,
    decision: verdict.decision,
    route: verdict.route,
    reason: verdict.reason,
    criteria: verdict.criteria.map((result) => ({
      criterion: result.criterion,
      tier: result.declaredTier,
      pass: result.pass,
    })),
  });
  let escalationEvent: JournalEvent | null = null;
  if (verdict.decision === "not_accepted" && verdict.route === "escalate") {
    const firstEscalated = verdict.criteria.find((result) => result.route === "escalate");
    escalationEvent = store.append("escalation_raised", {
      unit_id: verdict.unit_id,
      criterion: firstEscalated?.criterion ?? null,
      reason: verdict.reason ?? "criterion requires operator judgment",
      trigger:
        firstEscalated?.declaredTier === "human"
          ? "operator-judgment-required"
          : "no-checker-profile-clears-calibration-bar",
    });
  }
  return { decisionEvent, escalationEvent };
}

/** Input to the integration self-containedness check (R54). */
export interface IntegrationInput {
  store: RunStore;
  unit: PlanUnit;
  /** The specialist worktree that produced the deliverables. */
  sourceWorktree: string;
  /** The canonical worktree checked out at the run base commit (R89). */
  canonicalWorktree: string;
  /** The unit's verification-contract commands (R45, R54). */
  verificationCommands: string[];
  runCommand?: CommandRunner;
  /**
   * R89 hook: commit the integrated `creates:` paths in the canonical
   * worktree after verification passes. Absent (unit-test harness) or a
   * non-git canonical checkout: nothing is committed.
   */
  commitIntegration?: (canonicalWorktree: string, unit: PlanUnit) => void;
}

/**
 * R89: commit the accepted unit's `creates:` paths in the canonical worktree
 * so a later dependent unit's worktree (branched off the canonical HEAD) sees
 * the dependency's integrated deliverable. No-op for a non-git canonical
 * checkout (the pure unit-test harness drives integration against a plain
 * temp dir) and idempotent on resume (`git commit` with nothing staged).
 */
export function commitIntegrationFiles(canonicalWorktree: string, unit: PlanUnit): void {
  const creates = unit.creates ?? [];
  if (creates.length === 0) {
    return;
  }
  if (!fs.existsSync(path.join(canonicalWorktree, ".git"))) {
    return;
  }
  cp.execFileSync("git", ["add", "--", ...creates], { cwd: canonicalWorktree, stdio: "ignore" });
  try {
    cp.execFileSync(
      "git",
      [
        "-c", "user.name=miah",
        "-c", "user.email=miah@local",
        "commit", "-m", `miah: integrate ${unit.id}`,
      ],
      // Pipe so a real failure's stderr surfaces in the thrown error and the
      // "nothing to commit" idempotency check below can actually match (the
      // commit is a no-op when a resume re-runs an already-committed integrate).
      { cwd: canonicalWorktree, stdio: "pipe" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/nothing to commit/i.test(message)) {
      throw error;
    }
  }
}

/** Outcome of the integration self-containedness check (R54). */
export interface IntegrationOutcome {
  ok: boolean;
  /** Verification results from the integrated canonical checkout. */
  results: CommandResult[];
  /** The `creates:` paths copied into the canonical checkout (R53/R89). */
  copied: string[];
  /** `gap_recorded: integration-smuggle` on failure, else null (R54). */
  gap: JournalEvent | null;
}

/**
 * Run the integration self-containedness check (R54): copy the accepted
 * `creates:` deliverables from the specialist worktree into the canonical
 * checkout and run the verification contract commands there. Any verification
 * failure is recorded as `gap_recorded: integration-smuggle: undeclared
 * dependency` — the mechanical reading that a `creates:` artifact depends on a
 * file the plan did not declare (AE17).
 */
export async function runIntegrationCheck(input: IntegrationInput): Promise<IntegrationOutcome> {
  const { store, unit, sourceWorktree, canonicalWorktree, verificationCommands } = input;
  const runCommand = input.runCommand ?? createExecCommandRunner();

  const copied = deliverableFiles(sourceWorktree, unit.creates);
  for (const relPath of copied) {
    const src = path.join(sourceWorktree, ...relPath.split("/"));
    const dst = path.join(canonicalWorktree, ...relPath.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  const results: CommandResult[] = [];
  for (const command of verificationCommands) {
    results.push(await runCommand(command, canonicalWorktree));
  }
  const ok = results.every((result) => result.exit_code === 0);

  if (ok) {
    // R89: commit the integrated deliverables once verification passes.
    input.commitIntegration?.(canonicalWorktree, unit);
  }

  let gap: JournalEvent | null = null;
  if (!ok) {
    gap = store.append("gap_recorded", {
      unit_id: unit.id,
      criterion: INTEGRATION_GAP_CRITERION,
      reason: INTEGRATION_GAP_REASON,
    });
  }
  return { ok, results, copied, gap };
}

/** Input to the composed acceptance transition (R51 + R54). */
export interface UnitAcceptanceInput extends AcceptanceInput {
  store: RunStore;
  integration: IntegrationInput;
}

/** Outcome of the composed acceptance transition. */
export interface UnitAcceptanceOutcome {
  verdict: AcceptanceVerdict;
  /** Null when the criteria predicate already rejected the unit (R54 runs only on the acceptance transition). */
  integration: IntegrationOutcome | null;
  applied: ApplyAcceptanceResult;
}

/**
 * The acceptance transition (R51 + R54): evaluate the criteria predicate; if
 * it accepts, run the integration self-containedness check; if that passes,
 * journal `acceptance_decision: accept`. A failed integration journals the
 * smuggle gap and re-evaluates so the predicate sees it (blocking acceptance).
 */
export async function evaluateUnitAcceptance(
  input: UnitAcceptanceInput,
): Promise<UnitAcceptanceOutcome> {
  const verdict = evaluateAcceptance(input);
  if (verdict.decision !== "accept") {
    return { verdict, integration: null, applied: applyAcceptance(input.store, verdict) };
  }
  const integration = await runIntegrationCheck(input.integration);
  if (!integration.ok) {
    const afterGap = evaluateAcceptance({
      unit: input.unit,
      records: input.records,
      openGaps: input.store.stateSnapshot().open_gaps,
    });
    return { verdict: afterGap, integration, applied: applyAcceptance(input.store, afterGap) };
  }
  return { verdict, integration, applied: applyAcceptance(input.store, verdict) };
}
