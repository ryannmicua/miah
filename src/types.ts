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
