/**
 * Watchdog run scan (U3, R1, KTD1).
 *
 * Enumerates every run under the run store, reads lease state, and
 * reconstructs derived state read-only via `readOnlyState` (no lease
 * acquired, no journal repair). Returns per-run scan results with
 * in-flight intents whose deadlines have passed.
 */
import * as fs from "fs";
import { listRunIds, resolveRunLayout, type RunStoreLayout } from "../run-store";
import { readOnlyState } from "../commands/status";
import { isPastDeadline } from "../dispatch";
import type { LeaseFile } from "../lease";
import type { Config, DerivedState, InFlightIntent } from "../types";
import { RunStore } from "../run-store";

/** Lease state as seen by the watchdog's read-only scan. */
export interface LeaseSnapshot {
  /** The raw lease file, or null when absent. */
  lease: LeaseFile | null;
  /** Whether the heartbeat is fresh (not released, heartbeat within TTL). */
  fresh: boolean;
  /** Whether the lease is released. */
  released: boolean;
}

/** Scan result for one run. */
export interface RunScanResult {
  runId: string;
  layout: RunStoreLayout;
  /** Read-only derived state (no lease acquired, no journal repair). */
  state: DerivedState;
  /** Lease state snapshot. */
  lease: LeaseSnapshot;
  /** In-flight intents whose deadline has passed (R2). */
  overdueIntents: InFlightIntent[];
}

/**
 * Scan a single run: reconstruct state read-only, check lease, find
 * overdue intents. Returns null when the run directory has no manifest
 * (skip without throwing, R9).
 */
export function scanRun(
  basePath: string,
  runId: string,
  config: Config,
  now: number,
): RunScanResult | null {
  const layout = resolveRunLayout(basePath, runId);
  // Skip runs without a manifest (R9).
  if (!fs.existsSync(layout.manifestPath)) {
    return null;
  }

  // Create a RunStore — this seeds in-memory state via read-only replay,
  // but does NOT acquire the lease, repair the journal, or write anything.
  // The watchdog uses readOnlyState() for the actual read.
  const store = new RunStore({
    basePath,
    runId,
    config,
    holderId: "watchdog-scan",
  });

  // Read-only state reconstruction (KTD1): same as `miah status`.
  const state = readOnlyState(store);

  // Read lease state without acquiring it (KTD2).
  const leaseRaw = store.lease.read();
  const lease = store.lease;
  const leaseSnapshot: LeaseSnapshot = {
    lease: leaseRaw,
    fresh: leaseRaw !== null && lease.isFresh(leaseRaw),
    released: leaseRaw !== null && lease.isReleased(leaseRaw),
  };

  // Find overdue in-flight intents (R2): unconditional scan, no lease filter.
  const overdueIntents = state.in_flight_intents.filter((intent) =>
    isPastDeadline(intent.deadline, now),
  );

  return {
    runId,
    layout,
    state,
    lease: leaseSnapshot,
    overdueIntents,
  };
}

/**
 * Scan all runs under the run store base path. Returns scan results
 * for every run that has a manifest (R9: unreadable runs are skipped).
 * P2-8: returns { results, failures } so callers can surface per-run
 * scan failures in tick reports (KTD12).
 */
export function scanAllRuns(
  basePath: string,
  config: Config,
  now: number,
): { results: RunScanResult[]; failures: string[] } {
  const runIds = listRunIds(basePath);
  const results: RunScanResult[] = [];
  const failures: string[] = [];
  for (const runId of runIds) {
    try {
      const result = scanRun(basePath, runId, config, now);
      if (result !== null) {
        results.push(result);
      }
    } catch (err) {
      // Per-run failure contained; record and continue processing other runs (R9).
      failures.push(`scan ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { results, failures };
}
