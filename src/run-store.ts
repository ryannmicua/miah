/**
 * Run store (`~/.miah/runs/<run-id>/`) (R31-R32, R70).
 *
 * The out-of-tree, owner-only run directory that specialists can never write
 * to (R32). Layout per R31-R32: `manifest.json`, `plan-snapshot.<version>.md`,
 * `units.json`, `journal.jsonl`, `lease.lock`, `snapshots/`, `evidence/`,
 * `approval-package.json`, `calibration/`. The base path is injectable so tests
 * (and the CLI under `MIAH_CONFIG_HOME`) never touch a real home directory.
 *
 * `RunStore` is the thin U3 facade wiring journal + lease + snapshots together:
 * appends are lease-gated (R15), and every `K`-th event writes a derived-state
 * snapshot (R41, R71) using the running in-memory state.
 */
import * as fs from "fs";
import * as path from "path";
import { Config, DerivedState, JournalEvent, PlanUnit, UnitId } from "./types";
import { Journal } from "./journal";
import { Lease } from "./lease";
import { applyEvent, replayFromSnapshot, writeStateSnapshot } from "./replay";

/** Directory under the config base path that holds all runs (R31). */
export const RUN_STORE_DIRNAME = "runs";

/** R32 run-store layout. */
export interface RunStoreLayout {
  runId: string;
  root: string;
  manifestPath: string;
  planSnapshotPath: string;
  unitsJsonPath: string;
  journalPath: string;
  leasePath: string;
  snapshotsDir: string;
  evidenceDir: string;
  approvalPackagePath: string;
  calibrationDir: string;
}

/**
 * Run id derived from the plan content hash and the admission time (R31).
 * Deterministic for the same inputs; unique in practice.
 */
export function runIdFromPlan(planHash: string, admittedAtMs: number = Date.now()): string {
  const d = new Date(admittedAtMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `run-${planHash.slice(0, 10)}-${stamp}`;
}

/** Paths for a run id under a base path (no I/O). */
export function resolveRunLayout(basePath: string, runId: string): RunStoreLayout {
  const root = path.join(basePath, RUN_STORE_DIRNAME, runId);
  return {
    runId,
    root,
    manifestPath: path.join(root, "manifest.json"),
    planSnapshotPath: path.join(root, "plan-snapshot.v1.md"),
    unitsJsonPath: path.join(root, "units.json"),
    journalPath: path.join(root, "journal.jsonl"),
    leasePath: path.join(root, "lease.lock"),
    snapshotsDir: path.join(root, "snapshots"),
    evidenceDir: path.join(root, "evidence"),
    approvalPackagePath: path.join(root, "approval-package.json"),
    calibrationDir: path.join(root, "calibration"),
  };
}

/** Create the run-store directories (root + subdirectories). */
export function createRunStoreDirs(layout: RunStoreLayout): void {
  fs.mkdirSync(layout.root, { recursive: true });
  fs.mkdirSync(layout.snapshotsDir, { recursive: true });
  fs.mkdirSync(layout.evidenceDir, { recursive: true });
  fs.mkdirSync(layout.calibrationDir, { recursive: true });
}

/** Run ids under a base path, ascending. */
export function listRunIds(basePath: string): string[] {
  const runsDir = path.join(basePath, RUN_STORE_DIRNAME);
  if (!fs.existsSync(runsDir)) {
    return [];
  }
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export interface RunStoreOptions {
  basePath: string;
  runId: string;
  config: Config;
  /** Identity of the process driving this store (the would-be lease holder). */
  holderId: string;
  now?: () => number;
}

export class RunStore {
  readonly layout: RunStoreLayout;
  readonly lease: Lease;
  readonly journal: Journal;
  private readonly holderId: string;
  private readonly config: Config;
  private state: DerivedState;

  constructor(options: RunStoreOptions) {
    this.holderId = options.holderId;
    this.config = options.config;
    this.layout = resolveRunLayout(options.basePath, options.runId);
    createRunStoreDirs(this.layout);
    this.lease = new Lease(this.layout.leasePath, {
      ttl_s: options.config.lease.ttl_s,
      heartbeat_interval_s: options.config.lease.heartbeat_interval_s,
      now: options.now,
    });
    this.journal = new Journal(this.layout.journalPath, {
      verifyHolder: (holderId: string) => this.lease.assertActiveHolder(holderId),
      now: options.now,
    });
    this.lease.attachJournal(this.journal);
    // Seed the running in-memory state read-only; the driver acquires the lease
    // and calls replay() (truncating) after takeover.
    this.state = this.replayReadOnly().state;
  }

  private replayReadOnly(): { state: DerivedState; snapshotSeq: number | null; scanned: number } {
    return replayFromSnapshot({
      journalPath: this.layout.journalPath,
      snapshotsDir: this.layout.snapshotsDir,
      units: this.readUnits(),
    });
  }

  private readUnits(): Record<UnitId, PlanUnit> | undefined {
    if (!fs.existsSync(this.layout.unitsJsonPath)) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.layout.unitsJsonPath, "utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<UnitId, PlanUnit>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reconstruct derived state from the latest snapshot plus the tail (R42),
   * repairing a crash-truncated tail first. Called by the resumer under lease.
   */
  replay(): { state: DerivedState; snapshotSeq: number | null; scanned: number } {
    return replayFromSnapshot({
      journalPath: this.layout.journalPath,
      snapshotsDir: this.layout.snapshotsDir,
      units: this.readUnits(),
      truncate: true,
    });
  }

  /** The running in-memory derived state (post-append). */
  stateSnapshot(): DerivedState {
    return this.state;
  }

  /**
   * Append one event under the lease and fold it into the running state. Every
   * `K`-th event writes a derived-state snapshot (R41, R71; K configurable via
   * `config.journal.snapshot_cadence`).
   */
  append(type: string, payload: Record<string, unknown> = {}): JournalEvent {
    const event = this.journal.append(this.holderId, type, payload);
    this.state = applyEvent(this.state, event);
    const cadence = this.config.journal.snapshot_cadence;
    if (cadence > 0 && event.seq % cadence === 0) {
      writeStateSnapshot(this.state, this.layout.snapshotsDir);
    }
    return event;
  }
}
