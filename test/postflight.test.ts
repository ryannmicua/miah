/**
 * U6 postflight assertion tests (R61, R62; plan Test Scenarios U6.8, U6.9).
 *
 * U6.8  Postflight: a unit declares `creates: ["src/foo.py"]` but the file is
 *       absent from the worktree -> `gap_recorded: missing-declared-output`.
 * U6.9  Postflight: every declared `creates:` path exists -> no gap.
 *
 * The pure assertion lives in `src/postflight.ts`; the harvest flow runs it
 * and records the gaps (F9, U6 approach step 9).
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { deliverableFiles, runPostflight } from "../src/postflight";
import { harvestEvidence } from "../src/evidence";
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

function harvestContext(t: TestStore, worktreeRoot: string) {
  return {
    store: t.store,
    unit: UNIT_U1,
    role: "builder" as const,
    take: 1,
    attempt: "dispatch-builder-U1-t1",
    agentId: "agent-1",
    worktreeRoot,
    baseCommit: "commit-base",
    envelope: null,
    verificationCommands: [],
    preDispatchUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
    postTerminationUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
    diffRunner: async () => ({ diff: "", changedFiles: [], untrackedFiles: [], commands: [] }),
  };
}

afterEach(cleanupTempDirs);

describe("postflight assertion", () => {
  it("every declared creates: path present -> no gap (R61, U6.9)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");

    const pure = runPostflight("U1", worktree, UNIT_U1.creates);
    expect(pure.ok).toBe(true);
    expect(pure.present).toEqual(["src/foo.py"]);
    expect(pure.missing).toEqual([]);

    const outcome = await harvestEvidence(harvestContext(t, worktree));
    expect(outcome.postflight.ok).toBe(true);
    expect(outcome.gaps).toHaveLength(0);
    const state = t.store.stateSnapshot();
    expect(state.open_gaps).toHaveLength(0);
  });

  it("creates: declares src/foo.py but the file is absent -> gap_recorded: missing-declared-output (R61, U6.8)", async () => {
    const t = setupStore();
    const worktree = makeTempDir(); // the specialist never produced src/foo.py

    const pure = runPostflight("U1", worktree, UNIT_U1.creates);
    expect(pure.ok).toBe(false);
    expect(pure.present).toEqual([]);
    expect(pure.missing).toEqual(["src/foo.py"]);

    const outcome = await harvestEvidence(harvestContext(t, worktree));
    expect(outcome.postflight.ok).toBe(false);
    expect(outcome.gaps).toHaveLength(1);
    expect(outcome.gaps[0]).toMatchObject({
      type: "gap_recorded",
      unit_id: "U1",
      criterion: "src/foo.py",
      reason: "missing-declared-output",
    });
    const gap = t.store.stateSnapshot().open_gaps.find((g) => g.criterion === "src/foo.py");
    expect(gap).toBeDefined();
    expect(String(gap?.reason)).toBe("missing-declared-output");
  });

  it("one missing path and one present path: only the missing path is a gap", async () => {
    const unit: PlanUnit = { ...UNIT_U1, creates: ["src/foo.py", "src/bar.py"] };
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");
    fs.writeFileSync(
      t.layout.unitsJsonPath,
      `${JSON.stringify({ U1: unit }, null, 2)}\n`,
      "utf8",
    );

    const outcome = await harvestEvidence({ ...harvestContext(t, worktree), unit });
    expect(outcome.postflight.present).toEqual(["src/foo.py"]);
    expect(outcome.postflight.missing).toEqual(["src/bar.py"]);
    expect(outcome.gaps).toHaveLength(1);
    expect(outcome.gaps[0].criterion).toBe("src/bar.py");
  });

  it("an empty creates: declaration passes (a present-but-empty field is allowed, R26)", () => {
    const worktree = makeTempDir();
    const empty = runPostflight("U2", worktree, []);
    expect(empty.ok).toBe(true);
    expect(empty.declared).toEqual([]);
    const undeclared = runPostflight("U2", worktree, null);
    expect(undeclared.ok).toBe(true);
  });

  it("deliverableFiles returns only declared creates: paths that exist (R53 integration eligibility)", () => {
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "x\n", "utf8");
    // test/foo_test.py exists in the worktree but is NOT declared in creates:.
    fs.mkdirSync(path.join(worktree, "test"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "test", "foo_test.py"), "def test(): pass\n", "utf8");

    const deliverables = deliverableFiles(worktree, ["src/foo.py"]);
    expect(deliverables).toEqual(["src/foo.py"]);
    expect(deliverables).not.toContain("test/foo_test.py");
  });
});
