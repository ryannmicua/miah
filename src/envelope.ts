/**
 * Specialist result envelope (R43, R16, U5).
 *
 * Specialists write a single JSON result envelope at a path the dispatch
 * packet declares (R43, R16); Miah reads it only after the adapter reports the
 * specialist finished (R44). The envelope is the producer's self-report: the
 * self-claim is free-form text that never carries evidence authority, and the
 * produced-file hashes are navigation hints, not authority (R45).
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
 * Read and validate a result envelope. Returns null when the file is absent,
 * unparseable, or fails validation — all of which Miah treats as a missing
 * artifact (the producer not writing is the failure the gap mechanism absorbs,
 * R43).
 */
export function readEnvelope(filePath: string): ResultEnvelope | null {
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
  return validateEnvelope(parsed);
}

/** Write a result envelope as a single JSON file (the specialist's job). */
export function writeEnvelope(filePath: string, envelope: ResultEnvelope): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
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
