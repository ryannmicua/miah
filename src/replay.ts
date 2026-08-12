/**
 * Replay (R42), state derivation (R41-R42), and periodic state snapshots
 * (R41, R71).
 *
 * Replay reads the latest `snapshots/state-<seq>.json` plus the journal tail
 * after that seq and folds the tail through `applyEvent`, reconstructing the
 * same supervisor-derived state that a full replay from seq 1 produces (R42).
 * A snapshot stores derived state only (R41, D7-a) and is written via
 * temp-write-then-rename so a crash can never corrupt the latest snapshot.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { defaultEnvelopePath } from "./envelope";
import {
  AwaitingCandidate,
  CriterionGradeRef,
  DerivedState,
  DerivedUnitState,
  InFlightIntent,
  JournalEvent,
  OpenGap,
  PlanUnit,
  UnitId,
} from "./types";
import { JournalCorruptionError, readJournalFile, repairJournalTail } from "./journal";

/** Pre-transition phase sentinel for a run that has not recorded a transition. */
export const INITIAL_PHASE = "not-started";

/** Empty derived state: no events applied yet. */
export function emptyDerivedState(): DerivedState {
  return {
    seq: 0,
    phase: INITIAL_PHASE,
    run_id: null,
    plan_hash: null,
    terminal: null,
    units: {},
    in_flight_intents: [],
    open_gaps: [],
    awaiting_verification: {},
    criterion_grades: {},
  };
}

/** Default derived state for a unit that has not appeared in any event. */
function unitOf(existing: DerivedUnitState | undefined): DerivedUnitState {
  if (existing !== undefined) {
    return existing;
  }
  return {
    status: "not_started",
    takes: 0,
    rework_cycles: 0,
    last_acceptance: null,
    verifier_attempts: 0,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asUnitId(value: unknown): UnitId | null {
  return asString(value);
}

/** Index of the latest in-flight intent for a unit, or -1. */
function lastIntentIndex(intents: DerivedState["in_flight_intents"], unitId: UnitId): number {
  for (let i = intents.length - 1; i >= 0; i--) {
    if (intents[i].unit_id === unitId) {
      return i;
    }
  }
  return -1;
}

/**
 * Recover the role of an intent-closing event (KTD5). The in-flight intent's
 * role is authoritative when present; the event's own `role` field covers
 * events journaled after the role-aware change; historical roleless events
 * default to `builder` only when no intent can be correlated.
 */
function roleOf(
  intents: DerivedState["in_flight_intents"],
  unitId: UnitId,
  eventRole: unknown,
  idempotencyKey: string | null,
): string {
  for (let i = intents.length - 1; i >= 0; i--) {
    const intent = intents[i];
    if (intent.unit_id !== unitId) {
      continue;
    }
    if (idempotencyKey !== null && intent.idempotency_key !== idempotencyKey) {
      continue;
    }
    return intent.role !== "unknown" ? intent.role : "builder";
  }
  return typeof eventRole === "string" && eventRole.length > 0 ? eventRole : "builder";
}

/** True when the event's recorded outcome is a successful termination (R44). */
function outcomeIsSuccess(payload: Record<string, unknown>): boolean {
  return asString(payload.outcome) === "success";
}

/** Remove the latest intent matching a unit (optionally a specific key). */
function removeIntent(
  intents: DerivedState["in_flight_intents"],
  unitId: UnitId,
  idempotencyKey: string | null,
): DerivedState["in_flight_intents"] {
  const next = intents.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const intent = next[i];
    if (intent.unit_id !== unitId) {
      continue;
    }
    if (idempotencyKey !== null && intent.idempotency_key !== idempotencyKey) {
      continue;
    }
    next.splice(i, 1);
    break;
  }
  return next;
}

/**
 * Fold one journal event into derived state. `dispatch_intent` opens an
 * in-flight intent (R37: never sufficient alone); `dispatch_created` merges the
 * observed identity; `dispatch_failed`/`dispatch_terminated` close it;
 * `acceptance_decision` sets per-unit acceptance and supersedes gaps;
 * `gap_recorded`/`gap_closed` pair into open gaps; `phase_transition` sets the
 * run phase (R42). Payload values that are missing or malformed are treated as
 * absent — a malformed event never corrupts derived state.
 *
 * Role awareness (KTD5): a successful builder termination preserves the
 * observed candidate handle and derives `awaiting_verification`; a verifier
 * intent derives `verifying` without incrementing builder takes; verifier
 * termination returns to `awaiting_verification`, and failed verifier attempts
 * (launch failures and non-success terminations) count separately from builder
 * takes and rework cycles. Historical roleless events correlate to their
 * intent, defaulting to `builder` only when no intent can be correlated;
 * `reviewer` remains an accepted replay string.
 */
export function applyEvent(state: DerivedState, event: JournalEvent): DerivedState {
  const next: DerivedState = {
    seq: Math.max(state.seq, event.seq),
    phase: state.phase,
    run_id: state.run_id,
    plan_hash: state.plan_hash,
    terminal: state.terminal,
    units: state.units,
    in_flight_intents: state.in_flight_intents,
    open_gaps: state.open_gaps,
    awaiting_verification: state.awaiting_verification,
    criterion_grades: state.criterion_grades,
  };
  const p = event;
  switch (event.type) {
    case "run_start": {
      next.run_id = asString(p.run_id) ?? next.run_id;
      next.plan_hash = asString(p.plan_hash) ?? next.plan_hash;
      break;
    }
    case "dispatch_intent": {
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null) {
        const take = typeof p.take === "number" && p.take > 0 ? p.take : 1;
        const role = asString(p.role) ?? "unknown";
        const intent = {
          seq: event.seq,
          unit_id: unitId,
          role,
          take,
          idempotency_key: asString(p.idempotency_key) ?? `intent-${event.seq}`,
          packet_hash: asString(p.packet_hash) ?? "",
          deadline: asString(p.deadline) ?? "",
          provider: asString(p.provider) ?? "",
          model: asString(p.model) ?? "",
          agent_id: null,
          workspace_id: null,
          base_commit: null,
        };
        const unit = unitOf(next.units[unitId]);
        const verifying = role === "verifier";
        next.in_flight_intents = [...next.in_flight_intents, intent];
        next.units = {
          ...next.units,
          [unitId]: {
            status: verifying ? "verifying" : "in_flight",
            // KTD5: verifier intents never increment builder takes.
            takes: verifying ? unit.takes : Math.max(unit.takes, take),
            rework_cycles: unit.rework_cycles,
            last_acceptance: unit.last_acceptance,
            verifier_attempts: unit.verifier_attempts,
          },
        };
      }
      break;
    }
    case "dispatch_created": {
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null) {
        const index = lastIntentIndex(next.in_flight_intents, unitId);
        if (index >= 0) {
          const intents = next.in_flight_intents.slice();
          const intent = intents[index];
          intents[index] = {
            ...intent,
            agent_id: asString(p.agent_id) ?? intent.agent_id,
            workspace_id: asString(p.workspace_id) ?? intent.workspace_id,
            base_commit: asString(p.base_commit) ?? intent.base_commit,
          };
          next.in_flight_intents = intents;
        }
      }
      break;
    }
    case "dispatch_failed": {
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null) {
        const key = asString(p.idempotency_key);
        const role = roleOf(next.in_flight_intents, unitId, p.role, key);
        next.in_flight_intents = removeIntent(next.in_flight_intents, unitId, key);
        const unit = unitOf(next.units[unitId]);
        if (role === "verifier") {
          // KTD5: a verifier launch failure is a failed verifier attempt on
          // the same frozen candidate, never a builder take or a rework cycle.
          next.units = {
            ...next.units,
            [unitId]: {
              ...unit,
              status: "awaiting_verification",
              verifier_attempts: unit.verifier_attempts + 1,
            },
          };
        } else if (unit.status === "in_flight") {
          next.units = {
            ...next.units,
            [unitId]: { ...unit, status: "not_started" },
          };
        }
      }
      break;
    }
    case "dispatch_terminated": {
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null) {
        const key = asString(p.idempotency_key);
        const role = roleOf(next.in_flight_intents, unitId, p.role, key);
        const closed = next.in_flight_intents.find(
          (intent) => intent.unit_id === unitId && (key === null || intent.idempotency_key === key),
        );
        next.in_flight_intents = removeIntent(next.in_flight_intents, unitId, key);
        const unit = unitOf(next.units[unitId]);
        // KTD8/R17: `reviewer` is the historical name of the verifier role;
        // a reviewer termination derives the same state as a verifier one
        // (return to awaiting_verification, preserve the frozen candidate),
        // so existing reviewer journals replay without clobbering derived
        // state back to not_started.
        if (role === "verifier" || role === "reviewer") {
          // KTD5: verifier termination returns to awaiting_verification until
          // grade ingestion and acceptance complete; a non-success outcome is
          // a failed verifier attempt on the frozen candidate.
          const success = outcomeIsSuccess(p);
          next.units = {
            ...next.units,
            [unitId]: {
              ...unit,
              status: "awaiting_verification",
              verifier_attempts: success ? unit.verifier_attempts : unit.verifier_attempts + 1,
            },
          };
        } else if (role === "builder" && outcomeIsSuccess(p) && closed !== undefined) {
          // KTD5: successful builder termination preserves the observed
          // candidate handle and derives awaiting_verification. The candidate
          // metadata is recovered from the closed intent; the envelope path is
          // the deterministic role/unit/take default (R43).
          const candidate: AwaitingCandidate = {
            take: closed.take,
            attempt: closed.idempotency_key,
            agent_id: closed.agent_id,
            workspace_id: closed.workspace_id,
            base_commit: closed.base_commit,
            deadline: closed.deadline,
            envelope_path: defaultEnvelopePath("builder", unitId, closed.take),
          };
          next.awaiting_verification = {
            ...next.awaiting_verification,
            [unitId]: candidate,
          };
          next.units = {
            ...next.units,
            [unitId]: {
              ...unit,
              status: "awaiting_verification",
              takes: Math.max(unit.takes, closed.take),
            },
          };
        } else if (unit.status === "in_flight") {
          next.units = {
            ...next.units,
            [unitId]: { ...unit, status: "not_started" },
          };
        }
      }
      break;
    }
    case "acceptance_decision": {
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null) {
        const decision = p.decision;
        const unit = unitOf(next.units[unitId]);
        if (decision === "accept") {
          next.units = {
            ...next.units,
            [unitId]: {
              status: "accepted",
              takes: unit.takes,
              rework_cycles: unit.rework_cycles,
              last_acceptance: "accept",
              verifier_attempts: unit.verifier_attempts,
            },
          };
          // Acceptance supersedes any open gap on the unit (R48 flow) and
          // consumes the awaiting-verification candidate (KTD5).
          next.open_gaps = next.open_gaps.filter((gap) => gap.unit_id !== unitId);
          if (next.awaiting_verification[unitId] !== undefined) {
            next.awaiting_verification = { ...next.awaiting_verification };
            delete next.awaiting_verification[unitId];
          }
        } else if (decision === "not_accepted") {
          next.units = {
            ...next.units,
            [unitId]: {
              status: unit.status === "accepted" ? unit.status : "not_started",
              takes: unit.takes,
              rework_cycles: unit.rework_cycles,
              last_acceptance: "not_accepted",
              verifier_attempts: unit.verifier_attempts,
            },
          };
        }
      }
      break;
    }
    case "gap_recorded": {
      const unitId = asUnitId(p.unit_id);
      const criterion = asString(p.criterion);
      if (unitId !== null && criterion !== null) {
        const gap: OpenGap = {
          unit_id: unitId,
          criterion,
          reason: asString(p.reason) ?? "",
          recorded_seq: event.seq,
        };
        next.open_gaps = [
          ...next.open_gaps.filter(
            (open) => !(open.unit_id === unitId && open.criterion === criterion),
          ),
          gap,
        ];
      }
      break;
    }
    case "gap_closed": {
      const unitId = asUnitId(p.unit_id);
      const criterion = asString(p.criterion);
      if (unitId !== null) {
        next.open_gaps = next.open_gaps.filter(
          (open) =>
            !(open.unit_id === unitId && (criterion === null || open.criterion === criterion)),
        );
      }
      break;
    }
    case "rework_started": {
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null) {
        const unit = unitOf(next.units[unitId]);
        next.units = {
          ...next.units,
          [unitId]: {
            status: "rework",
            takes: unit.takes,
            rework_cycles: unit.rework_cycles + 1,
            last_acceptance: unit.last_acceptance,
            // A new builder take produces a new candidate: verifier attempts
            // on the old candidate no longer count (KTD5).
            verifier_attempts: 0,
          },
        };
        if (next.awaiting_verification[unitId] !== undefined) {
          next.awaiting_verification = { ...next.awaiting_verification };
          delete next.awaiting_verification[unitId];
        }
      }
      break;
    }
    case "criterion_grades_recorded": {
      // KTD6: durable grade references; a later event for the same unit
      // supersedes the earlier one (re-evaluation replaces, never duplicates).
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null && Array.isArray(p.grades)) {
        next.criterion_grades = {
          ...next.criterion_grades,
          [unitId]: p.grades as CriterionGradeRef[],
        };
      }
      break;
    }
    case "verifier_attempt_failed": {
      // KTD5: an invalid verifier result (missing/malformed envelope, bad
      // pointer, candidate mismatch, stale candidate) is a failed verifier
      // attempt on the same frozen candidate — never a builder take.
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null) {
        const unit = unitOf(next.units[unitId]);
        next.units = {
          ...next.units,
          [unitId]: {
            ...unit,
            status: "awaiting_verification",
            verifier_attempts: unit.verifier_attempts + 1,
          },
        };
      }
      break;
    }
    case "verifier_attempts_reset": {
      // KTD7: an operator-approved verifier operational escalation resets the
      // per-candidate verifier-attempt counter so the same frozen candidate
      // can be retried; never a builder take.
      const unitId = asUnitId(p.unit_id);
      if (unitId !== null) {
        const unit = unitOf(next.units[unitId]);
        next.units = {
          ...next.units,
          [unitId]: {
            ...unit,
            status: "awaiting_verification",
            verifier_attempts: 0,
          },
        };
      }
      break;
    }
    case "phase_transition": {
      const to = asString(p.to);
      if (to !== null) {
        next.phase = to;
      }
      break;
    }
    case "run_terminal": {
      const status = asString(p.status);
      if (status !== null) {
        next.terminal = status;
      }
      break;
    }
    default:
      // Remaining R35 types (lease events, evidence, escalations, operator
      // decisions, amendments, reconcile records, snapshots) carry no derived
      // state for U3's reconstruction; they are still sequenced and replayed.
      break;
  }
  return next;
}

/**
 * Complete the per-unit status map against the units.json dependency graph
 * (R64 status set): a `not_started` unit with an unaccepted dependency becomes
 * `blocked`; every known unit gets an explicit entry (so "not_started" is
 * represented, not absent). Requires the units.json graph; without it no status
 * is added beyond what the events derive.
 */
export function computeBlocked(
  state: DerivedState,
  units: Record<UnitId, PlanUnit>,
): DerivedState {
  let changed = false;
  const nextUnits: Record<UnitId, DerivedUnitState> = { ...state.units };
  for (const unitId of Object.keys(units)) {
    const unit = units[unitId];
    const current = unitOf(nextUnits[unitId]);
    if (current.status !== "not_started") {
      continue;
    }
    const blockedBy = (unit.dependsOn ?? []).some(
      (dep) => (nextUnits[dep]?.status ?? "not_started") !== "accepted",
    );
    if (blockedBy) {
      nextUnits[unitId] = { ...current, status: "blocked" };
      changed = true;
    } else if (nextUnits[unitId] === undefined) {
      nextUnits[unitId] = current;
      changed = true;
    }
  }
  return changed ? { ...state, units: nextUnits } : state;
}

/**
 * Pure derivation over a full event stream. Validates global monotonic seq
 * (R33): a duplicate or out-of-order seq means the journal was corrupted or
 * events were duplicated — throw rather than silently reconstruct wrong.
 */
export function deriveState(
  events: JournalEvent[],
  opts?: { units?: Record<UnitId, PlanUnit> },
): DerivedState {
  let state = emptyDerivedState();
  let prevSeq = 0;
  for (const event of events) {
    if (event.seq <= prevSeq) {
      throw new JournalCorruptionError(
        `duplicate or out-of-order seq ${event.seq} after ${prevSeq}`,
      );
    }
    prevSeq = event.seq;
    state = applyEvent(state, event);
  }
  if (opts?.units) {
    state = computeBlocked(state, opts.units);
  }
  return state;
}

/** Temp-file name prefix used by snapshot writes. */
const SNAPSHOT_TEMP_PREFIX = ".state-";

/** Write a state snapshot; returns the snapshot path (R41, R71). */
export function writeStateSnapshot(state: DerivedState, snapshotsDir: string): string {
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const filePath = path.join(snapshotsDir, `state-${state.seq}.json`);
  const tmp = path.join(
    snapshotsDir,
    `${SNAPSHOT_TEMP_PREFIX}${state.seq}.${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}.tmp`,
  );
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
  return filePath;
}

/** Remove leftover snapshot temp files from a crashed snapshot write. */
export function cleanSnapshotTemps(snapshotsDir: string): void {
  if (!fs.existsSync(snapshotsDir)) {
    return;
  }
  for (const entry of fs.readdirSync(snapshotsDir)) {
    if (entry.startsWith(SNAPSHOT_TEMP_PREFIX) && entry.endsWith(".tmp")) {
      try {
        fs.rmSync(path.join(snapshotsDir, entry), { force: true });
      } catch {
        // best effort
      }
    }
  }
}

/** Latest `state-<seq>.json` in the snapshots dir, or null. */
export function findLatestSnapshot(
  snapshotsDir: string,
): { seq: number; filePath: string } | null {
  if (!fs.existsSync(snapshotsDir)) {
    return null;
  }
  let best: { seq: number; filePath: string } | null = null;
  for (const entry of fs.readdirSync(snapshotsDir)) {
    const match = entry.match(/^state-(\d+)\.json$/);
    if (match === null) {
      continue;
    }
    const seq = Number(match[1]);
    if (best === null || seq > best.seq) {
      best = { seq, filePath: path.join(snapshotsDir, entry) };
    }
  }
  return best;
}

export interface StateSnapshotInfo {
  seq: number;
  filePath: string;
  state: DerivedState;
}

/**
 * Read the latest snapshot. A snapshot that does not parse is treated as absent
 * (the journal itself is the authority — R42) so a torn snapshot never blocks
 * replay.
 */
export function readStateSnapshot(snapshotsDir: string): StateSnapshotInfo | null {
  const latest = findLatestSnapshot(snapshotsDir);
  if (latest === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(latest.filePath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const state = parsed as Record<string, unknown>;
  if (typeof state.seq !== "number" || typeof state.phase !== "string") {
    return null;
  }
  return {
    seq: latest.seq,
    filePath: latest.filePath,
    state: parsed as unknown as DerivedState,
  };
}

export interface ReplayResult {
  state: DerivedState;
  /** Seq of the snapshot replay started from, or null when none existed. */
  snapshotSeq: number | null;
  /** Number of tail events scanned past the snapshot (or all, when no snapshot). */
  scanned: number;
}

export interface ReplayOptions {
  journalPath: string;
  snapshotsDir: string;
  units?: Record<UnitId, PlanUnit>;
  /** Repair a crash-truncated tail first (the resumer-under-lease path). */
  truncate?: boolean;
}

/**
 * Reconstruct derived state from the latest snapshot plus the journal tail
 * (R42). The result is byte-identical to `deriveState` over the full stream.
 * A snapshot is authoritative only as a replay seed: a torn/unreadable snapshot
 * degrades to a full journal replay.
 */
export function replayFromSnapshot(options: ReplayOptions): ReplayResult {
  cleanSnapshotTemps(options.snapshotsDir);
  if (options.truncate) {
    repairJournalTail(options.journalPath);
  }
  const { events } = readJournalFile(options.journalPath);
  const snapshot = readStateSnapshot(options.snapshotsDir);
  let state = snapshot === null ? emptyDerivedState() : snapshot.state;
  if (snapshot !== null) {
    // The boundary is the snapshot file's own seq, not the stored state's seq.
    state = { ...state, seq: Math.max(state.seq, snapshot.seq) };
  }
  const tail = events.filter((event) => event.seq > state.seq);
  let prevSeq = state.seq;
  for (const event of tail) {
    if (event.seq <= prevSeq) {
      throw new JournalCorruptionError(
        `duplicate or out-of-order seq ${event.seq} after ${prevSeq}`,
      );
    }
    prevSeq = event.seq;
    state = applyEvent(state, event);
  }
  if (options.units) {
    state = computeBlocked(state, options.units);
  }
  return { state, snapshotSeq: snapshot === null ? null : snapshot.seq, scanned: tail.length };
}
