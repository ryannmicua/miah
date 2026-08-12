/**
 * `miah resolve <run-id> <escalation-id> --decision <approve|deny|rework> [--note <text>]`
 * command (R66, R69, F14, KTD6-KTD7).
 *
 * Closes one pending escalation with the operator's decision and records it as
 * a durable criterion-level grade (KTD6): verifier envelope entries and
 * operator decisions are the only grade sources, and `miah resolve` supplies
 * the operator side.
 *
 * Criterion-bearing escalation (declared human, verifier flag, or uncleared
 * calibration): `approve` records an operator PASS grade for exactly that
 * criterion, `rework` records an operator FAIL grade — then closes the
 * escalation's paired gaps and re-evaluates the acceptance predicate over ALL
 * durable grades. Neither decision short-circuits the whole unit: the unit is
 * accepted only when the predicate accepts, and unrelated criteria stay
 * blocking (KTD7, U6).
 *
 * Verifier operational escalation (`criterion: null`): `approve` resets the
 * verifier-attempt counter and retries the same frozen candidate; `rework`
 * starts a new builder take. Neither accepts the unit (KTD7).
 *
 * `deny` closes the escalation without changing unit state; a still-blocking
 * condition re-raises on the next `miah run`. A run paused in Attention
 * resumes via Attention -> Ready so the next `miah run` advances (R66, F14).
 *
 * Journaled under the lease (R69): an `operator_decision: resolve` event, the
 * grade + gap closures, then `escalation_resolved` with the close reason.
 */
import { PaseoCliAdapter, type PaseoAdapter } from "../adapter/paseo";
import { commitIntegrationFiles, evaluateUnitAcceptance, runIntegrationCheck } from "../acceptance";
import { loadConfig, resolveConfigBasePath } from "../config";
import { unresolvedEscalations } from "../escalation";
import { ensurePhase } from "../fsm";
import { readManifest } from "../manifest";
import { resolveRunLayout, RunStore } from "../run-store";
import { readUnitsFromStore } from "../step";
import type { Config, CriterionGradeRef, PlanUnit, UnitId } from "../types";
import { verificationCommandsFor as contractVerificationCommandsFor } from "../verification-contract";
import { operatorIdentity } from "./stop";
import { gradesFromRefs, type CriterionGrade } from "../grading";
import type { CommandRunner } from "../evidence";

/** Exit code when the run or escalation cannot be resolved. */
export const RESOLVE_ERROR_EXIT_CODE = 1;

/** The D6-a escalation decision set. */
export type ResolveDecision = "approve" | "deny" | "rework";

export interface ResolveOptions {
  config?: Config;
  basePath?: string;
  holderId?: string;
  /** The workspace the resolve runs against; defaults to the process cwd. */
  workspaceRoot?: string;
  /** Canonical worktree the approved unit's `creates:` integrate into (R89). */
  canonicalWorktree?: string;
  /** Verification-contract commands per unit (R45); defaults to the parsed contract (KTD1/R15). */
  verificationCommandsFor?: (unit: PlanUnit) => string[];
  /** Contract-command runner for the re-evaluated integration check (R54). */
  runCommand?: CommandRunner;
  /** Adapter for recovering the builder candidate's worktree (R89). */
  adapter?: PaseoAdapter;
}

/** The unit + criterion an escalation speaks to, resolved from its payload. */
function criterionOf(
  unit: PlanUnit | undefined,
  escalation: { criterion: string | null; criterion_id: string | null; declared_tier: string | null },
): { criterionId: string; criterionText: string; tier: string } | null {
  const criteria = unit?.acceptance ?? [];
  const byId = criteria.find((c) => c.id !== null && c.id === escalation.criterion_id);
  const byText = criteria.find((c) => c.text === escalation.criterion);
  const criterion = byId ?? byText;
  if (criterion === undefined) {
    // Fall back to the escalation's own payload for criteria not in the plan.
    const id = escalation.criterion_id ?? escalation.criterion;
    if (id === null) {
      return null;
    }
    return {
      criterionId: id,
      criterionText: escalation.criterion ?? id,
      tier: escalation.declared_tier ?? "human",
    };
  }
  return {
    criterionId: criterion.id ?? escalation.criterion_id ?? criterion.text,
    criterionText: criterion.text,
    tier: criterion.tier ?? escalation.declared_tier ?? "human",
  };
}

/**
 * Run `miah resolve` for a run id and escalation id. Returns the process exit
 * code: 0 on success, non-zero when the run does not exist, the escalation is
 * not open, or the lease is held by a live driver.
 */
export async function runResolve(
  runId: string,
  escalationId: string,
  decision: ResolveDecision,
  note?: string,
  opts: ResolveOptions = {},
): Promise<number> {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const layout = resolveRunLayout(basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    console.error(`miah resolve: no run found for ${runId}`);
    return RESOLVE_ERROR_EXIT_CODE;
  }
  const config = opts.config ?? loadConfig();
  const holderId = opts.holderId ?? `miah-op-${process.pid}`;
  const store = new RunStore({ basePath, runId, config, holderId });
  const acquired = store.lease.acquire(holderId);
  if (!acquired.ok) {
    console.error(
      `miah resolve: lease held by ${acquired.lease.holder_id} (fresh heartbeat); cannot resolve while a driver is active`,
    );
    return RESOLVE_ERROR_EXIT_CODE;
  }
  try {
    const escalations = unresolvedEscalations(store);
    const escalation = escalations.find((entry) => entry.escalation_id === escalationId);
    if (escalation === undefined) {
      console.error(`miah resolve: escalation ${escalationId} not found or already resolved`);
      return RESOLVE_ERROR_EXIT_CODE;
    }

    const operator = operatorIdentity();
    store.append("operator_decision", {
      operator,
      decision: "resolve",
      escalation_id: escalationId,
      resolve_decision: decision,
      note: note ?? null,
    });

    const unitId = escalation.unit_id;
    const unit = unitId !== null ? (readUnitsFromStore(store) ?? {})[unitId] : undefined;
    const criterionRef = unitId !== null ? criterionOf(unit, escalation) : null;
    if (unitId !== null && criterionRef !== null) {
      // KTD7: criterion-level operator grade — journaled BEFORE the
      // escalation resolves so resume re-evaluates from durable grades.
      if (decision === "approve" || decision === "rework") {
        const state = store.stateSnapshot();
        const existing = state.criterion_grades[unitId] ?? [];
        const operatorGrade: CriterionGradeRef = {
          criterion_id: criterionRef.criterionId,
          criterion: criterionRef.criterionText,
          tier: criterionRef.tier,
          grade: decision === "approve" ? "pass" : "fail",
          route: decision === "approve" ? null : "rework",
          basis: decision === "approve" ? "operator-approval" : "operator-rework",
          source: "operator",
        };
        const merged = [
          ...existing.filter((grade) => grade.criterion_id !== operatorGrade.criterion_id),
          operatorGrade,
        ];
        store.append("criterion_grades_recorded", {
          unit_id: unitId,
          via: "operator-resolve",
          grades: merged,
        });
        // Close the escalated criterion's paired gaps explicitly (KTD7:
        // close-before-supersede; R50's "a problem cannot disappear silently").
        const escalatedText = criterionRef.criterionText;
        for (const gap of store.stateSnapshot().open_gaps) {
          if (
            gap.unit_id === unitId &&
            (gap.criterion === escalatedText || gap.criterion === criterionRef.criterionId)
          ) {
            store.append("gap_closed", {
              unit_id: unitId,
              criterion: gap.criterion,
              close_reason: `operator-${decision}`,
            });
          }
        }
      }
    } else if (
      unitId !== null &&
      (escalation.trigger === "verifier-flagged-for-human-judgment" || escalation.criterion === null)
    ) {
      // KTD7: verifier operational escalation (no criterion).
      if (decision === "approve") {
        // Same-candidate retry: reset the per-candidate verifier-attempt
        // counter; the frozen candidate is retried, never a new builder take.
        store.append("verifier_attempts_reset", { unit_id: unitId, via: "operator-resolve" });
      } else if (decision === "rework") {
        // Start a new builder take.
        store.append("rework_started", { unit_id: unitId, via: "operator-resolve" });
      }
    }

    store.append("escalation_resolved", {
      escalation_id: escalationId,
      decision,
      close_reason: note ?? "resolved by operator",
      operator,
    });

    // KTD7: after a criterion-level grade, re-evaluate ALL criteria over the
    // durable verifier/operator grades — never a whole-unit shortcut.
    if (criterionRef !== null) {
      await reEvaluateUnit(store, unit, opts);
    }

    // Resume a paused run: Attention -> Ready so the next `miah run` advances
    // (R66 resume path; a still-blocking condition re-raises in the driver).
    if (store.stateSnapshot().phase === "Attention") {
      ensurePhase(store, "Ready");
    }

    console.log(`miah resolve: escalation ${escalationId} resolved with ${decision}`);
    return 0;
  } finally {
    try {
      store.lease.release(holderId);
    } catch {
      // best effort
    }
  }
}

/**
 * KTD7: re-evaluate the unit's acceptance predicate over the durable grades
 * and journal the resulting decision. Accept routes through the standard
 * integration check; rework starts a bounded builder take; a still-ungraded
 * criterion raises a fresh escalation — the resolve never accepts a whole
 * unit by shortcut while another criterion remains unsatisfied.
 */
async function reEvaluateUnit(
  store: RunStore,
  unit: PlanUnit | undefined,
  opts: ResolveOptions,
): Promise<void> {
  if (unit === undefined) {
    return;
  }
  const state = store.stateSnapshot();
  const records: CriterionGrade[] = gradesFromRefs(state.criterion_grades[unit.id] ?? []);
  const worktreeRoot = await builderCandidateWorktree(store, unit.id, opts);
  const verificationCommands = opts.verificationCommandsFor
    ? opts.verificationCommandsFor(unit)
    : contractVerificationCommandsFor(unit);
  const canonicalWorktree = opts.canonicalWorktree ?? opts.workspaceRoot ?? process.cwd();
  // R54/R89: the integration check needs the builder candidate's worktree as
  // its source. When no worktree can be recovered and the unit declares
  // `creates:`, skip the integration check rather than let runIntegrationCheck
  // resolve paths relative to the process CWD (pre-PR behavior: the acceptance
  // stands but the deliverable is not integrated; the durable operator grade
  // and predicate evaluation still run).
  const integration =
    worktreeRoot === "" && (unit.creates ?? []).length > 0
      ? null
      : {
          store,
          unit,
          sourceWorktree: worktreeRoot,
          canonicalWorktree,
          verificationCommands,
          runCommand: opts.runCommand,
          commitIntegration: commitIntegrationFiles,
        };
  const outcome = await evaluateUnitAcceptance({
    store,
    unit,
    records,
    openGaps: state.open_gaps,
    integration,
  });
  if (outcome.verdict.decision === "accept") {
    return;
  }
  if (outcome.verdict.route === "rework" && outcome.applied.decisionEvent.decision === "not_accepted") {
    const s = store.stateSnapshot().units[unit.id];
    const maxTakes = opts.config?.run.max_takes ?? 3;
    const maxRework = opts.config?.run.max_rework_cycles ?? 2;
    const takesExhausted = s !== undefined && s.takes >= maxTakes;
    const reworkExhausted = s !== undefined && s.rework_cycles >= maxRework;
    if (!takesExhausted && !reworkExhausted) {
      store.append("rework_started", { unit_id: unit.id, via: "operator-resolve" });
    }
  }
}

/**
 * The frozen builder candidate's worktree for integration (KTD7, U6.AC5):
 * never the most recent dispatch blindly — the most recent dispatch may be
 * the verifier. Prefers the durable awaiting-verification candidate, then the
 * last builder-role `dispatch_created` (historical roleless events default to
 * builder).
 */
async function builderCandidateWorktree(
  store: RunStore,
  unitId: UnitId,
  opts: ResolveOptions,
): Promise<string> {
  const state = store.stateSnapshot();
  const candidate = state.awaiting_verification[unitId];
  const agentId = candidate?.agent_id ?? null;
  const workspaceId = candidate?.workspace_id ?? null;
  const adapter = opts.adapter ?? new PaseoCliAdapter();
  if (agentId !== null && agentId !== "") {
    try {
      const inspect = await adapter.inspect({
        agentId,
        cwd: null,
        workspaceId,
      });
      if (inspect.cwd !== null && inspect.cwd.length > 0) {
        return inspect.cwd;
      }
    } catch {
      // fall through to the journaled builder identity
    }
  }
  const created = store.journal
    .readEvents()
    .filter(
      (event) =>
        event.type === "dispatch_created" &&
        event.unit_id === unitId &&
        (event.role === "builder" || event.role === undefined),
    )
    .pop();
  const fallbackAgent = created?.agent_id;
  if (typeof fallbackAgent === "string" && fallbackAgent.length > 0) {
    try {
      const inspect = await adapter.inspect({
        agentId: fallbackAgent,
        cwd: null,
        workspaceId: typeof created?.workspace_id === "string" ? created.workspace_id : null,
      });
      if (inspect.cwd !== null && inspect.cwd.length > 0) {
        return inspect.cwd;
      }
    } catch {
      // best effort
    }
  }
  return "";
}
