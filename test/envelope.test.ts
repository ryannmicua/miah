/**
 * U5 envelope tests: schema validation, write/read round-trip, absence at
 * harvest, the declared-path defaults, and the verifier's v2 envelope
 * (KTD4): discriminated v1/v2 shapes and a fail-closed v2 validation matrix.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultEnvelopePath,
  readEnvelope,
  readVerifierEnvelope,
  validateEnvelope,
  validateEnvelopeV2,
  writeEnvelope,
  type ResultEnvelope,
  type VerifierEnvelope,
} from "../src/envelope";
import { cleanupTempDirs, makeTempDir } from "./helpers";

function validEnvelope(overrides: Partial<ResultEnvelope> = {}): ResultEnvelope {
  return {
    schema_version: 1,
    producer_role: "builder",
    attempt_id: "dispatch-builder-U1-t1",
    take: 1,
    unit_id: "U1",
    self_claim: "Implemented src/hello.ts.",
    produced_files: [{ path: "src/hello.ts", sha256: "a".repeat(64) }],
    wall_clock_estimate_s: 120,
    ...overrides,
  };
}

/** A valid v2 verifier envelope (U4.AC3). */
function validV2(overrides: Partial<VerifierEnvelope> = {}): VerifierEnvelope {
  return {
    schema_version: 2,
    producer_role: "verifier",
    attempt_id: "dispatch-verifier-U1-t1-a1",
    take: 1,
    unit_id: "U1",
    candidate_attempt: "dispatch-builder-U1-t1",
    candidate_take: 1,
    evidence_package_sha256: "a".repeat(64),
    grades: [
      {
        criterion_id: "U1.AC1",
        declared_tier: "deterministic",
        verdict: "pass",
        basis: "commands all-passed; evidence genuine and complete",
        flagged_for_human: false,
        evidence: [
          {
            source_role: "builder",
            source_take: 1,
            artifact: "builder/verification.json",
            sha256: "b".repeat(64),
            pointer: "$.all_passed",
          },
        ],
      },
      {
        criterion_id: "U1.AC2",
        declared_tier: "calibrated-judge",
        verdict: "pass",
        basis: "judgment from evidence",
        flagged_for_human: false,
        evidence: [{ source_role: "builder", source_take: 1, artifact: "builder/diff.patch", sha256: "c".repeat(64), pointer: null }],
      },
    ],
    ...overrides,
  };
}

afterEach(cleanupTempDirs);

describe("dispatch envelope", () => {
  it("validates a well-formed envelope (R43 fields)", () => {
    expect(validateEnvelope(validEnvelope())).toEqual(validEnvelope());
  });

  it("rejects envelopes missing required R43 fields", () => {
    expect(validateEnvelope({ ...validEnvelope(), producer_role: undefined })).toBeNull();
    expect(validateEnvelope({ ...validEnvelope(), attempt_id: "" })).toBeNull();
    expect(validateEnvelope({ ...validEnvelope(), take: "1" })).toBeNull();
    expect(validateEnvelope({ ...validEnvelope(), self_claim: 42 })).toBeNull();
    // An empty produced_files list is allowed (a producer may legitimately
    // have nothing to point at); a malformed entry is not.
    expect(validateEnvelope({ ...validEnvelope(), produced_files: [] })).toEqual(
      validEnvelope({ produced_files: [] }),
    );
    expect(
      validateEnvelope({
        ...validEnvelope(),
        produced_files: [{ path: "x.ts" } as never],
      }),
    ).toBeNull();
    expect(validateEnvelope({ ...validEnvelope(), schema_version: 2 })).toBeNull();
    expect(validateEnvelope("not an object")).toBeNull();
    expect(validateEnvelope(null)).toBeNull();
  });

  it("write then read round-trips the envelope", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, ".miah", "envelope.json");
    writeEnvelope(filePath, validEnvelope());
    expect(readEnvelope(filePath)).toEqual(validEnvelope());
  });

  it("read returns null when the envelope file is absent (R43 harvest case)", () => {
    const dir = makeTempDir();
    expect(readEnvelope(path.join(dir, ".miah", "does-not-exist.json"))).toBeNull();
  });

  it("read returns null when the envelope file is malformed or invalid", () => {
    const dir = makeTempDir();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ not json", "utf8");
    expect(readEnvelope(bad)).toBeNull();

    const invalid = path.join(dir, "invalid.json");
    fs.writeFileSync(invalid, JSON.stringify({ schema_version: 9 }), "utf8");
    expect(readEnvelope(invalid)).toBeNull();
  });

  it("default envelope path is per role/unit/take and relative to the worktree", () => {
    expect(defaultEnvelopePath("builder", "U1", 1)).toBe(".miah/envelope-builder-U1-t1.json");
    expect(defaultEnvelopePath("planner", "U1", 1)).toBe(".miah/envelope-planner-U1-t1.json");
    expect(defaultEnvelopePath("builder", "U1", 2)).toBe(".miah/envelope-builder-U1-t2.json");
  });
});

describe("verifier envelope v2 (KTD4)", () => {
  it("U4.AC3: v1 non-verifier envelopes remain accepted; a valid v2 verifier envelope returns the discriminated grade shape", () => {
    expect(validateEnvelope(validEnvelope())).toEqual(validEnvelope());
    // The v1 validator never accepts a v2 envelope...
    expect(validateEnvelope(validV2() as unknown as ResultEnvelope)).toBeNull();
    // ...and the v2 validator never accepts a v1 envelope.
    expect(validateEnvelopeV2(validEnvelope())).toBeNull();

    const parsed = validateEnvelopeV2(validV2());
    expect(parsed).not.toBeNull();
    expect(parsed?.producer_role).toBe("verifier");
    expect(parsed?.candidate_attempt).toBe("dispatch-builder-U1-t1");
    expect(parsed?.candidate_take).toBe(1);
    expect(parsed?.evidence_package_sha256).toBe("a".repeat(64));
    expect(parsed?.grades).toHaveLength(2);
    expect(parsed?.grades[0]).toMatchObject({
      criterion_id: "U1.AC1",
      declared_tier: "deterministic",
      verdict: "pass",
      flagged_for_human: false,
    });
  });

  it("U4.AC4: missing, duplicate, human-tier, empty-basis, and malformed-pointer grades fail closed", () => {
    // Empty grades are shape-valid only when every criterion is human (KTD4
    // omits human-tier entries); per-criterion coverage is enforced at
    // ingestion (verifyGradeCoverage), so a missing non-human grade fails
    // there, while a non-array grades field fails here.
    expect(validateEnvelopeV2(validV2({ grades: undefined as never }))).toBeNull();
    expect(validateEnvelopeV2(validV2({ grades: "nope" as never }))).toBeNull();

    // Duplicate criterion IDs cannot be graded twice.
    const duplicate = validV2();
    duplicate.grades[1] = { ...duplicate.grades[0] };
    expect(validateEnvelopeV2(duplicate)).toBeNull();

    // Human-tier entries must be omitted.
    expect(
      validateEnvelopeV2(
        validV2({
          grades: [
            {
              criterion_id: "U1.AC3",
              declared_tier: "human",
              verdict: "pass",
              basis: "operator would grade this",
              flagged_for_human: false,
              evidence: [],
            },
          ],
        }),
      ),
    ).toBeNull();

    // Empty basis.
    expect(
      validateEnvelopeV2(
        validV2({ grades: [validV2().grades[0], { ...validV2().grades[1], basis: "" }] }),
      ),
    ).toBeNull();

    // Non-D5 verdict.
    expect(
      validateEnvelopeV2(
        validV2({ grades: [{ ...validV2().grades[0], verdict: "maybe" as never }] }),
      ),
    ).toBeNull();

    // Malformed evidence pointers: bad hash, missing artifact, bad source_take.
    expect(
      validateEnvelopeV2(
        validV2({
          grades: [
            {
              ...validV2().grades[0],
              evidence: [{ source_role: "builder", source_take: 1, artifact: "x", sha256: "zz", pointer: null }],
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      validateEnvelopeV2(
        validV2({
          grades: [{ ...validV2().grades[0], evidence: [{ source_role: "builder", source_take: 0, artifact: "x", sha256: "b".repeat(64), pointer: null }] }],
        }),
      ),
    ).toBeNull();

    // Missing candidate binding or package seal.
    expect(validateEnvelopeV2(validV2({ candidate_attempt: "" }))).toBeNull();
    expect(validateEnvelopeV2(validV2({ candidate_take: 0 }))).toBeNull();
    expect(validateEnvelopeV2(validV2({ evidence_package_sha256: "not-a-hash" }))).toBeNull();

    // Wrong producer role / version.
    expect(validateEnvelopeV2(validV2({ producer_role: "builder" as never }))).toBeNull();
    expect(validateEnvelopeV2(validV2({ schema_version: 1 as never }))).toBeNull();
  });

  it("readVerifierEnvelope round-trips a v2 envelope and returns null for absent/malformed files", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, ".miah"), { recursive: true });
    const filePath = path.join(dir, ".miah", "envelope-verifier-U1-t1.json");
    fs.writeFileSync(filePath, JSON.stringify(validV2()), "utf8");
    expect(readVerifierEnvelope(filePath)).toEqual(validV2());

    expect(readVerifierEnvelope(path.join(dir, ".miah", "missing.json"))).toBeNull();
    fs.writeFileSync(path.join(dir, ".miah", "bad.json"), "{ nope", "utf8");
    expect(readVerifierEnvelope(path.join(dir, ".miah", "bad.json"))).toBeNull();
    // A v1 envelope is not a v2 verifier envelope.
    fs.writeFileSync(path.join(dir, ".miah", "v1.json"), JSON.stringify(validEnvelope()), "utf8");
    expect(readVerifierEnvelope(path.join(dir, ".miah", "v1.json"))).toBeNull();
  });
});
