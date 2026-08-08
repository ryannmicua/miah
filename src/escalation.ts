/**
 * Escalation mechanism (R66, R82, KTD13).
 *
 * The trigger set (R82) covers every operator-attention condition the plan
 * mandates: max takes exceeded (R77), max rework cycles exceeded (R78),
 * no-progress threshold exceeded (R76), approved scope/requirements/acceptance
 * criteria change needed, security/privacy/legal/data-loss risk, destructive or
 * irreversible side effect, unresolved high-severity test/review failure,
 * missing access/credentials/info/operator judgment, cost ceiling exceeded, and
 * no checker profile clearing the calibration bar (R48/R20). R66 also requires
 * an escalation when no executable work remains (a run-wide blocking condition).
 *
 * `escalation_raised` carries a stable escalation id (`esc-<seq>`) so the
 * operator interface (U9 `miah resolve`) can address a specific escalation.
 * The escalation is journaled under the lease; `unresolvedEscalations` pairs
 * `escalation_raised` with `escalation_resolved` so the driver can report what
 * is blocking the run (R66) and status can render pending escalations (R64).
 */
import type { JournalEvent } from "./types";
import type { RunStore } from "./run-store";

/** The R82 trigger set plus the R66 run-wide blocking trigger (R35 event). */
export const ESCALATION_TRIGGERS = [
  /** R77/R78: max takes or max rework cycles exhausted (KTD13). */
  "repeatedly-fails",
  /** R76: N consecutive adapter polls with no lifecycle/activity change. */
  "no-progress",
  /** R82: max takes exceeded (R77). */
  "max-takes-exceeded",
  /** R82: max rework cycles exceeded (R78). */
  "max-rework-cycles-exceeded",
  /** R82: approved scope/requirements/acceptance criteria change needed. */
  "scope-change-needed",
  /** R82: security/privacy/legal/data-loss risk. */
  "security-risk",
  /** R82: destructive/irreversible/unauthorized side effect. */
  "destructive-side-effect",
  /** R82: unresolved high-severity test/review failure. */
  "unresolved-high-severity-failure",
  /** R82: missing access/credentials/info/operator judgment. */
  "missing-access-or-judgment",
  /** R82: cost ceiling exceeded. */
  "cost-ceiling-exceeded",
  /** R82: no checker profile clears the calibration bar (R48/R20). */
  "no-checker-profile-clears-calibration-bar",
  /** R66: no executable work remains / run-wide blocking condition. */
  "blocked-no-eligible-work",
] as const;

export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

/** A pending (unresolved) escalation as the driver/status surfaces it. */
export interface EscalationSummary {
  escalation_id: string;
  unit_id: string | null;
  trigger: string;
  reason: string;
  criterion: string | null;
  /** Journal seq of the `escalation_raised` event. */
  seq: number;
}

/** Input to raise one escalation (R66, R82). */
export interface RaiseEscalationInput {
  unit_id?: string | null;
  trigger: string;
  reason: string;
  criterion?: string | null;
}

export interface RaiseEscalationResult {
  /** The `escalation_raised` journal event (R35). */
  event: JournalEvent;
  /** Stable id (`esc-<seq>`) the operator resolve command addresses. */
  escalation_id: string;
}

/**
 * Append an `escalation_raised` event with a stable escalation id. The id is
 * derived from the journal's next seq (deterministic under the single-writer
 * lease) so it is unique and reconstructable.
 */
export function raiseEscalation(
  store: RunStore,
  input: RaiseEscalationInput,
): RaiseEscalationResult {
  const nextSeq = store.journal.currentSeq() + 1;
  const escalation_id = `esc-${nextSeq}`;
  const event = store.append("escalation_raised", {
    escalation_id,
    unit_id: input.unit_id ?? null,
    trigger: input.trigger,
    reason: input.reason,
    criterion: input.criterion ?? null,
  });
  return { event, escalation_id };
}

/** Map an `escalation_raised` event to its summary shape. */
export function summaryFromEvent(event: JournalEvent): EscalationSummary {
  return {
    escalation_id:
      typeof event.escalation_id === "string" ? event.escalation_id : `esc-${event.seq}`,
    unit_id: typeof event.unit_id === "string" ? event.unit_id : null,
    trigger: typeof event.trigger === "string" ? event.trigger : "unknown",
    reason: typeof event.reason === "string" ? event.reason : "",
    criterion: typeof event.criterion === "string" ? event.criterion : null,
    seq: event.seq,
  };
}

/**
 * The escalations currently blocking the run, oldest first. Each
 * `escalation_resolved` closes the most recent open `escalation_raised` (the
 * operator resolves one escalation at a time per R66/U9). Reconstructed from
 * the journal only — no in-memory state.
 */
export function unresolvedEscalations(store: RunStore): EscalationSummary[] {
  const open: EscalationSummary[] = [];
  for (const event of store.journal.readEvents()) {
    if (event.type === "escalation_raised") {
      open.push(summaryFromEvent(event));
    } else if (event.type === "escalation_resolved") {
      open.pop();
    }
  }
  return open;
}
