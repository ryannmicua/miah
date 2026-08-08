/**
 * U6 evidence harvest tests (R43-R46, R53, R61; plan Test Scenarios U6.4,
 * U6.7, U6.10).
 *
 * U6.4  Harvest includes: diff file, test output file, usage delta JSON,
 *       envelope JSON.
 * U6.7  T2-T3: workspace hash same at harvest and integration -> no gap;
 *       different -> gap_recorded: T2-T3-continuity.
 * U6.10 Test code not in `creates:` is harvested as evidence -> stored in the
 *       evidence dir, NOT integrated (R53).
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeUsageDelta,
  createGitDiffRunner,
  harvestEvidence,
  takeContinuityRecord,
  workspaceHash,
} from "../src/evidence";
import { custodyChainPath, readChainFile } from "../src/custody";
import type { ResultEnvelope } from "../src/envelope";
import { cleanupTempDirs, createTestStore, makeTempDir, type TestStore } from "./helpers";
import type { PlanUnit } from "../src/types";

const UNIT_U1: PlanUnit = {
  id: "U1",
  number: 1,
  title: "Source module",
  goal: "Create src/foo.py.",
  requirements: "R61",
  creates: ["src/foo.py"],
  inputs: [],
  dependsOn: [],
  acceptance: null,
};

const ENVELOPE: ResultEnvelope = {
  schema_version: 1,
  producer_role: "builder",
  attempt_id: "dispatch-builder-U1-t1",
  take: 1,
  unit_id: "U1",
  self_claim: "Produced src/foo.py.",
  produced_files: [{ path: "src/foo.py", sha256: "a".repeat(64) }],
  wall_clock_estimate_s: 5,
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

function harvestContext(t: TestStore, worktreeRoot: string, extra: Partial<Parameters<typeof harvestEvidence>[0]> = {}) {
  return {
    store: t.store,
    unit: UNIT_U1,
    role: "builder" as const,
    take: 1,
    attempt: "dispatch-builder-U1-t1",
    agentId: "agent-1",
    worktreeRoot,
    baseCommit: "commit-base",
    envelope: ENVELOPE,
    verificationCommands: [],
    preDispatchUsage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd: 1.0 },
    postTerminationUsage: { inputTokens: 150, outputTokens: 60, cachedTokens: 5, costUsd: 1.4 },
    diffRunner: async () => ({
      diff: "diff --git a/src/foo.py b/src/foo.py\n+print('hi')\n",
      changedFiles: ["src/foo.py"],
      untrackedFiles: [],
      commands: ["git -C worktree diff base"],
    }),
    ...extra,
  };
}

afterEach(cleanupTempDirs);

describe("evidence harvest", () => {
  it("harvest includes diff file, test output file, usage delta JSON, and envelope JSON (R45, U6.4)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");

    const runCommand = async (command: string) => ({
      command,
      exit_code: 0,
      stdout: "verification-ok\n",
      stderr: "",
    });
    const outcome = await harvestEvidence(
      harvestContext(t, worktree, {
        verificationCommands: ["npm test"],
        runCommand,
      }),
    );

    const evidenceDir = path.join(t.layout.evidenceDir, "U1", "1", "builder");
    expect(outcome.evidenceDir).toBe(evidenceDir);
    expect(fs.existsSync(path.join(evidenceDir, "diff.patch"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "verification.json"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "usage-delta.json"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "envelope.json"))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, "evidence.json"))).toBe(true);

    // Diff file carries the worktree diff.
    expect(fs.readFileSync(path.join(evidenceDir, "diff.patch"), "utf8")).toBe(
      "diff --git a/src/foo.py b/src/foo.py\n+print('hi')\n",
    );
    // Test output file carries exit code + stdout/stderr.
    const verification = JSON.parse(
      fs.readFileSync(path.join(evidenceDir, "verification.json"), "utf8"),
    );
    expect(verification.commands).toHaveLength(1);
    expect(verification.commands[0]).toMatchObject({ command: "npm test", exit_code: 0 });
    expect(verification.commands[0].stdout).toBe("verification-ok\n");
    // Usage delta JSON.
    const usage = JSON.parse(fs.readFileSync(path.join(evidenceDir, "usage-delta.json"), "utf8"));
    expect(usage.delta).toMatchObject({ inputTokens: 50, outputTokens: 10, cachedTokens: 5 });
    expect(usage.delta.costUsd).toBeCloseTo(0.4, 10);
    // Envelope JSON.
    expect(JSON.parse(fs.readFileSync(path.join(evidenceDir, "envelope.json"), "utf8"))).toEqual(
      ENVELOPE,
    );

    // The record seals all four artifacts with hashes.
    const record = outcome.record;
    expect(Object.keys(record.artifacts).sort()).toEqual([
      "diff",
      "envelope",
      "record",
      "usage_delta",
      "verification",
    ]);
    for (const ref of Object.values(record.artifacts)) {
      expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("evidence is written to the run-store evidence dir keyed by (unit, take, role)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "x\n", "utf8");

    const first = await harvestEvidence(harvestContext(t, worktree, { take: 1 }));
    const second = await harvestEvidence(harvestContext(t, worktree, { take: 2 }));

    expect(first.evidenceDir).toBe(path.join(t.layout.evidenceDir, "U1", "1", "builder"));
    expect(second.evidenceDir).toBe(path.join(t.layout.evidenceDir, "U1", "2", "builder"));
    expect(fs.existsSync(path.join(first.evidenceDir, "evidence.json"))).toBe(true);
    expect(fs.existsSync(path.join(second.evidenceDir, "evidence.json"))).toBe(true);
    expect(path.dirname(first.evidenceDir)).toBe(path.join(t.layout.evidenceDir, "U1", "1"));
    expect(path.dirname(second.evidenceDir)).toBe(path.join(t.layout.evidenceDir, "U1", "2"));
  });

  it("verification contract commands run via child_process.exec capture exit code + stdout/stderr (R45)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "x\n", "utf8");

    const outcome = await harvestEvidence(
      harvestContext(t, worktree, {
        // No injected runCommand: the real child_process.exec path (U6 approach).
        verificationCommands: [
          'node -e "console.log(\'stdout-line\')"',
          'node -e "process.exit(7)"',
        ],
      }),
    );

    const verification = JSON.parse(
      fs.readFileSync(path.join(outcome.evidenceDir, "verification.json"), "utf8"),
    );
    expect(verification.commands).toHaveLength(2);
    expect(verification.commands[0].exit_code).toBe(0);
    expect(verification.commands[0].stdout).toContain("stdout-line");
    expect(verification.commands[1].exit_code).toBe(7);
    expect(verification.all_passed).toBe(false);
    expect(outcome.record.verification).toEqual({
      commands: 2,
      failed: 1,
      all_passed: false,
    });
  });

  it("computeUsageDelta subtracts pre-dispatch usage from post-termination usage, honestly null when incalculable", () => {
    const delta = computeUsageDelta(
      { inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd: 1.0 },
      { inputTokens: 150, outputTokens: 60, cachedTokens: 5, costUsd: 1.4 },
    );
    expect(delta).toMatchObject({ inputTokens: 50, outputTokens: 10, cachedTokens: 5 });
    expect(delta.costUsd).toBeCloseTo(0.4, 10);

    const missing = computeUsageDelta(
      { inputTokens: null, outputTokens: 50, cachedTokens: 0, costUsd: null },
      { inputTokens: 150, outputTokens: 60, cachedTokens: 5, costUsd: 1.4 },
    );
    expect(missing.inputTokens).toBeNull();
    expect(missing.costUsd).toBeNull();
    expect(missing.outputTokens).toBe(10);
  });

  it("a missing envelope is not a crash: the harvest records no envelope artifact and completes (R43)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "x\n", "utf8");

    const outcome = await harvestEvidence(harvestContext(t, worktree, { envelope: null }));

    expect(fs.existsSync(path.join(outcome.evidenceDir, "envelope.json"))).toBe(false);
    expect(outcome.record.artifacts.envelope).toBeUndefined();
    expect(outcome.event.artifacts.envelope).toBeUndefined();
    // The remaining artifacts were still harvested and sealed into custody.
    const chainPath = custodyChainPath(t.layout.evidenceDir);
    expect(readChainFile(chainPath)).toHaveLength(4);
    expect(outcome.record.postflight.ok).toBe(true);
  });

  it("test code not in creates: is harvested as evidence, stored in the evidence dir, and NOT integrated (R53, U6.10)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");
    fs.mkdirSync(path.join(worktree, "test"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "test", "foo_test.py"), "def test():\n    pass\n", "utf8");

    const diffText = [
      "diff --git a/src/foo.py b/src/foo.py",
      "+print('hi')",
      "diff --git a/test/foo_test.py b/test/foo_test.py",
      "+def test():",
    ].join("\n");
    const outcome = await harvestEvidence(
      harvestContext(t, worktree, {
        diffRunner: async () => ({
          diff: diffText,
          changedFiles: ["src/foo.py", "test/foo_test.py"],
          untrackedFiles: [],
          commands: [],
        }),
      }),
    );

    // The test file is inside the harvested diff (it is evidence).
    expect(fs.readFileSync(path.join(outcome.evidenceDir, "diff.patch"), "utf8")).toContain(
      "test/foo_test.py",
    );
    // It is partitioned as evidence-only, never a deliverable (R53).
    expect(outcome.record.evidence_only_files).toContain("test/foo_test.py");
    expect(outcome.record.evidence_only_files).not.toContain("src/foo.py");
    expect(outcome.record.deliverables).toEqual(["src/foo.py"]);
    expect(outcome.record.deliverables).not.toContain("test/foo_test.py");
  });

  it("the evidence_harvested event journals derived refs and hashes only — never raw diff/prose content (R35, R41)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "x\n", "utf8");

    const UNIQUE_MARKER = "UNIQUE_DIFF_BODY_xyz";
    const outcome = await harvestEvidence(
      harvestContext(t, worktree, {
        diffRunner: async () => ({
          diff: UNIQUE_MARKER,
          changedFiles: ["src/foo.py"],
          untrackedFiles: [],
          commands: [],
        }),
      }),
    );

    expect(outcome.event.type).toBe("evidence_harvested");
    expect(outcome.event).toMatchObject({
      unit_id: "U1",
      role: "builder",
      take: 1,
      attempt: "dispatch-builder-U1-t1",
      agent_id: "agent-1",
      evidence_path: "evidence/U1/1/builder",
    });
    expect(outcome.event.custody_prev_hash).toBeNull(); // first harvest on a fresh chain
    const chainPath = custodyChainPath(t.layout.evidenceDir);
    const chain = readChainFile(chainPath);
    expect(outcome.event.custody_last_hash).toBe(chain[chain.length - 1].content_hash);
    for (const hash of Object.values(outcome.event.artifact_hashes as Record<string, string>)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // R41: no raw context in the journal event.
    expect(outcome.event.diff).toBeUndefined();
    expect(JSON.stringify(outcome.event)).not.toContain(UNIQUE_MARKER);
    expect(JSON.stringify(outcome.event)).not.toContain("self_claim");
  });

  it("the default git diff runner diffs the worktree against its base commit (R45, A6)", async () => {
    const repo = makeGitRepo();
    // The base commit is the worktree HEAD at dispatch time (A6) — before the
    // specialist produces anything.
    const baseCommit = initialHead(repo);
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "foo.py"), "print('hi')\n", "utf8");
    fs.mkdirSync(path.join(repo, "test"), { recursive: true });
    fs.writeFileSync(path.join(repo, "test", "foo_test.py"), "def test():\n    pass\n", "utf8");
    gitAddCommit(repo, "work");

    const diff = await createGitDiffRunner()(repo, baseCommit);
    expect(diff.diff).toContain("src/foo.py");
    expect(diff.diff).toContain("test/foo_test.py");
    expect(diff.changedFiles).toEqual(expect.arrayContaining(["src/foo.py", "test/foo_test.py"]));
    expect(diff.untrackedFiles).toEqual([]);
  });
});

describe("evidence T2-T3 continuity", () => {
  it("workspace hash same at harvest and integration -> no gap (R46, U6.7)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");

    const outcome = await harvestEvidence(harvestContext(t, worktree));
    const harvestHash = outcome.harvestWorkspaceHash;
    expect(harvestHash).toMatch(/^[0-9a-f]{64}$/);

    // Just before integration the workspace is unchanged -> same hash.
    const integrationHash = workspaceHash(worktree);
    expect(integrationHash).toBe(harvestHash);

    const continuity = takeContinuityRecord(t.store, {
      unit_id: "U1",
      role: "builder",
      take: 1,
      harvestHash,
      integrationHash,
    });
    expect(continuity.continuous).toBe(true);
    expect(continuity.gap).toBeNull();
    expect(continuity.record).toMatchObject({
      type: "custody_continuity_record",
      unit_id: "U1",
      harvest_workspace_hash: harvestHash,
      integration_workspace_hash: integrationHash,
      continuous: true,
    });
    // No T2-T3 gap in the derived state.
    expect(t.store.stateSnapshot().open_gaps.some((g) => g.criterion === "t2-t3-continuity")).toBe(
      false,
    );
  });

  it("workspace hash differs between harvest and integration -> gap_recorded: T2-T3-continuity (R46, U6.7)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");

    const outcome = await harvestEvidence(harvestContext(t, worktree));
    const harvestHash = outcome.harvestWorkspaceHash;

    // The workspace was not frozen after termination: it changes before integration.
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('CHANGED')\n", "utf8");
    const integrationHash = workspaceHash(worktree);
    expect(integrationHash).not.toBe(harvestHash);

    const continuity = takeContinuityRecord(t.store, {
      unit_id: "U1",
      role: "builder",
      take: 1,
      harvestHash,
      integrationHash,
    });
    expect(continuity.continuous).toBe(false);
    expect(continuity.gap).not.toBeNull();
    expect(continuity.gap).toMatchObject({
      type: "gap_recorded",
      unit_id: "U1",
      criterion: "t2-t3-continuity",
      reason: "T2-T3-continuity",
    });
    expect(continuity.record.continuous).toBe(false);
    expect(
      t.store.stateSnapshot().open_gaps.some((g) => g.criterion === "t2-t3-continuity"),
    ).toBe(true);
  });
});

/** Create a real temp git repo; returns its initial HEAD commit. */
function makeGitRepo(): string {
  const dir = makeTempDir();
  cp.execFileSync("git", ["init", "-q", dir]);
  cp.execFileSync("git", ["-C", dir, "config", "user.email", "miah-test@example.com"]);
  cp.execFileSync("git", ["-C", dir, "config", "user.name", "Miah Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "test repo\n", "utf8");
  cp.execFileSync("git", ["-C", dir, "add", "-A"]);
  cp.execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return dir;
}

function initialHead(repo: string): string {
  return cp.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
}

function gitAddCommit(repo: string, message: string): void {
  cp.execFileSync("git", ["-C", repo, "add", "-A"]);
  cp.execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}
