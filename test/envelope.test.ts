/**
 * U5 envelope tests: schema validation, write/read round-trip, absence at
 * harvest, and the declared-path defaults.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultEnvelopePath,
  readEnvelope,
  validateEnvelope,
  writeEnvelope,
  type ResultEnvelope,
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
