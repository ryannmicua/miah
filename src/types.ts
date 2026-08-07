/**
 * Core types for Miah.
 *
 * `Config` carries all D7 thresholds. Section keys and field names match the
 * config.json schema specified in the plan (R71-R82) so operator overrides
 * written to `~/.miah/config.json` map directly onto these fields.
 */

/** Journal snapshot cadence (R71): every K journaled events, write a state snapshot. */
export interface JournalConfig {
  /** K = 50 journaled events between snapshots. */
  snapshot_cadence: number;
}

/** Lease timing (R72, KTD8). */
export interface LeaseConfig {
  /** Heartbeat interval in seconds (default 30s). */
  heartbeat_interval_s: number;
  /** Lease TTL in seconds (default 60s). */
  ttl_s: number;
}

/** Dispatch thresholds (R73, R76). */
export interface DispatchConfig {
  /**
   * Per-agent max duration in seconds (default 900s = 15m, per R73).
   * Not enforceable until the Paseo daemon ships the feature; admission fails
   * closed until then (R4/R5, R57).
   */
  max_duration: number;
  /** No-progress polls (R76): escalate after this many consecutive polls with no change while alive and polling. */
  no_progress_polls: number;
}

/** Run thresholds (R75, R77, R78). */
export interface RunConfig {
  /** Concurrency cap (R75, KTD11): default 1 keeps early runs simple. */
  concurrency_cap: number;
  /** Max takes per unit (R77, KTD13): default 3. */
  max_takes: number;
  /** Max rework cycles per unit (R78, KTD13): default 2. */
  max_rework_cycles: number;
  /**
   * Run-level cost ceiling in USD (R81-R82). Absent/undefined when unset: the
   * cost-ceiling budget predicate is inert until the operator sets it in
   * `~/.miah/config.json` (`run.cost_ceiling_usd`). When set, the step
   * escalates `cost-ceiling-exceeded` as soon as cumulative harvested usage
   * cost exceeds the ceiling.
   */
  cost_ceiling_usd?: number;
}

/** Calibration bar for the calibrated-judge tier (R74, KTD10). */
export interface CalibrationConfig {
  /** Minimum pre-labeled calibration corpus size (default >= 15). */
  min_corpus: number;
  /**
   * Minimum agreement ratio. The bar requires strictly greater than 14/15
   * agreement; the default is the 14/15 floor itself and enforcement is
   * `agreement > min_agreement`.
   */
  min_agreement: number;
  /** Maximum tolerated false-blocks (default <= 2). */
  max_false_blocks: number;
  /** Mandatory zero false-pass floor (R74). Not relaxable. */
  zero_false_pass: boolean;
}

/** Operator-configurable thresholds, read from `~/.miah/config.json` (R80). */
export interface Config {
  journal: JournalConfig;
  lease: LeaseConfig;
  dispatch: DispatchConfig;
  run: RunConfig;
  calibration: CalibrationConfig;
}

/**
 * CE unified-plan / units.json shapes (R22-R30, R24). `units.json` is the
 * parsed-once machine view keyed by U-ID; the journal, dispatcher, and
 * acceptance predicate read this cached view and never re-parse the plan
 * markdown mid-run (parse-once-and-cache principle, R24).
 */

/** Stable U-ID, e.g. "U1", "U2", ... Numeric, ascending, gaps accepted (R25). */
export type UnitId = string;

/** Acceptance criterion with its grading tier from the D5 ladder (R28). */
export interface AcceptanceCriterion {
  /** The criterion text as written in the plan's Acceptance block. */
  text: string;
  /**
   * Declared tier: `deterministic | calibrated-judge | human` (D5 ladder,
   * R47). `null` when the criterion carries no `tier:` declaration.
   */
  tier: string | null;
}

/** One Implementation Unit as parsed into the units.json machine view (R24). */
export interface PlanUnit {
  /** Stable U-ID (e.g. "U1"), matching the `U<number>.` H3 heading. */
  id: UnitId;
  /** Numeric part of the U-ID (1 for "U1"). */
  number: number;
  /** Unit title after the `U<number>.` prefix. */
  title: string;
  /** The `- **Goal:**` line. */
  goal: string | null;
  /** The `- **Requirements:**` line (requirement IDs, may be empty). */
  requirements: string | null;
  /**
   * Repo-relative paths the unit promises to produce (R26). `null` when the
   * unit does not declare a `creates:` field (a finding, per R26); an empty
   * list is a present-but-empty declaration and is allowed.
   */
  creates: string[] | null;
  /**
   * Repo-relative paths the unit consumes (R27). `null` when the unit does
   * not declare an `inputs:` field (a finding, per R27); an empty list is a
   * present-but-empty declaration (allowed, e.g. for a root unit).
   */
  inputs: string[] | null;
  /** U-IDs this unit depends on (empty for roots, per R25). */
  dependsOn: UnitId[];
  /**
   * Acceptance criteria from the unit's Acceptance block (R25, R28). `null`
   * when the unit does not carry an Acceptance block (a finding, per R25 and
   * R56(a)); an empty list is a present-but-empty block.
   */
  acceptance: AcceptanceCriterion[] | null;
}

/** Parsed CE `ce-unified-plan/v1` document (frontmatter + units view). */
export interface ParsedPlan {
  /** `title` from the YAML frontmatter. */
  title: string | null;
  /** `artifact_contract` from the YAML frontmatter (e.g. `ce-unified-plan/v1`). */
  artifactContract: string | null;
  /** `execution` from the YAML frontmatter (`code` or `knowledge-work`). */
  execution: string | null;
  /** units.json-shaped map keyed by U-ID. */
  units: Record<UnitId, PlanUnit>;
  /** U-IDs in document order (numeric ascending; gaps accepted). */
  unitIds: UnitId[];
  /**
   * U-IDs declared more than once in the document (R56(a): unique). Populated
   * by the parser so the structural preflight can report them; the `units`
   * record keeps the first occurrence.
   */
  duplicateIds: UnitId[];
}

/** D5 grading ladder tiers (R28, R47). */
export const GRADING_TIERS = ["deterministic", "calibrated-judge", "human"] as const;
export type GradingTier = (typeof GRADING_TIERS)[number];

/** Default thresholds (D7, R71-R78). Used when config.json is absent. */
export const DEFAULT_CONFIG: Config = {
  journal: {
    snapshot_cadence: 50,
  },
  lease: {
    heartbeat_interval_s: 30,
    ttl_s: 60,
  },
  dispatch: {
    max_duration: 15 * 60,
    no_progress_polls: 3,
  },
  run: {
    concurrency_cap: 1,
    max_takes: 3,
    max_rework_cycles: 2,
  },
  calibration: {
    min_corpus: 15,
    min_agreement: 14 / 15,
    max_false_blocks: 2,
    zero_false_pass: true,
  },
};

/**
 * Journal and replay types (R33-R42, R71). The journal is a single append-only
 * JSONL file of typed events, one per line, each carrying a global monotonic
 * `seq` (R33). Replay reconstructs *derived* state only — statuses, decisions,
 * IDs, hashes, references — never raw contexts, tool inputs, or specialist
 * prose (R41, D7-a).
 */

/** Journal event type names (R35). */
export const JOURNAL_EVENT_TYPES = [
  "run_start",
  "lease_acquired",
  "lease_renewed",
  "lease_released",
  "journal_snapshot",
  "dispatch_intent",
  "dispatch_created",
  "dispatch_failed",
  "dispatch_terminated",
  "reconcile_record",
  "evidence_harvested",
  "custody_continuity_record",
  "result_envelope_observed",
  "acceptance_decision",
  "gap_recorded",
  "gap_closed",
  "rework_started",
  "escalation_raised",
  "escalation_resolved",
  "operator_decision",
  "amendment_applied",
  "phase_transition",
  "run_terminal",
] as const;

/** The canonical journal event types (R35). */
export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];

/**
 * One journaled event (R35): `{seq, type, timestamp, ...payload}`. `seq` is
 * global and monotonic under the lease holder (R33); `timestamp` is Miah's
 * observation timestamp (R34); the remaining keys carry the type-specific
 * payload.
 */
export interface JournalEvent {
  seq: number;
  type: string;
  timestamp: number;
  [payloadKey: string]: unknown;
}

/** Per-unit state statuses (R64, R42). */
export type UnitStatus = "accepted" | "in_flight" | "rework" | "blocked" | "not_started";

/**
 * A dispatch intent reconstructed from the journal that has no terminal
 * follow-up event yet (R42: in-flight intents). A `dispatch_intent` alone is
 * never enough to advance a unit past dispatch (R37).
 */
export interface InFlightIntent {
  seq: number;
  unit_id: UnitId;
  role: string;
  take: number;
  idempotency_key: string;
  packet_hash: string;
  deadline: string;
  provider: string;
  model: string;
  agent_id: string | null;
  workspace_id: string | null;
  base_commit: string | null;
}

/** An open evidence gap: a `gap_recorded` without a matching `gap_closed` (R42). */
export interface OpenGap {
  unit_id: UnitId;
  criterion: string;
  reason: string;
  recorded_seq: number;
}

/** Derived per-unit state (R41). */
export interface DerivedUnitState {
  status: UnitStatus;
  takes: number;
  rework_cycles: number;
  last_acceptance: "accept" | "not_accepted" | null;
}

/**
 * The supervisor-derived state that replay reconstructs (R42): unit acceptance
 * decisions, in-flight intents, open evidence gaps, and the run phase. This is
 * what state snapshots serialize (R41) — derived data only, no raw context.
 */
export interface DerivedState {
  /** Highest journal seq applied to this state. */
  seq: number;
  /** Latest `phase_transition.to`; the pre-transition sentinel is "not-started". */
  phase: string;
  run_id: string | null;
  plan_hash: string | null;
  terminal: string | null;
  units: Record<UnitId, DerivedUnitState>;
  in_flight_intents: InFlightIntent[];
  open_gaps: OpenGap[];
}

/**
 * Miah specialist roles (D8-i, R7-R11). Each specialist is a separately
 * addressable external agent session created through the Paseo lifecycle
 * adapter (R7); U5 dispatches one such specialist per unit attempt.
 */
export type SpecialistRole = "planner" | "builder" | "tester" | "reviewer";

/**
 * Role-to-model defaults (D8-i). Miah maps each role to a Paseo role plus a
 * provider/model pair, falling back to the operator's
 * `~/.paseo/orchestration-preferences.json` when present (D8-i). The D8-i
 * table's "Provider/Model" cells carry the paseo `--provider` name and the
 * full model id (the live CLI probe in U4 confirmed `--provider opencode` with
 * model `opencode-go/deepseek-v4-flash`).
 */
export const D8I_ROLE_DEFAULTS: Record<
  SpecialistRole,
  { paseo_role: string; provider: string; model: string }
> = {
  planner: { paseo_role: "planning", provider: "codex", model: "gpt-5.6-sol" },
  builder: { paseo_role: "impl", provider: "opencode", model: "opencode-go/deepseek-v4-flash" },
  tester: { paseo_role: "audit", provider: "opencode", model: "opencode-go/glm-5.2" },
  reviewer: { paseo_role: "audit", provider: "opencode", model: "opencode-go/glm-5.2" },
};
