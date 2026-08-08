import * as fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest, writeManifest } from "../src/manifest";
import { DEFAULT_CONFIG } from "../src/types";
import { cleanupTempDirs, createTestStore, type TestStore } from "./helpers";

afterEach(cleanupTempDirs);

function sampleManifest(t: TestStore) {
  return {
    schema_version: 1 as const,
    run_id: t.runId,
    plan_hash: "f".repeat(64),
    plan_snapshot_file: "plan-snapshot.v1.md",
    created_at: "2026-08-06T12:00:00.000Z",
    config_snapshot: DEFAULT_CONFIG,
    probe_verdicts: {},
  };
}

describe("manifest", () => {
  it("writeManifest then readManifest round-trips the manifest (run id, snapshot hash, config snapshot)", () => {
    const t: TestStore = createTestStore();
    const manifest = sampleManifest(t);
    writeManifest(t.layout, manifest);

    expect(fs.existsSync(t.layout.manifestPath)).toBe(true);
    const read = readManifest(t.layout);
    expect(read).toEqual(manifest);
    expect(read?.run_id).toBe(t.runId);
    expect(read?.plan_hash).toBe("f".repeat(64));
    expect(read?.config_snapshot).toEqual(DEFAULT_CONFIG);
    // Probe verdicts is a placeholder until U4 populates it (R57, R86-R87).
    expect(read?.probe_verdicts).toEqual({});
  });

  it("config snapshot keeps the values read at admission (R80)", () => {
    const t: TestStore = createTestStore({
      config: {
        ...DEFAULT_CONFIG,
        lease: { heartbeat_interval_s: 30, ttl_s: 60 },
        run: { ...DEFAULT_CONFIG.run, max_takes: 3 },
      },
    });
    const manifest = { ...sampleManifest(t), config_snapshot: t.config };
    writeManifest(t.layout, manifest);
    const read = readManifest(t.layout);
    expect(read?.config_snapshot.lease.ttl_s).toBe(60);
    expect(read?.config_snapshot.journal.snapshot_cadence).toBe(50);
  });

  it("readManifest returns null when absent or unparseable", () => {
    const t: TestStore = createTestStore();
    expect(readManifest(t.layout)).toBeNull();

    fs.writeFileSync(t.layout.manifestPath, "NOT-JSON", "utf8");
    expect(readManifest(t.layout)).toBeNull();
  });
});
