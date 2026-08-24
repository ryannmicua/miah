/**
 * Watchdog tick and loop (U3-U4, R1-R9, R19-R20).
 *
 * One tick = scan all runs, kill every overdue intent, write receipts,
 * take over the lease when free/stale and drain, then write heartbeat.
 */
import { RunStore } from "../run-store";
import { scanAllRuns, type RunScanResult } from "./scan";
import { killIntent } from "./kill";
import { writeReceipt, listReceipts, drainReapReceipts } from "./receipts";
import { writeHeartbeat, heartbeatFreshness } from "./heartbeat";
import type { PaseoAdapter } from "../adapter/paseo";
import type { Config } from "../types";

const WD_HOLDER_PREFIX = "miah-wd";

export function watchdogHolderId(): string {
  return `${WD_HOLDER_PREFIX}-${process.pid}`;
}

export interface TickReport {
  runsScanned: number;
  runsWithOverdue: number;
  intentsKilled: number;
  intentsAdapterFailed: number;
  intentsNoAgent: number;
  leasesTakenOver: number;
  takeoversRefused: number;
  errors: string[];
}

function emptyReport(): TickReport {
  return {
    runsScanned: 0,
    runsWithOverdue: 0,
    intentsKilled: 0,
    intentsAdapterFailed: 0,
    intentsNoAgent: 0,
    leasesTakenOver: 0,
    takeoversRefused: 0,
    errors: [],
  };
}

export async function tick(
  adapter: PaseoAdapter,
  opts: { basePath: string; config: Config; version: string; now?: number },
): Promise<TickReport> {
  const { basePath, config, version, now } = opts;
  const nowMs = now ?? Date.now();
  const report = emptyReport();
  const scan = scanAllRuns(basePath, config, nowMs);
  report.runsScanned = scan.results.length;
  report.errors.push(...scan.failures);

  for (const scanResult of scan.results) {
    try {
      await processRun(adapter, scanResult, report, basePath, config, version);
    } catch (err) {
      report.errors.push(
        `run ${scanResult.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // R19: write heartbeat unconditionally, even when errors occurred.
  try {
    writeHeartbeat(basePath, version, config.watchdog.cadence_s);
  } catch (err) {
    report.errors.push(
      `heartbeat write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return report;
}

async function processRun(
  adapter: PaseoAdapter,
  scan: RunScanResult,
  report: TickReport,
  basePath: string,
  config: Config,
  version: string,
): Promise<void> {
  const { runId, layout, lease: leaseSnapshot, overdueIntents } = scan;

  // P2-9: Hoist drain above overdueIntents check. Even when no intents are
  // overdue, stale receipts from a previous tick may be waiting (U3: "a stale
  // receipt from a previous tick is drained on a later tick that acquires the
  // lease, even though that tick killed nothing").
  const pendingReceipts = listReceipts(layout.reapReceiptsDir);
  if (pendingReceipts.length > 0 && !leaseSnapshot.fresh) {
    const store = new RunStore({ basePath, runId, config, holderId: watchdogHolderId() });
    const acquireResult = store.lease.acquire(watchdogHolderId());
    if (acquireResult.ok) {
      try {
        drainReapReceipts(store);
        report.leasesTakenOver += 1;
      } finally {
        try { store.lease.release(watchdogHolderId()); } catch { /* best effort */ }
      }
    } else {
      report.takeoversRefused += 1;
    }
  }

  if (overdueIntents.length === 0) return;
  report.runsWithOverdue += 1;

  for (const intent of overdueIntents) {
    try {
      const killResult = await killIntent(adapter, intent);
      writeReceipt(layout.reapReceiptsDir, {
        schema: "miah/reap-receipt/v1",
        intent_id: intent.idempotency_key,
        agent_id: intent.agent_id,
        workspace_id: intent.workspace_id,
        deadline: intent.deadline,
        reap_timestamp: Date.now(),
        adapter_outcome: killResult.outcome,
        error: killResult.error,
        unit_id: intent.unit_id,
        role: intent.role,
        take: intent.take,
        run_id: runId,
        reaper: watchdogHolderId(),
        version,
      });
      if (killResult.outcome === "terminated") report.intentsKilled += 1;
      else if (killResult.outcome === "adapter-failed") report.intentsAdapterFailed += 1;
      else report.intentsNoAgent += 1;
    } catch (err) {
      report.errors.push(
        `run ${runId} intent ${intent.idempotency_key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (leaseSnapshot.fresh) {
    return; // R5: driver drains at step boundary
  }

  const store = new RunStore({ basePath, runId, config, holderId: watchdogHolderId() });
  const acquireResult = store.lease.acquire(watchdogHolderId());
  if (!acquireResult.ok) {
    report.takeoversRefused += 1; // R6: driver won the race
    return;
  }

  try {
    drainReapReceipts(store);
    report.leasesTakenOver += 1;
  } finally {
    try { store.lease.release(watchdogHolderId()); } catch { /* best effort */ }
  }
}

export async function runLoop(
  adapter: PaseoAdapter,
  opts: { basePath: string; config: Config; version: string },
): Promise<void> {
  const existing = heartbeatFreshness(opts.basePath, opts.config.watchdog.cadence_s);
  if (existing.healthy) {
    console.error(`miah-watchdog: another tick is healthy (age ${Math.round(existing.ageMs / 1000)}s); exiting.`);
    return;
  }
  console.log(`miah-watchdog: starting loop (cadence ${opts.config.watchdog.cadence_s}s)`);
  for (;;) {
    try {
      const report = await tick(adapter, {
        basePath: opts.basePath,
        config: opts.config,
        version: opts.version,
      });
      console.log(
        `miah-watchdog tick: scanned=${report.runsScanned} killed=${report.intentsKilled} drained=${report.leasesTakenOver} errors=${report.errors.length}`,
      );
    } catch (err) {
      console.error(`miah-watchdog: tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.config.watchdog.cadence_s * 1000));
  }
}
