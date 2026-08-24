/**
 * Driven time computation (U1, R10-R12, KTD8).
 *
 * Driven time is the sum of intervals during which a run's lease was actually
 * held, derived from `lease_acquired` / `lease_renewed` / `lease_released`
 * events in the journal. Wall-clock time during which nobody was driving must
 * not count as driven time.
 *
 * Crash-open intervals (lease_acquired with no matching lease_released) close
 * at the last observed activity within that lease epoch — the most recent
 * journal event timestamp of any type appended under that holder's lease epoch.
 */
import type { JournalEvent } from "./types";

export interface DrivenTimeOptions {
  /** Injected clock for open-epoch closure when leaseFresh is true. */
  now?: number;
  /** Whether the current lease is fresh (held by the caller). */
  leaseFresh?: boolean;
}

/**
 * Compute driven time in milliseconds from journal events (R11, R12, KTD8).
 *
 * Walks events in ascending seq, tracking lease epochs:
 *   - `lease_acquired`: close any open epoch at last-observed-activity, open a new one
 *   - `lease_released`: close the epoch at the release timestamp
 *   - Any other event while an epoch is open: advance last-observed-activity
 *   - End of walk: close open epoch at `now` if leaseFresh, else at last-observed-activity
 */
export function drivenMilliseconds(
  events: JournalEvent[],
  opts?: DrivenTimeOptions,
): number {
  const now = opts?.now ?? Date.now();
  const leaseFresh = opts?.leaseFresh ?? false;

  let totalMs = 0;
  let epochStart: number | null = null;
  let lastActivity: number | null = null;

  const closeEpoch = (closeAt: number): void => {
    if (epochStart !== null) {
      totalMs += closeAt - epochStart;
      epochStart = null;
      lastActivity = null;
    }
  };

  for (const event of events) {
    const ts = event.timestamp;

    if (event.type === "lease_acquired") {
      // Close any still-open epoch at last-observed-activity before opening new one
      if (epochStart !== null) {
        closeEpoch(lastActivity ?? ts);
      }
      // Open new epoch
      epochStart = ts;
      lastActivity = ts;
    } else if (event.type === "lease_released") {
      closeEpoch(ts);
    } else {
      // Any other event while an epoch is open advances last-observed-activity
      if (epochStart !== null) {
        lastActivity = ts;
      }
    }
  }

  // Close any remaining open epoch
  if (epochStart !== null) {
    if (leaseFresh) {
      closeEpoch(now);
    } else if (lastActivity !== null) {
      closeEpoch(lastActivity);
    }
    // If no lastActivity and !leaseFresh, epoch contributes 0
  }

  return totalMs;
}
