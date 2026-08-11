/**
 * Specialist result envelope (R43, R16, U5; v2: KTD4).
 *
 * Specialists write a single JSON result envelope at a path the dispatch
 * packet declares (R43, R16); Miah reads it only after the adapter reports the
 * specialist finished (R44). The envelope is the producer's self-report: the
 * self-claim is free-form text that never carries evidence authority, and the
 * produced-file hashes are navigation hints, not authority (R45).
 *
 * Result-envelope v2 is role-discriminated and evidence-anchored (KTD4): a
 * verifier must emit v2 with the candidate binding (`candidate_attempt`,
 * `candidate_take`), the package seal (`evidence_package_sha256`), and exactly
 * one grade entry per non-human criterion. v1 remains the accepted shape for
 * every non-verifier role. Malformed v2 (missing, duplicate, human-tier,
 * empty-basis, or malformed-pointer entries) fails closed — the caller treats
 * it as a failed verifier attempt on the same frozen candidate (KTD5).
 *
 * Compliance with the declared path is a prompt instruction. An absent
 * envelope at harvest is not an auto-failure and not an auto-completion — it is
 * recorded as the evidence gap named in R43/R52 and the dispatch closes with a
 * non-success outcome.
 */
import * as fs from "fs";
import * as path from "path";
import { SpecialistRole, UnitId } from "./types";

/** Version of the result-envelope schema the packet declares (R43). */
export const RESULT_ENVELOPE_SCHEMA_VERSION = 1;

/** Version of the verifier's v2 result-envelope schema (KTD4). */
export const RESULT_ENVELOPE_V2_SCHEMA_VERSION = 2;

/** D5 verdict values shared by v1 grades and v2 entries (R47, KTD4). */
export const D5_VERDICTS = ["pass", "fail", "ungraded"] as const;
export type D5Verdict = (typeof D5_VERDICTS)[number];

/**
 * The output schema embedded in every dispatch packet's `output_schema`. The
 * packet tells the specialist exactly what to write at the declared path.
 */
export const RESULT_ENVELOPE_SCHEMA = {
  schema: "miah/result-envelope/v1",
  write_to:
    "a single JSON file at `result_envelope_path` relative to your worktree root",
  fields: {
    schema_version: "integer, must be 1 (required)",
    producer_role: "string: your Miah role (required)",
    attempt_id: "string: the idempotency key from this packet (required)",
    take: "integer: the take number from this packet (required)",
    unit_id: "string: the Miah unit id this dispatch belongs to (required)",
    self_claim:
      "string: free-form summary of what you did. This is NOT evidence and carries no authority.",
    produced_files:
      "array of {path, sha256}: files you produced with self-reported SHA-256 hashes. Navigation hints only, never authority.",
    wall_clock_estimate_s: "number|null: best-effort estimate of wall-clock seconds spent",
  },
} as const;

export type ResultEnvelopeSchema = typeof RESULT_ENVELOPE_SCHEMA;

/**
 * The validated result envelope shape (R43). `produced_files` hashes are
 * self-reported by the producer; Miah-harvested evidence is the authority
 * (R45).
 */
export interface ResultEnvelope {
  schema_version: 1;
  producer_role: string;
  attempt_id: string;
  take: number;
  unit_id: string;
  self_claim: string;
  produced_files: Array<{ path: string; sha256: string }>;
  wall_clock_estimate_s: number | null;
}

/**
 * Validate an unknown value against the result-envelope schema. Returns the
 * envelope when valid, null when malformed (the caller treats null as a
 * missing artifact — R43).
 */
export function validateEnvelope(value: unknown): ResultEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const e = value as Record<string, unknown>;
  if (e.schema_version !== RESULT_ENVELOPE_SCHEMA_VERSION) {
    return null;
  }
  if (typeof e.producer_role !== "string" || e.producer_role.length === 0) {
    return null;
  }
  if (typeof e.attempt_id !== "string" || e.attempt_id.length === 0) {
    return null;
  }
  if (typeof e.take !== "number" || !Number.isFinite(e.take)) {
    return null;
  }
  if (typeof e.self_claim !== "string") {
    return null;
  }
  if (typeof e.unit_id !== "string") {
    return null;
  }
  if (!Array.isArray(e.produced_files)) {
    return null;
  }
  for (const entry of e.produced_files) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.sha256 !== "string") {
      return null;
    }
  }
  const estimate = e.wall_clock_estimate_s;
  if (estimate !== null && typeof estimate !== "number") {
    return null;
  }
  return value as ResultEnvelope;
}

/**
 * Read a JSON envelope file and validate it. Returns null when the file is
 * absent, unparseable, or fails validation — all of which Miah treats as a
 * missing artifact.
 */
function readJsonEnvelope<T>(filePath: string, validate: (value: unknown) => T | null): T | null {
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
  return validate(parsed);
}

/**
 * Read and validate a result envelope. Returns null when the file is absent,
 * unparseable, or fails validation — all of which Miah treats as a missing
 * artifact (the producer not writing is the failure the gap mechanism absorbs,
 * R43).
 */
export function readEnvelope(filePath: string): ResultEnvelope | null {
  return readJsonEnvelope(filePath, validateEnvelope);
}

/** Write a result envelope as a single JSON file (the specialist's job). */
export function writeEnvelope(filePath: string, envelope: ResultEnvelope): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Result-envelope v2 (verifier, KTD4)
// ---------------------------------------------------------------------------

/**
 * One evidence pointer in a verifier grade entry (KTD4): a package-relative
 * artifact with the SHA-256 that must appear in the package's custody slice,
 * plus an optional JSON pointer into that artifact. Non-custodied pointers
 * fail closed as ungraded evidence.
 */
export interface EvidencePointer {
  /** The producer role of the pointed-at artifact (e.g. `builder`). */
  source_role: string;
  /** The producer's take (e.g. the builder take). */
  source_take: number;
  /** Package-relative artifact path, e.g. `builder/verification.json`. */
  artifact: string;
  /** SHA-256 content hash of the artifact as sealed in the package (KTD2). */
  sha256: string;
  /** Optional JSON pointer into the artifact (e.g. `$.commands[0].exit_code`). */
  pointer: string | null;
}

/** One per-criterion grade in a verifier v2 envelope (KTD4). */
export interface VerifierGradeEntry {
  /** The criterion's stable ID, e.g. "U1.AC1" (KTD1). */
  criterion_id: string;
  /** The tier declared in the plan's Acceptance bullet (KTD1: sole tier owner). */
  declared_tier: string;
  /** D5 verdict (R47): pass | fail | ungraded. */
  verdict: D5Verdict;
  /** Non-empty audit basis: what supported or withheld this grade. */
  basis: string;
  /** True raises `verifier-flagged-for-human-judgment` (KTD7). */
  flagged_for_human: boolean;
  /** Evidence pointers into the package; each must resolve to a custodied artifact (KTD4). */
  evidence: EvidencePointer[];
}

/**
 * The verifier's result-envelope v2 (KTD4). Binds every grade to the exact
 * frozen candidate (builder attempt/take) and the evidence package hash, and
 * carries exactly one grade per non-human criterion (human-tier entries are
 * omitted and rejected if present).
 */
export interface VerifierEnvelope {
  schema_version: 2;
  producer_role: "verifier";
  /** The verifier dispatch's idempotency key. */
  attempt_id: string;
  /** The verifier dispatch's take (mirrors the candidate's builder take). */
  take: number;
  unit_id: string;
  /** The frozen builder attempt (idempotency key) this envelope grades (KTD4). */
  candidate_attempt: string;
  /** The frozen builder take this envelope grades (KTD4). */
  candidate_take: number;
  /** The sealed evidence-package hash the grades cite (KTD2/KTD4). */
  evidence_package_sha256: string;
  grades: VerifierGradeEntry[];
}

/** Validator for a v2 envelope entry's evidence pointers (KTD4). */
export function validateEvidencePointer(value: unknown): EvidencePointer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const p = value as Record<string, unknown>;
  if (typeof p.source_role !== "string" || p.source_role.length === 0) {
    return null;
  }
  if (typeof p.source_take !== "number" || !Number.isFinite(p.source_take) || p.source_take <= 0) {
    return null;
  }
  if (typeof p.artifact !== "string" || p.artifact.length === 0) {
    return null;
  }
  if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(p.sha256)) {
    return null;
  }
  if (p.pointer !== null && typeof p.pointer !== "string") {
    return null;
  }
  return value as EvidencePointer;
}

/** Validator for one v2 grade entry (KTD4). */
export function validateVerifierGradeEntry(value: unknown): VerifierGradeEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const g = value as Record<string, unknown>;
  if (typeof g.criterion_id !== "string" || g.criterion_id.length === 0) {
    return null;
  }
  if (typeof g.declared_tier !== "string" || g.declared_tier.length === 0) {
    return null;
  }
  if (typeof g.verdict !== "string" || !(D5_VERDICTS as readonly string[]).includes(g.verdict)) {
    return null;
  }
  if (typeof g.basis !== "string" || g.basis.length === 0) {
    return null;
  }
  if (typeof g.flagged_for_human !== "boolean") {
    return null;
  }
  if (!Array.isArray(g.evidence)) {
    return null;
  }
  for (const pointer of g.evidence) {
    if (validateEvidencePointer(pointer) === null) {
      return null;
    }
  }
  return value as VerifierGradeEntry;
}

/**
 * Validate an unknown value against the verifier result-envelope v2 schema
 * (KTD4). Fail-closed checks: schema version 2, verifier role, candidate
 * binding present, package hash a SHA-256, no duplicate criterion IDs, no
 * `human` declared tier, non-empty basis, well-formed evidence pointers.
 * Returns the envelope when valid, null when malformed.
 *
 * An empty `grades` list is shape-valid: a unit whose acceptance criteria are
 * all `human` tier legitimately has no non-human grades (KTD4: human-tier
 * criteria must be omitted). Per-criterion coverage is enforced at ingestion
 * (`verifyGradeCoverage`), which fails closed on missing non-human grades.
 */
export function validateEnvelopeV2(value: unknown): VerifierEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const e = value as Record<string, unknown>;
  if (e.schema_version !== RESULT_ENVELOPE_V2_SCHEMA_VERSION) {
    return null;
  }
  if (e.producer_role !== "verifier") {
    return null;
  }
  if (typeof e.attempt_id !== "string" || e.attempt_id.length === 0) {
    return null;
  }
  if (typeof e.take !== "number" || !Number.isFinite(e.take) || e.take <= 0) {
    return null;
  }
  if (typeof e.unit_id !== "string" || e.unit_id.length === 0) {
    return null;
  }
  if (typeof e.candidate_attempt !== "string" || e.candidate_attempt.length === 0) {
    return null;
  }
  if (
    typeof e.candidate_take !== "number" ||
    !Number.isFinite(e.candidate_take) ||
    e.candidate_take <= 0
  ) {
    return null;
  }
  if (typeof e.evidence_package_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(e.evidence_package_sha256)) {
    return null;
  }
  if (!Array.isArray(e.grades)) {
    return null;
  }
  const seen = new Set<string>();
  for (const grade of e.grades) {
    const entry = validateVerifierGradeEntry(grade);
    if (entry === null) {
      return null;
    }
    // KTD4: human-tier criteria must be omitted; a duplicate criterion ID
    // cannot be graded twice.
    if (entry.declared_tier.toLowerCase() === "human") {
      return null;
    }
    if (seen.has(entry.criterion_id)) {
      return null;
    }
    seen.add(entry.criterion_id);
  }
  return value as VerifierEnvelope;
}

/**
 * Read and validate a verifier v2 result envelope. Returns null when the file
 * is absent, unparseable, or fails v2 validation — all of which Miah treats as
 * a failed verifier attempt on the same frozen candidate (KTD5).
 */
export function readVerifierEnvelope(filePath: string): VerifierEnvelope | null {
  return readJsonEnvelope(filePath, validateEnvelopeV2);
}

/**
 * The declared result-envelope path for a dispatch, relative to the
 * specialist's worktree root. Unique per (role, unit, take) so parallel
 * dispatches and takes never collide.
 */
export function defaultEnvelopePath(
  role: SpecialistRole,
  unitId: UnitId,
  take: number,
): string {
  return `.miah/envelope-${role}-${unitId}-t${take}.json`;
}
