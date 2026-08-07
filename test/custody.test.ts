/**
 * U6 custody chain tests (R45, R85, KTD3, D8-g; plan Test Scenarios U6.5,
 * U6.6).
 *
 * U6.5  Custody chain: each header's `prev_hash` equals the previous header's
 *       `content_hash`; a header is `(role, agent_id, attempt, take,
 *       harvest_ts, content_hash, prev_hash)`.
 * U6.6  Broken custody chain (a header deleted) -> evidence gap recorded.
 *
 * The chain is a single per-run sequence (`evidence/custody-chain.json`)
 * ordered by harvest time; every harvest appends its artifact headers to it.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendToChain,
  computeArtifactHash,
  custodyChainPath,
  readChainFile,
  unitFromArtifact,
  verifyChain,
  writeChainFile,
  type CustodyHeader,
} from "../src/custody";
import { harvestEvidence, verifyCustodyChain } from "../src/evidence";
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
    diffRunner: async () => ({
      diff: "diff --git a/src/foo.py b/src/foo.py\n+print('hi')\n",
      changedFiles: ["src/foo.py"],
      untrackedFiles: [],
      commands: ["git -C worktree diff base"],
    }),
  };
}

afterEach(cleanupTempDirs);

describe("custody chain", () => {
  it("computeArtifactHash is SHA-256 (64 hex chars) and deterministic", () => {
    const hash = computeArtifactHash("payload");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeArtifactHash("payload")).toBe(hash);
    expect(computeArtifactHash("payload-other")).not.toBe(hash);
  });

  it("appendToChain chains each header's prev_hash to the previous content_hash; first prev_hash is null (R85, U6.5)", () => {
    const base = {
      role: "builder",
      agent_id: "agent-1",
      attempt: "dispatch-builder-U1-t1",
      take: 1,
      harvest_ts: 100,
    };
    const h1 = appendToChain([], { ...base, artifact: "U1/t1/builder/diff.patch", content_hash: "c1" });
    expect(h1).toHaveLength(1);
    expect(h1[0].prev_hash).toBeNull();
    const h2 = appendToChain(h1, { ...base, artifact: "U1/t1/builder/verification.json", content_hash: "c2" });
    expect(h2[1].prev_hash).toBe("c1");
    const h3 = appendToChain(h2, { ...base, artifact: "U1/t1/builder/usage-delta.json", content_hash: "c3" });
    expect(h3[2].prev_hash).toBe("c2");

    // Each header carries the full mandated tuple (R85, KTD3).
    for (const header of h3) {
      expect(typeof header.role).toBe("string");
      expect(typeof header.agent_id).toBe("string");
      expect(typeof header.attempt).toBe("string");
      expect(typeof header.take).toBe("number");
      expect(typeof header.harvest_ts).toBe("number");
      expect(typeof header.content_hash).toBe("string");
      expect(header.prev_hash === null || typeof header.prev_hash === "string").toBe(true);
      expect(typeof header.artifact).toBe("string");
    }
    expect(verifyChain(h3).ok).toBe(true);
  });

  it("a harvest appends headers for its artifacts to the persisted chain, ordered by harvest time (R85)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");

    await harvestEvidence(harvestContext(t, worktree));

    const chainPath = custodyChainPath(t.layout.evidenceDir);
    const onDisk = readChainFile(chainPath);
    // envelope is absent (R43) -> diff, verification, usage_delta, record.
    expect(onDisk.length).toBe(4);
    for (let i = 0; i < onDisk.length; i++) {
      expect(onDisk[i].prev_hash).toBe(i === 0 ? null : onDisk[i - 1].content_hash);
    }
    // Artifact paths are keyed by (unit, take, role): <unit>/<take>/<role>/<file>.
    expect(onDisk[0].artifact).toBe("U1/1/builder/diff.patch");
    expect(onDisk[3].artifact).toBe("U1/1/builder/evidence.json");
    expect(verifyChain(onDisk).ok).toBe(true);
    // unit is derivable from the artifact path.
    expect(unitFromArtifact(onDisk[0].artifact)).toBe("U1");
  });

  it("a second harvest chains onto the first (one run-wide chain, harvest-order)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");

    await harvestEvidence(harvestContext(t, worktree));
    // A second take of the same unit, same worktree.
    const second = await harvestEvidence({ ...harvestContext(t, worktree), take: 2 });

    const chainPath = custodyChainPath(t.layout.evidenceDir);
    const onDisk = readChainFile(chainPath);
    expect(onDisk.length).toBe(8);
    // The boundary between the two harvests is a valid link.
    expect(onDisk[4].prev_hash).toBe(onDisk[3].content_hash);
    expect(verifyChain(onDisk).ok).toBe(true);
    expect(second.chain).toHaveLength(8);
  });

  it("broken custody chain (header deleted) -> verifyChain detects the break -> evidence gap recorded (R45, U6.6)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "print('hi')\n", "utf8");

    await harvestEvidence(harvestContext(t, worktree));
    const chainPath = custodyChainPath(t.layout.evidenceDir);
    const onDisk = readChainFile(chainPath);
    expect(onDisk.length).toBe(4);

    // The auditor deletes a middle header: the chain link breaks.
    const tampered: CustodyHeader[] = [onDisk[0], ...onDisk.slice(2)];
    writeChainFile(chainPath, tampered);

    const verdict = verifyChain(readChainFile(chainPath));
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenLinks).toHaveLength(1);
    expect(verdict.brokenLinks[0].artifact).toBe(onDisk[2].artifact);

    // The evidence layer records the break as a gap on the affected unit.
    const result = verifyCustodyChain(t.store, readChainFile(chainPath));
    expect(result.ok).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      type: "gap_recorded",
      unit_id: "U1",
      criterion: "custody-chain",
    });
    expect(String(result.gaps[0].reason)).toContain("broken custody chain");
    const state = t.store.stateSnapshot();
    expect(state.open_gaps.some((g) => g.criterion === "custody-chain")).toBe(true);
  });

  it("an intact chain verifies with no broken links and journals no gap", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "foo.py"), "x\n", "utf8");
    await harvestEvidence(harvestContext(t, worktree));

    const chainPath = custodyChainPath(t.layout.evidenceDir);
    const result = verifyCustodyChain(t.store, readChainFile(chainPath));
    expect(result.ok).toBe(true);
    expect(result.gaps).toHaveLength(0);
    expect(t.store.stateSnapshot().open_gaps).toHaveLength(0);
  });

  it("deleting the FIRST header also breaks the chain (its successor can no longer chain to null)", () => {
    const base = {
      role: "builder",
      agent_id: "agent-1",
      attempt: "dispatch-builder-U1-t1",
      take: 1,
      harvest_ts: 100,
    };
    const chain = appendToChain(
      appendToChain([], { ...base, artifact: "a", content_hash: "c1" }),
      { ...base, artifact: "b", content_hash: "c2" },
    );
    const withoutFirst = chain.slice(1);
    const verdict = verifyChain(withoutFirst);
    expect(verdict.ok).toBe(false);
    // The new "first" header carries a non-null prev_hash, so the chain is broken.
    expect(verdict.brokenLinks[0].actualPrevHash).toBe("c1");
    expect(verdict.brokenLinks[0].expectedPrevHash).toBeNull();
  });
});
