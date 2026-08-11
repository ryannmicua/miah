/**
 * U3 verifier evidence package tests (KTD2-KTD3, R2-R3, R13, R15; U3.AC1-AC5).
 *
 * The package is composed only after a builder harvest, from hashed artifacts
 * and the applicable custody slice; raw uncustodied specialist output is never
 * copied; `.miah/` transport writes are excluded from the T2-T3 workspace
 * hash; and the verifier-result harvest never re-runs contract commands or
 * reports a vacuous zero-command `all_passed`.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeVerifierPackage,
  harvestVerifierResult,
  validateVerifierPackage,
  VERIFIER_PACKAGE_SCHEMA,
  VERIFIER_RESULT_SCHEMA,
  type VerifierPackageManifest,
} from "../src/verifier";
import {
  harvestEvidence,
  takeContinuityRecord,
  workspaceHash,
} from "../src/evidence";
import { appendToChain, computeArtifactHash, custodyChainPath, readChainFile, writeChainFile } from "../src/custody";
import { writeEnvelope } from "../src/envelope";
import { cleanupTempDirs, createTestStore, makeTempDir, type TestStore } from "./helpers";
import type { AwaitingCandidate, PlanUnit } from "../src/types";

const UNIT_U1: PlanUnit = {
  id: "U1",
  number: 1,
  title: "Source module",
  goal: "Create src/foo.py.",
  requirements: "R1",
  creates: ["src/foo.py"],
  inputs: [],
  dependsOn: [],
  acceptance: [
    { id: "U1.AC1", text: "src/foo.py exists", tier: "deterministic" },
    { id: "U1.AC2", text: "A verifier judges the API", tier: "calibrated-judge" },
  ],
  verificationContract: {
    commands: [{ id: "U1.CMD1", command: "npm test" }],
    criterion_map: {
      "U1.AC1": { commands: ["U1.CMD1"], evidence_sources: ["verification"] },
      "U1.AC2": { commands: [], evidence_sources: ["verification"] },
    },
  },
};

const CANDIDATE: AwaitingCandidate = {
  take: 1,
  attempt: "dispatch-builder-U1-t1",
  agent_id: "agent-1",
  workspace_id: "wks-1",
  base_commit: "commit-base",
  deadline: "2026-08-11T00:00:00.000Z",
  envelope_path: ".miah/envelope-builder-U1-t1.json",
};

function setupStore(): TestStore {
  const t = createTestStore({ holderId: "holder-A" });
  const acquired = t.store.lease.acquire("holder-A");
  if (!acquired.ok) {
    throw new Error(`lease acquire failed: ${acquired.reason}`);
  }
  fs.writeFileSync(t.layout.planSnapshotPath, "---\n", "utf8");
  fs.writeFileSync(t.layout.unitsJsonPath, `${JSON.stringify({ U1: UNIT_U1 }, null, 2)}\n`, "utf8");
  return t;
}

/** A seeded builder worktree: creates files, writes its v1 envelope. */
function seedWorktree(): string {
  const worktree = makeTempDir();
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");
  writeEnvelope(path.join(worktree, ".miah", "envelope-builder-U1-t1.json"), {
    schema_version: 1,
    producer_role: "builder",
    attempt_id: "dispatch-builder-U1-t1",
    take: 1,
    unit_id: "U1",
    self_claim: "Produced src/foo.py.",
    produced_files: [{ path: "src/foo.py", sha256: "a".repeat(64) }],
    wall_clock_estimate_s: 5,
  });
  return worktree;
}

/** Harvest the seeded builder exactly as the step layer does. */
async function harvestBuilder(t: TestStore, worktree: string): Promise<void> {
  const envelopePath = path.join(worktree, ".miah", "envelope-builder-U1-t1.json");
  const envelope = fs.existsSync(envelopePath)
    ? (JSON.parse(fs.readFileSync(envelopePath, "utf8")) as Parameters<typeof harvestEvidence>[0]["envelope"])
    : null;
  await harvestEvidence({
    store: t.store,
    unit: UNIT_U1,
    role: "builder",
    take: 1,
    attempt: "dispatch-builder-U1-t1",
    agentId: "agent-1",
    worktreeRoot: worktree,
    baseCommit: "commit-base",
    envelope,
    verificationCommands: ["npm test"],
    runCommand: async (command) => ({
      command,
      exit_code: 0,
      stdout: "ok\n",
      stderr: "",
    }),
    preDispatchUsage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd: 1.0 },
    postTerminationUsage: { inputTokens: 150, outputTokens: 60, cachedTokens: 5, costUsd: 1.4 },
    diffRunner: async () => ({
      diff: "diff --git a/src/foo.py b/src/foo.py\n+print('hi')\n",
      changedFiles: ["src/foo.py"],
      untrackedFiles: [],
      commands: ["git diff"],
    }),
  });
}

afterEach(cleanupTempDirs);

describe("verifier package composition (KTD2, U3.AC1)", () => {
  it("composes a complete package: identity, contract, criteria, custody slice, sealed entries", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);

    const composed = composeVerifierPackage({
      store: t.store,
      unit: UNIT_U1,
      candidate: CANDIDATE,
      worktreeRoot: worktree,
    });

    const manifest: VerifierPackageManifest = composed.manifest;
    expect(manifest.schema).toBe(VERIFIER_PACKAGE_SCHEMA);
    expect(manifest.unit_id).toBe("U1");
    expect(manifest.candidate).toMatchObject({
      take: 1,
      attempt: "dispatch-builder-U1-t1",
      agent_id: "agent-1",
      workspace_id: "wks-1",
      base_commit: "commit-base",
      envelope_path: ".miah/envelope-builder-U1-t1.json",
    });
    expect(manifest.workspace.workspace_id).toBe("wks-1");
    expect(manifest.workspace.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Frozen criterion + contract data (KTD1/KTD2).
    expect(manifest.criteria).toEqual([
      { id: "U1.AC1", text: "src/foo.py exists", tier: "deterministic" },
      { id: "U1.AC2", text: "A verifier judges the API", tier: "calibrated-judge" },
    ]);
    expect(manifest.contract.commands).toEqual([{ id: "U1.CMD1", command: "npm test" }]);
    expect(manifest.contract.criterion_map["U1.AC1"].commands).toEqual(["U1.CMD1"]);

    // Every KTD2 builder artifact rides in the package.
    const keys = manifest.builder_artifacts.map((a) => a.key).sort();
    expect(keys).toEqual(["diff", "envelope", "record", "usage_delta", "verification"]);
    for (const artifact of manifest.builder_artifacts) {
      expect(fs.existsSync(path.join(composed.packageDir, artifact.path))).toBe(true);
    }

    // Custody slice: prior + last hashes and a chain that verifies.
    expect(manifest.custody.prior_hash).toBeNull(); // first harvest in the chain
    expect(manifest.custody.last_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.custody.slice.length).toBeGreaterThan(0);
    let prev = manifest.custody.prior_hash;
    for (const header of manifest.custody.slice) {
      expect(header.prev_hash).toBe(prev);
      prev = header.content_hash;
    }
    expect(manifest.custody.slice[manifest.custody.slice.length - 1].content_hash).toBe(
      manifest.custody.last_hash,
    );

    // Entries are package-relative with forward slashes (Windows-safe) and
    // every entry exists on disk with the sealed hash.
    for (const entry of manifest.entries) {
      expect(entry.path).not.toContain("\\");
      const full = path.join(composed.packageDir, entry.path);
      expect(fs.existsSync(full), `entry ${entry.path}`).toBe(true);
    }
    expect(composed.packageSha256).toMatch(/^[0-9a-f]{64}$/);

    // The composed package validates on disk (tamper-negative baseline).
    expect(validateVerifierPackage(composed.packageDir).ok).toBe(true);
  });

  it("the builder envelope is tagged producer-self-report (KTD2, U3.AC3)", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);
    const composed = composeVerifierPackage({
      store: t.store,
      unit: UNIT_U1,
      candidate: CANDIDATE,
      worktreeRoot: worktree,
    });
    expect(composed.manifest.producer_self_report).toMatchObject({
      path: "builder/envelope.json",
    });
    // The self-claim's produced_files hashes are NOT package entries: a
    // pointer to a self-reported path resolves to nothing.
    expect(
      composed.manifest.entries.some((e) => e.path === "src/foo.py"),
    ).toBe(false);
  });

  it("an absent builder envelope yields producer_self_report null but still composes", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    fs.rmSync(path.join(worktree, ".miah", "envelope-builder-U1-t1.json"));
    await harvestBuilder(t, worktree);
    const composed = composeVerifierPackage({
      store: t.store,
      unit: UNIT_U1,
      candidate: CANDIDATE,
      worktreeRoot: worktree,
    });
    expect(composed.manifest.producer_self_report).toBeNull();
    expect(validateVerifierPackage(composed.packageDir).ok).toBe(true);
  });

  it("throws when the builder harvest record is absent", () => {
    const t = setupStore();
    const worktree = seedWorktree();
    expect(() =>
      composeVerifierPackage({
        store: t.store,
        unit: UNIT_U1,
        candidate: CANDIDATE,
        worktreeRoot: worktree,
      }),
    ).toThrow(/no harvested builder evidence/);
  });

  it("throws when the custody chain is broken", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);

    // Corrupt the chain: rewrite it with a broken link.
    const chainPath = custodyChainPath(t.layout.evidenceDir);
    const chain = readChainFile(chainPath);
    chain[1] = { ...chain[1], prev_hash: "deadbeef".repeat(8) };
    writeChainFile(chainPath, chain);

    expect(() =>
      composeVerifierPackage({
        store: t.store,
        unit: UNIT_U1,
        candidate: CANDIDATE,
        worktreeRoot: worktree,
      }),
    ).toThrow(/custody chain is broken/);
  });
});

describe("verifier package validation (KTD2/KTD3)", () => {
  async function composed(): Promise<{ t: TestStore; worktree: string; packageDir: string }> {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);
    const result = composeVerifierPackage({
      store: t.store,
      unit: UNIT_U1,
      candidate: CANDIDATE,
      worktreeRoot: worktree,
    });
    return { t, worktree, packageDir: result.packageDir };
  }

  it("detects a tampered package artifact", async () => {
    const { packageDir } = await composed();
    const artifactPath = path.join(packageDir, "builder", "diff.patch");
    fs.writeFileSync(artifactPath, "tampered diff\n", "utf8");
    const result = validateVerifierPackage(packageDir);
    expect(result.ok).toBe(false);
    expect(result.badPath).toBe(path.join("builder", "diff.patch").replace(/\\/g, "/"));
    expect(result.message).toContain("tampered");
  });

  it("detects a deleted package artifact", async () => {
    const { packageDir } = await composed();
    fs.rmSync(path.join(packageDir, "custody-slice.json"));
    const result = validateVerifierPackage(packageDir);
    expect(result.ok).toBe(false);
    expect(result.badPath).toBe("custody-slice.json");
  });
});

describe("tester records in the package (KTD2, U3.AC2)", () => {
  /** Write a tester evidence record + custody header as the step layer would. */
  function seedHarvestedTesterRecord(t: TestStore): string {
    const evidenceDir = path.join(t.layout.evidenceDir, "U1", "1", "tester");
    fs.mkdirSync(evidenceDir, { recursive: true });
    const record = JSON.stringify(
      { schema: "miah/evidence-record/v1", role: "tester", unit_id: "U1", take: 1, note: "tester record" },
      null,
      2,
    );
    const recordPath = path.join(evidenceDir, "evidence.json");
    fs.writeFileSync(recordPath, record, "utf8");
    const chainPath = custodyChainPath(t.layout.evidenceDir);
    const chain = readChainFile(chainPath);
    const extended = appendToChain(chain, {
      artifact: "U1/1/tester/evidence.json",
      role: "tester",
      agent_id: "agent-t",
      attempt: "dispatch-tester-U1-t1",
      take: 1,
      harvest_ts: Date.now(),
      content_hash: computeArtifactHash(record),
    });
    writeChainFile(chainPath, extended);
    return recordPath;
  }

  it("includes harvested tester records with custody references and records absence explicitly", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);
    seedHarvestedTesterRecord(t);

    const composed = composeVerifierPackage({
      store: t.store,
      unit: UNIT_U1,
      candidate: CANDIDATE,
      worktreeRoot: worktree,
    });
    expect(composed.manifest.tester_records).toHaveLength(1);
    expect(composed.manifest.tester_records[0].custody.role).toBe("tester");
    expect(fs.existsSync(path.join(composed.packageDir, composed.manifest.tester_records[0].path))).toBe(
      true,
    );
  });

  it("records an explicit empty list when no tester evidence exists", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);
    const composed = composeVerifierPackage({
      store: t.store,
      unit: UNIT_U1,
      candidate: CANDIDATE,
      worktreeRoot: worktree,
    });
    expect(composed.manifest.tester_records).toEqual([]);
  });

  it("excludes raw uncustodied tester output even when a file exists on disk", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);

    // A tester evidence.json with NO custody header (never harvested).
    const rawDir = path.join(t.layout.evidenceDir, "U1", "1", "tester");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, "evidence.json"), "raw uncustodied output", "utf8");

    const composed = composeVerifierPackage({
      store: t.store,
      unit: UNIT_U1,
      candidate: CANDIDATE,
      worktreeRoot: worktree,
    });
    expect(composed.manifest.tester_records).toEqual([]);
  });
});

describe("T2-T3 workspace hash with .miah exclusion (KTD3, U3.AC4)", () => {
  it("source mutation changes the workspace hash; .miah transport writes do not", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);

    const afterHarvest = workspaceHash(worktree);

    // `.miah/` transport writes (verifier package + envelope) must not create
    // a false continuity failure.
    const packageDir = path.join(worktree, ".miah", "verifier", "U1", "dispatch-builder-U1-t1");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "manifest.json"), "package transport", "utf8");
    fs.writeFileSync(path.join(worktree, ".miah", "envelope-verifier-U1-t1.json"), "{}", "utf8");
    expect(workspaceHash(worktree)).toBe(afterHarvest);

    // A source mutation opens the gap: the hashes diverge.
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('tampered')\n", "utf8");
    expect(workspaceHash(worktree)).not.toBe(afterHarvest);

    // And the continuity check records the divergence (R46).
    const continuity = takeContinuityRecord(t.store, {
      unit_id: "U1",
      role: "verifier",
      take: 1,
      harvestHash: afterHarvest,
      integrationHash: workspaceHash(worktree),
    });
    expect(continuity.continuous).toBe(false);
    expect(continuity.gap?.criterion).toBe("t2-t3-continuity");
  });

  it("a package-only write keeps continuity intact", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);
    const composed = composeVerifierPackage({
      store: t.store,
      unit: UNIT_U1,
      candidate: CANDIDATE,
      worktreeRoot: worktree,
    });
    // Composing the package wrote under .miah: the workspace hash is unchanged.
    const continuity = takeContinuityRecord(t.store, {
      unit_id: "U1",
      role: "verifier",
      take: 1,
      harvestHash: workspaceHash(worktree),
      integrationHash: workspaceHash(worktree),
    });
    expect(continuity.continuous).toBe(true);
    expect(composed.packageDir).toContain(path.join(worktree, ".miah", "verifier"));
  });
});

describe("verifier-result harvest (U3.AC5)", () => {
  it("custodies the envelope and result WITHOUT running contract commands or reporting all_passed", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);

    const result = harvestVerifierResult({
      store: t.store,
      unitId: "U1",
      candidate: CANDIDATE,
      verifierAttempt: "dispatch-verifier-U1-t1-a1",
      verifierAgentId: "agent-v",
      worktreeRoot: worktree,
      envelope: { schema_version: 2, grades: [] },
      preDispatchUsage: { inputTokens: 150, outputTokens: 60, cachedTokens: 5, costUsd: 1.4 },
      postTerminationUsage: { inputTokens: 200, outputTokens: 70, cachedTokens: 5, costUsd: 1.9 },
    });

    const evidenceDir = path.join(t.layout.evidenceDir, "U1", "1", "verifier");
    expect(fs.existsSync(path.join(evidenceDir, "envelope.json"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "usage-delta.json"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "verifier-result.json"))).toBe(true);

    const record = JSON.parse(
      fs.readFileSync(path.join(evidenceDir, "verifier-result.json"), "utf8"),
    );
    expect(record.schema).toBe(VERIFIER_RESULT_SCHEMA);
    expect(record.role).toBe("verifier");
    // KTD5/R13: a role-specific harvest must never report vacuous success.
    expect(record.verification).toEqual({ commands: 0, all_passed: null });
    expect(record.usage_delta.inputTokens).toBe(50);

    // The envelope + result are custody-chained under role verifier.
    const chain = result.chain;
    const verifierHeaders = chain.filter((h) => h.role === "verifier");
    expect(verifierHeaders.length).toBeGreaterThanOrEqual(3);
    expect(verifierHeaders.every((h) => h.artifact.startsWith("U1/1/verifier/"))).toBe(true);
    // And the chain still verifies end to end.
    let prev: string | null = null;
    for (const header of chain) {
      expect(header.prev_hash).toBe(prev);
      prev = header.content_hash;
    }
  });

  it("records envelope null when the verifier produced no valid envelope", async () => {
    const t = setupStore();
    const worktree = seedWorktree();
    await harvestBuilder(t, worktree);
    const result = harvestVerifierResult({
      store: t.store,
      unitId: "U1",
      candidate: CANDIDATE,
      verifierAttempt: "dispatch-verifier-U1-t1-a1",
      verifierAgentId: "agent-v",
      worktreeRoot: worktree,
      envelope: null,
      preDispatchUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
      postTerminationUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
    });
    expect(result.record.envelope).toBeNull();
    expect(result.record.verification.all_passed).toBeNull();
  });
});
