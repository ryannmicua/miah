/**
 * Evidence-gap pairing (R50, R52, R61).
 *
 * `gap_recorded(unit, criterion, reason)` opens a gap; the criterion cannot be
 * accepted while the gap is open (R51/R52). `gap_closed(unit, criterion,
 * close_reason)` closes it, and the pairing is enforced: a close with no
 * matching open gap is refused, and the close reason must be one of the R50
 * set (rework-take, re-verification-success, operator-approval,
 * deadline-still-in-effect-cleared) so a problem cannot disappear silently
 * (`VISION.md`).
 *
 * Both primitives journal through the RunStore under the lease (R15), so the
 * open/closed pairing is always visible in the reconstructed state (R42).
 */
import type { JournalEvent, OpenGap, UnitId } from "./types";
import type { RunStore } from "./run-store";

/** The mandated `gap_closed` close-reason set (R50). */
export const GAP_CLOSE_REASONS = [
  "rework-take",
  "re-verification-success",
  "operator-approval",
  "deadline-still-in-effect-cleared",
] as const;

/** One of the R50 close reasons. */
export type GapCloseReason = (typeof GAP_CLOSE_REASONS)[number];

/** Open a gap: `gap_recorded(unit, criterion, reason)` (R52). */
export function recordGap(
  store: RunStore,
  unitId: UnitId,
  criterion: string,
  reason: string,
): JournalEvent {
  return store.append("gap_recorded", { unit_id: unitId, criterion, reason });
}

/** Result of a `gap_closed` attempt; pairing is enforced (R50). */
export interface CloseGapResult {
  ok: boolean;
  /** The `gap_closed` event, or null when the close was refused. */
  event: JournalEvent | null;
  /** Why the close was refused, or null. */
  error: string | null;
}

/**
 * Close a gap: `gap_closed(unit, criterion, close_reason)` (R50). Refuses the
 * close (no journal write) when no open gap matches the pair or when the close
 * reason is not in the R50 set.
 */
export function closeGap(
  store: RunStore,
  unitId: UnitId,
  criterion: string,
  closeReason: string,
): CloseGapResult {
  if (!(GAP_CLOSE_REASONS as readonly string[]).includes(closeReason)) {
    return {
      ok: false,
      event: null,
      error: `invalid gap close reason: ${closeReason} (R50 set: ${GAP_CLOSE_REASONS.join(", ")})`,
    };
  }
  const open = findOpenGap(store.stateSnapshot().open_gaps, unitId, criterion);
  if (open === undefined) {
    return { ok: false, event: null, error: `no open gap for (${unitId}, ${criterion}) to close` };
  }
  const event = store.append("gap_closed", {
    unit_id: unitId,
    criterion,
    close_reason: closeReason,
  });
  return { ok: true, event, error: null };
}

/** Find the open gap matching (unit, criterion), or undefined. */
export function findOpenGap(
  openGaps: OpenGap[],
  unitId: UnitId,
  criterion: string,
): OpenGap | undefined {
  return openGaps.find((gap) => gap.unit_id === unitId && gap.criterion === criterion);
}

/** True when an open gap references (unit, criterion). */
export function hasOpenGap(openGaps: OpenGap[], unitId: UnitId, criterion: string): boolean {
  return findOpenGap(openGaps, unitId, criterion) !== undefined;
}
