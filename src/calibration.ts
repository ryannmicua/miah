/**
 * Calibration bar for the `calibrated-judge` grading tier (R74, KTD10, R48).
 *
 * A checker/reviewer profile gains verdict authority only when its calibration
 * corpus clears the bar: corpus `>= calibration.min_corpus` (default 15),
 * agreement `> calibration.min_agreement` (default 14/15, strictly greater),
 * false-blocks `<= calibration.max_false_blocks` (default 2), and — mandatory
 * and non-relaxable — ZERO false-passes (no case where the profile passed a
 * verdict the labeled truth says should fail; R74/R48 falsification-floor
 * discipline). The agreement and false-block thresholds are operator-
 * configurable via `~/.miah/config.json` (`calibration.min_corpus`,
 * `calibration.min_agreement`, `calibration.max_false_blocks`); the zero
 * false-pass floor is never configurable (R74).
 *
 * Profiles are pre-labeled verdicts on example cases the operator supplies at
 * `~/.miah/calibration/<provider>-<model>.json` (KTD10; the config base path is
 * `MIAH_CONFIG_HOME`-overridable, U1). v1 ships with default-empty corpora: no
 * profile has verdict authority until the operator supplies one (R48). A
 * missing, unreadable, or malformed profile file is treated as absent —
 * fail-closed, never authority.
 */
import * as fs from "fs";
import * as path from "path";
import { resolveConfigBasePath } from "./config";
import type { CalibrationConfig } from "./types";

/** Directory under the config base path that holds operator calibration files. */
export const CALIBRATION_DIRNAME = "calibration";

/** Schema of the operator-supplied calibration profile file. */
export const CALIBRATION_PROFILE_SCHEMA = "miah/calibration-profile/v1";

/** The tier a calibration corpus judges by default when not keyed in `tiers`. */
export const DEFAULT_CALIBRATION_TIER = "calibrated-judge";

/** A labeled verdict: what a case SHOULD have received vs what the profile did. */
export type VerdictLabel = "pass" | "fail";

/** One pre-labeled calibration case (R48). */
export interface CalibrationCase {
  /** Labeled ground truth: the verdict the case should have received. */
  label: VerdictLabel;
  /** The verdict the profile actually rendered on this pre-labeled case. */
  verdict: VerdictLabel;
  /** Optional case text for audit. */
  example?: string;
}

/** An operator-supplied calibration profile (KTD10). */
export interface CalibrationProfile {
  schema: string;
  provider: string;
  model: string;
  /** Corpus keyed by grading tier; each tier is judged independently. */
  tiers: Record<string, CalibrationCase[]>;
}

/** The computed metrics and bar verdict for one (provider, model, tier). */
export interface CalibrationMetrics {
  provider: string;
  model: string;
  tier: string;
  /** Total pre-labeled cases. */
  corpus: number;
  /** Matches / corpus (0 when corpus is empty). */
  agreement: number;
  /** Cases labeled pass that the profile judged fail. */
  false_blocks: number;
  /** Cases labeled fail that the profile judged pass (R74 floor). */
  false_passes: number;
  /** True when the profile clears the bar for this tier (R74). */
  bar_cleared: boolean;
  /** The applied bar thresholds, for audit. */
  required_corpus: number;
  required_agreement: number;
  required_false_blocks: number;
  /** Always true: the zero false-pass floor is non-relaxable (R74). */
  zero_false_pass_floor: boolean;
}

/**
 * Sanitize a provider or model id into a filename-safe token. Provider/model
 * ids legitimately contain `/` (e.g. `opencode-go/deepseek-v4-flash`), which
 * must not become path separators in the calibration filename (KTD10).
 */
export function sanitizeProfileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Absolute path of a profile file: `<base>/calibration/<provider>-<model>.json`. */
export function calibrationProfilePath(
  configBasePath: string,
  provider: string,
  model: string,
): string {
  return path.join(
    configBasePath,
    CALIBRATION_DIRNAME,
    `${sanitizeProfileName(provider)}-${sanitizeProfileName(model)}.json`,
  );
}

/**
 * Pure bar computation over one tier's corpus (R74, D7-d). The zero false-pass
 * floor is enforced unconditionally; only min_corpus / min_agreement /
 * max_false_blocks are taken from the operator config.
 */
export function computeCalibrationMetrics(
  provider: string,
  model: string,
  tier: string,
  cases: CalibrationCase[],
  bar: CalibrationConfig,
): CalibrationMetrics {
  const corpus = cases.length;
  let matches = 0;
  let falseBlocks = 0;
  let falsePasses = 0;
  for (const entry of cases) {
    if (entry.label === entry.verdict) {
      matches++;
    }
    if (entry.label === "pass" && entry.verdict === "fail") {
      falseBlocks++;
    }
    if (entry.label === "fail" && entry.verdict === "pass") {
      falsePasses++;
    }
  }
  const agreement = corpus === 0 ? 0 : matches / corpus;
  const barCleared =
    corpus >= bar.min_corpus &&
    agreement > bar.min_agreement &&
    falseBlocks <= bar.max_false_blocks &&
    falsePasses === 0;
  return {
    provider,
    model,
    tier,
    corpus,
    agreement,
    false_blocks: falseBlocks,
    false_passes: falsePasses,
    bar_cleared: barCleared,
    required_corpus: bar.min_corpus,
    required_agreement: bar.min_agreement,
    required_false_blocks: bar.max_false_blocks,
    zero_false_pass_floor: true,
  };
}

function isVerdictLabel(value: unknown): value is VerdictLabel {
  return value === "pass" || value === "fail";
}

/** Validate one corpus of pre-labeled cases; null when any entry is malformed. */
function parseCases(entries: unknown[]): CalibrationCase[] | null {
  const valid: CalibrationCase[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const c = entry as Record<string, unknown>;
    if (!isVerdictLabel(c.label) || !isVerdictLabel(c.verdict)) {
      return null;
    }
    valid.push({
      label: c.label,
      verdict: c.verdict,
      example: typeof c.example === "string" ? c.example : undefined,
    });
  }
  return valid;
}

/**
 * Parse and validate a calibration profile file. A file that is absent,
 * unparseable, or schema-invalid yields null (fail-closed: no authority, R48).
 */
export function readCalibrationProfile(filePath: string): CalibrationProfile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  if (p.schema !== CALIBRATION_PROFILE_SCHEMA) {
    return null;
  }
  if (typeof p.provider !== "string" || p.provider.length === 0) {
    return null;
  }
  if (typeof p.model !== "string" || p.model.length === 0) {
    return null;
  }
  const tiers: Record<string, CalibrationCase[]> = {};
  if (p.tiers !== undefined) {
    if (typeof p.tiers !== "object" || p.tiers === null || Array.isArray(p.tiers)) {
      return null;
    }
    for (const [tier, cases] of Object.entries(p.tiers)) {
      if (!Array.isArray(cases)) {
        return null;
      }
      const valid = parseCases(cases);
      if (valid === null) {
        return null;
      }
      tiers[tier] = valid;
    }
  }
  // Shorthand: a top-level `cases` array is the default-tier corpus.
  if (Array.isArray(p.cases)) {
    const valid = parseCases(p.cases as unknown[]);
    if (valid === null) {
      return null;
    }
    tiers[DEFAULT_CALIBRATION_TIER] = valid;
  }
  return { schema: CALIBRATION_PROFILE_SCHEMA, provider: p.provider, model: p.model, tiers };
}

/** Load the profile for a (provider, model) pair; null when absent/invalid. */
export function loadCalibrationProfile(
  configBasePath: string,
  provider: string,
  model: string,
): CalibrationProfile | null {
  return readCalibrationProfile(calibrationProfilePath(configBasePath, provider, model));
}

/**
 * Resolve the calibration metrics for a (provider, model, tier) triple against
 * the operator-supplied file (KTD10, R48). Returns null when no profile file
 * exists for the pair (the default-empty v1 posture: no verdict authority).
 */
export function resolveCalibrationMetrics(
  provider: string,
  model: string,
  tier: string,
  bar: CalibrationConfig,
  configBasePath?: string,
): CalibrationMetrics | null {
  const base = configBasePath ?? resolveConfigBasePath();
  const profile = loadCalibrationProfile(base, provider, model);
  if (profile === null) {
    return null;
  }
  const cases = profile.tiers[tier] ?? [];
  return computeCalibrationMetrics(provider, model, tier, cases, bar);
}

/** Write a profile file (operator/tooling + tests). Returns the written path. */
export function writeCalibrationProfile(
  configBasePath: string,
  profile: CalibrationProfile,
): string {
  const filePath = calibrationProfilePath(configBasePath, profile.provider, profile.model);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return filePath;
}
