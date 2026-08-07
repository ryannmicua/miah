/**
 * `miah status [run-id]` command (R64, D6-b, AE21).
 *
 * Reads the run journal and renders the reconstructed state to stdout as a
 * structured report: run id, plan title + snapshot hash, current run phase
 * (from the latest `phase_transition`), per-unit state (accepted / in-flight /
 * rework / blocked / not-started), open evidence gaps with
 * `(unit, criterion, reason)`, pending escalations with id + reason,
 * cumulative usage deltas, and the lease holder/heartbeat status (R64).
 *
 * Status is strictly read-only: it reconstructs state from the journal
 * (`deriveState` over the event stream) without acquiring the lease,
 * repairing the journal, or launching a driver (AE21).
 *
 * This module also hosts the shared run-store readers the other U9 commands
 * use (`findLatestPlanSnapshot`, `planTitleOf`, `currentSnapshotHash`,
 * `readOnlyState`).
 */
import * as fs from "fs";
import * as path from "path";
import { loadConfig, resolveConfigBasePath } from "../config";
import { unresolvedEscalations, type EscalationSummary } from "../escalation";
import { readJournalFile } from "../journal";
import { readManifest, type Manifest } from "../manifest";
import { parsePlan } from "../parser";
import { deriveState } from "../replay";
import { resolveRunLayout, RunStore, type RunStoreLayout } from "../run-store";
import { canonicalizePlan, computeContentHash } from "../snapshot";
import { cumulativeUsageFromEvidence, readUnitsFromStore } from "../step";
import type { Config, DerivedState, DerivedUnitState } from "../types";
import { resolveRunId } from "./run";

/** Exit code when the run cannot be found or read. */
export const STATUS_ERROR_EXIT_CODE = 1;

export interface StatusOptions {
  config?: Config;
  basePath?: string;
}

/** Latest `plan-snapshot.v<version>.md` in the run store root (R68/KTD16). */
export function findLatestPlanSnapshot(
  layout: RunStoreLayout,
): { filePath: string; version: number } | null {
  if (!fs.existsSync(layout.root)) {
    return null;
  }
  let best: { filePath: string; version: number } | null = null;
  for (const entry of fs.readdirSync(layout.root)) {
    const match = entry.match(/^plan-snapshot\.v(\d+)\.md$/);
    if (match === null) {
      continue;
    }
    const version = Number(match[1]);
    if (best === null || version > best.version) {
      best = { filePath: path.join(layout.root, entry), version };
    }
  }
  return best;
}

/** Plan title from a snapshot file's frontmatter; null when unparseable. */
export function planTitleOf(snapshotPath: string): string | null {
  try {
    const plan = parsePlan(fs.readFileSync(snapshotPath, "utf8"));
    return plan.title;
  } catch {
    return null;
  }
}

/** SHA-256 content hash of a snapshot file's canonicalized content (R23). */
export function currentSnapshotHash(snapshotPath: string): string | null {
  try {
    const content = fs.readFileSync(snapshotPath, "utf8");
    return computeContentHash(canonicalizePlan(content));
  } catch {
    return null;
  }
}

/**
 * Reconstruct derived state from the journal only — no lease acquisition, no
 * tail repair, no driver. A crash-truncated tail is simply not read (AE21).
 */
export function readOnlyState(store: RunStore): DerivedState {
  const { events } = readJournalFile(store.layout.journalPath);
  const units = readUnitsFromStore(store) ?? {};
  return deriveState(events, { units });
}

export interface UnitStatusRow {
  id: string;
  status: string;
  takes: number;
  rework_cycles: number;
  last_acceptance: string | null;
}

export interface StatusReport {
  run_id: string;
  plan_title: string | null;
  plan_hash: string | null;
  phase: string;
  terminal: string | null;
  units: UnitStatusRow[];
  gaps: Array<{ unit_id: string; criterion: string; reason: string }>;
  escalations: EscalationSummary[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  lease: {
    held: boolean;
    holder_id: string | null;
    last_heartbeat_at: number | null;
    ttl_s: number | null;
    released: boolean;
    fresh: boolean;
  } | null;
}

/** Build the status report from the run's durable record (R64, AE21). */
export function buildStatusReport(
  store: RunStore,
  layout: RunStoreLayout,
  manifest: Manifest,
): StatusReport {
  const state = readOnlyState(store);
  const units = readUnitsFromStore(store) ?? {};
  const snapshot = findLatestPlanSnapshot(layout);
  const planTitle = snapshot !== null ? planTitleOf(snapshot.filePath) : null;
  const planHash = snapshot !== null ? currentSnapshotHash(snapshot.filePath) : null;
  const lease = store.lease.read();
  return {
    run_id: manifest.run_id ?? layout.runId,
    plan_title: planTitle,
    plan_hash: planHash,
    phase: state.phase,
    terminal: state.terminal,
    units: Object.keys(units).map((id) => {
      const s: DerivedUnitState | undefined = state.units[id];
      return {
        id,
        status: s?.status ?? "not_started",
        takes: s?.takes ?? 0,
        rework_cycles: s?.rework_cycles ?? 0,
        last_acceptance: s?.last_acceptance ?? null,
      };
    }),
    gaps: state.open_gaps.map((gap) => ({
      unit_id: gap.unit_id,
      criterion: gap.criterion,
      reason: gap.reason,
    })),
    escalations: unresolvedEscalations(store),
    usage: cumulativeUsageFromEvidence(store),
    lease:
      lease === null
        ? null
        : {
            held: lease.released !== true,
            holder_id: lease.holder_id,
            last_heartbeat_at: lease.last_heartbeat_at,
            ttl_s: lease.ttl_s,
            released: lease.released === true,
            fresh: store.lease.isFresh(lease),
          },
  };
}

/** Render the status report as a structured tree (R64). */
export function printStatus(report: StatusReport): void {
  console.log("miah status");
  console.log(`  run id: ${report.run_id}`);
  console.log(
    `  plan: ${report.plan_title ?? "(untitled)"} (hash ${(report.plan_hash ?? "").slice(0, 16)})`,
  );
  console.log(
    `  phase: ${report.phase}${report.terminal !== null ? `  terminal: ${report.terminal}` : ""}`,
  );
  if (report.lease === null) {
    console.log("  lease: none");
  } else if (report.lease.released) {
    console.log(`  lease: released (last holder ${report.lease.holder_id})`);
  } else {
    const heartbeatAgeS =
      report.lease.last_heartbeat_at !== null
        ? Math.max(0, Math.floor((Date.now() - report.lease.last_heartbeat_at) / 1000))
        : null;
    const heartbeat =
      heartbeatAgeS === null ? "" : ` (heartbeat ${heartbeatAgeS}s ago)`;
    console.log(
      `  lease: held by ${report.lease.holder_id}${heartbeat}${report.lease.fresh ? "" : " (heartbeat STALE)"}`,
    );
  }
  console.log("  units:");
  for (const unit of report.units) {
    console.log(
      `    ${unit.id}  ${unit.status}${unit.takes > 0 ? `  takes=${unit.takes}` : ""}`,
    );
  }
  if (report.gaps.length === 0) {
    console.log("  gaps: none");
  } else {
    console.log("  gaps:");
    for (const gap of report.gaps) {
      console.log(`    ${gap.unit_id} / ${JSON.stringify(gap.criterion)} — ${gap.reason}`);
    }
  }
  if (report.escalations.length === 0) {
    console.log("  escalations: none");
  } else {
    console.log("  escalations:");
    for (const escalation of report.escalations) {
      console.log(
        `    ${escalation.escalation_id} (unit=${escalation.unit_id ?? "run"}, trigger=${escalation.trigger}): ${escalation.reason}`,
      );
    }
  }
  if (report.usage === null) {
    console.log("  usage: none recorded");
  } else {
    console.log("  usage:");
    console.log(`    input tokens: ${report.usage.inputTokens}`);
    console.log(`    output tokens: ${report.usage.outputTokens}`);
    console.log(`    cost: ${report.usage.costUsd} USD`);
  }
}

/**
 * Run `miah status`. The run id defaults to the most recent run in the run
 * store (KTD15). Returns the process exit code (0 on success, non-zero when
 * no run is found).
 */
export function runStatus(runIdArg: string | undefined, opts: StatusOptions = {}): number {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const runId = resolveRunId(basePath, runIdArg);
  if (runId === null) {
    console.error("miah status: no run found");
    return STATUS_ERROR_EXIT_CODE;
  }
  const layout = resolveRunLayout(basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    console.error(`miah status: no manifest for run ${runId}`);
    return STATUS_ERROR_EXIT_CODE;
  }
  const config = opts.config ?? loadConfig();
  const store = new RunStore({ basePath, runId, config, holderId: "status-reader" });
  printStatus(buildStatusReport(store, layout, manifest));
  return 0;
}
