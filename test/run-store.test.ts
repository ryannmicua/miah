import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunStoreDirs,
  listRunIds,
  resolveRunLayout,
  RUN_STORE_DIRNAME,
  runIdFromPlan,
  RunStore,
} from "../src/run-store";
import {
  cleanupTempDirs,
  createTestStore,
  fastConfig,
  makeTempDir,
  TEST_RUN_ID,
  type TestStore,
} from "./helpers";

afterEach(cleanupTempDirs);

describe("run-store", () => {
  it("lays out the run store per R32 under basePath/runs/<run-id>/", () => {
    const basePath = makeTempDir();
    const layout = resolveRunLayout(basePath, TEST_RUN_ID);

    expect(path.dirname(path.dirname(layout.root))).toBe(basePath);
    expect(path.basename(path.dirname(layout.root))).toBe(RUN_STORE_DIRNAME);
    expect(path.basename(layout.root)).toBe(TEST_RUN_ID);

    expect(path.basename(layout.manifestPath)).toBe("manifest.json");
    expect(path.basename(layout.planSnapshotPath)).toBe("plan-snapshot.v1.md");
    expect(path.basename(layout.unitsJsonPath)).toBe("units.json");
    expect(path.basename(layout.journalPath)).toBe("journal.jsonl");
    expect(path.basename(layout.leasePath)).toBe("lease.lock");
    expect(path.basename(layout.snapshotsDir)).toBe("snapshots");
    expect(path.basename(layout.evidenceDir)).toBe("evidence");
    expect(path.basename(layout.approvalPackagePath)).toBe("approval-package.json");
  });

  it("createRunStoreDirs creates the run-store directory tree", () => {
    const basePath = makeTempDir();
    const layout = resolveRunLayout(basePath, TEST_RUN_ID);
    createRunStoreDirs(layout);

    expect(fs.existsSync(layout.root)).toBe(true);
    expect(fs.statSync(layout.root).isDirectory()).toBe(true);
    expect(fs.existsSync(layout.snapshotsDir)).toBe(true);
    expect(fs.existsSync(layout.evidenceDir)).toBe(true);
  });

  it("runIdFromPlan derives from the plan content hash and admission time", () => {
    const at = Date.parse("2026-08-06T12:34:56");
    const a = runIdFromPlan("a".repeat(64), at);
    const b = runIdFromPlan("a".repeat(64), at);
    const c = runIdFromPlan("b".repeat(64), at);
    const d = runIdFromPlan("a".repeat(64), at + 1000);

    expect(a).toBe(b);
    expect(a).toContain("aaaaaaaaaa");
    expect(a).toContain("20260806T123456");
    expect(c).not.toBe(a); // different hash
    expect(d).not.toBe(a); // different admission time
  });

  it("writes everything under the injected base path, never the cwd", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");
    t.store.append("run_start", { run_id: t.runId, plan_hash: "h1" });

    expect(fs.existsSync(t.layout.journalPath)).toBe(true);
    expect(fs.existsSync(t.layout.leasePath)).toBe(true);
    expect(fs.existsSync(t.layout.manifestPath)).toBe(false); // admission writes it, not U3
    expect(fs.readdirSync(t.basePath)).toEqual(["runs"]);
  });

  it("listRunIds returns the run ids ascending", () => {
    const basePath = makeTempDir();
    createRunStoreDirs(resolveRunLayout(basePath, "run-aaa-20260806T010101"));
    createRunStoreDirs(resolveRunLayout(basePath, "run-bbb-20260806T010102"));
    expect(listRunIds(basePath)).toEqual(["run-aaa-20260806T010101", "run-bbb-20260806T010102"]);
    expect(listRunIds(makeTempDir())).toEqual([]);
  });

  it("acquire + append + replay round-trips derived state through the run store", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");
    t.store.append("run_start", { run_id: t.runId, plan_hash: "h1" });
    t.store.append("dispatch_intent", { unit_id: "U1", take: 1, idempotency_key: "k1" });
    t.store.append("acceptance_decision", { unit_id: "U1", decision: "accept" });

    const state = t.store.replay().state;
    expect(state.run_id).toBe(t.runId);
    expect(state.units.U1.status).toBe("accepted");
    expect(state.seq).toBe(4); // lease_acquired + run_start + dispatch_intent + acceptance
    expect(t.store.stateSnapshot()).toEqual(state);
  });

  it("lease.lock survives restart: a new RunStore on the same layout reads the holder", () => {
    const t: TestStore = createTestStore();
    t.store.lease.acquire("holder-A");
    t.store.append("run_start", { run_id: t.runId, plan_hash: "h1" });

    const resumed = new RunStore({
      basePath: t.basePath,
      runId: t.runId,
      config: t.config,
      holderId: "holder-R",
      now: t.clock.fn,
    });
    expect(resumed.lease.read()?.holder_id).toBe("holder-A");
    // Resumer cannot append before taking the stale lease (R15/R34).
    expect(() => resumed.append("phase_transition", { to: "Implementing" })).toThrow();
    expect(resumed.replay().state.run_id).toBe(t.runId);
  });

  it("snapshot cadence is configurable through Config.journal.snapshot_cadence (R71)", () => {
    const t: TestStore = createTestStore({
      config: fastConfig({ journal: { snapshot_cadence: 5 } }),
    });
    t.store.lease.acquire("holder-A");
    for (let i = 0; i < 12; i++) {
      t.store.append("phase_transition", { to: `P${i}` });
    }
    expect(fs.readdirSync(t.layout.snapshotsDir).sort()).toEqual(["state-10.json", "state-5.json"]);
  });
});
