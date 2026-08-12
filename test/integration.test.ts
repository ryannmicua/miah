/**
 * U7 integration self-containedness tests (R54, R53, R89; plan Test Scenarios,
 * audit U7.12/U7.13).
 *
 * R54: when the acceptance transition fires, the accepted `creates:` files are
 * copied from the specialist worktree into a checkout of the canonical worktree
 * and the verification contract commands run there. A `creates:` artifact that
 * depends on an undeclared file (an integration smuggle) makes verification fail
 * in the integrated checkout -> `gap_recorded: integration-smuggle` and the unit
 * cannot be accepted.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateUnitAcceptance,
  INTEGRATION_GAP_CRITERION,
  INTEGRATION_GAP_REASON,
  runIntegrationCheck,
} from "../src/acceptance";
import { gradeCriterion } from "../src/grading";
import type { AcceptanceCriterion, PlanUnit } from "../src/types";
import { cleanupTempDirs, createTestStore, makeTempDir, type TestStore } from "./helpers";

const CRITERION: AcceptanceCriterion = { text: "module is self-contained", tier: "deterministic" };

function unit(creates: string[]): PlanUnit {
  return {
    id: "U1",
    number: 1,
    title: "foo module",
    goal: "Create src/foo.py.",
    requirements: "R54",
    creates,
    inputs: [],
    dependsOn: [],
    acceptance: [CRITERION],
  };
}

function setupStore(creates: string[]): TestStore {
  const t = createTestStore({ holderId: "holder-A" });
  const acquired = t.store.lease.acquire("holder-A");
  if (!acquired.ok) {
    throw new Error(`lease acquire failed: ${acquired.reason}`);
  }
  fs.writeFileSync(t.layout.planSnapshotPath, "---\n", "utf8");
  fs.writeFileSync(t.layout.unitsJsonPath, `${JSON.stringify({ U1: unit(creates) }, null, 2)}\n`, "utf8");
  return t;
}

function writeSourceWorktree(entries: Record<string, string>): string {
  const root = makeTempDir();
  for (const [rel, content] of Object.entries(entries)) {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

afterEach(cleanupTempDirs);

describe("integration", () => {
  it("a creates: artifact that imports an undeclared file -> verification fails -> gap_recorded: integration-smuggle (R54, audit U7.12)", async () => {
    const t = setupStore(["src/foo.py"]);
    // The builder's worktree: foo.py imports _helper.py which the plan did NOT declare.
    const source = writeSourceWorktree({
      "src/foo.py": "import _helper\nprint(_helper.answer)\n",
      "src/_helper.py": "answer = 42\n",
    });
    const canonical = makeTempDir(); // canonical checkout at the base commit: no files yet

    const runCommand = async (command: string, cwd: string) => {
      const helperMissing = !fs.existsSync(path.join(cwd, "src", "_helper.py"));
      return {
        command,
        exit_code: helperMissing ? 1 : 0,
        stdout: helperMissing ? "" : "ok\n",
        stderr: helperMissing ? "ModuleNotFoundError: No module named '_helper'" : "",
      };
    };

    const outcome = await runIntegrationCheck({
      store: t.store,
      unit: unit(["src/foo.py"]),
      sourceWorktree: source,
      canonicalWorktree: canonical,
      verificationCommands: ["python -c 'import src.foo'"],
      runCommand,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.results[0].exit_code).toBe(1);
    // Only the declared creates: path is copied (R53/R89) — the smuggled helper is not.
    expect(outcome.copied).toEqual(["src/foo.py"]);
    expect(fs.existsSync(path.join(canonical, "src", "foo.py"))).toBe(true);
    expect(fs.existsSync(path.join(canonical, "src", "_helper.py"))).toBe(false);
    expect(outcome.gap).toMatchObject({
      type: "gap_recorded",
      unit_id: "U1",
      criterion: INTEGRATION_GAP_CRITERION,
      reason: INTEGRATION_GAP_REASON,
    });
    expect(outcome.gap?.reason).toContain("integration-smuggle");
    // The gap is open in the reconstructed state.
    const open = t.store.stateSnapshot().open_gaps.find((g) => g.criterion === INTEGRATION_GAP_CRITERION);
    expect(open).toBeDefined();
    expect(open?.reason).toContain("integration-smuggle");
  });

  it("an integration smuggle makes the composed acceptance transition record not_accepted (R54)", async () => {
    const t = setupStore(["src/foo.py"]);
    const source = writeSourceWorktree({
      "src/foo.py": "import _helper\n",
      "src/_helper.py": "answer = 42\n",
    });
    const canonical = makeTempDir();
    const runCommand = async (command: string, cwd: string) => {
      const missing = !fs.existsSync(path.join(cwd, "src", "_helper.py"));
      return { command, exit_code: missing ? 1 : 0, stdout: missing ? "" : "ok\n", stderr: missing ? "import error" : "" };
    };

    const outcome = await evaluateUnitAcceptance({
      store: t.store,
      unit: unit(["src/foo.py"]),
      records: [gradeCriterion({ criterion: CRITERION.text, tier: "deterministic", verifierVerdict: "pass" })],
      openGaps: t.store.stateSnapshot().open_gaps,
      integration: {
        store: t.store,
        unit: unit(["src/foo.py"]),
        sourceWorktree: source,
        canonicalWorktree: canonical,
        verificationCommands: ["check-self-contained"],
        runCommand,
      },
    });

    expect(outcome.verdict.decision).toBe("not_accepted");
    expect(outcome.integration?.ok).toBe(false);
    expect(outcome.applied.decisionEvent).toMatchObject({ type: "acceptance_decision", decision: "not_accepted" });
    expect(outcome.applied.escalationEvent).toBeNull();
    expect(t.store.stateSnapshot().units.U1.last_acceptance).toBe("not_accepted");
  });

  it("a self-contained unit passes the check in the canonical checkout -> accept (R54, audit U7.13)", async () => {
    const t = setupStore(["src/foo.py"]);
    const source = writeSourceWorktree({ "src/foo.py": "print('hi')\n" });
    const canonical = makeTempDir();
    const runCommand = async (command: string, cwd: string) => {
      const fooPresent = fs.existsSync(path.join(cwd, "src", "foo.py"));
      return { command, exit_code: fooPresent ? 0 : 1, stdout: fooPresent ? "ok\n" : "", stderr: fooPresent ? "" : "src/foo.py missing" };
    };

    const check = await runIntegrationCheck({
      store: t.store,
      unit: unit(["src/foo.py"]),
      sourceWorktree: source,
      canonicalWorktree: canonical,
      verificationCommands: ["npm test"],
      runCommand,
    });
    expect(check.ok).toBe(true);
    expect(check.gap).toBeNull();
    expect(check.copied).toEqual(["src/foo.py"]);
    expect(fs.existsSync(path.join(canonical, "src", "foo.py"))).toBe(true);

    const outcome = await evaluateUnitAcceptance({
      store: t.store,
      unit: unit(["src/foo.py"]),
      records: [gradeCriterion({ criterion: CRITERION.text, tier: "deterministic", verifierVerdict: "pass" })],
      openGaps: t.store.stateSnapshot().open_gaps,
      integration: {
        store: t.store,
        unit: unit(["src/foo.py"]),
        sourceWorktree: source,
        canonicalWorktree: canonical,
        verificationCommands: ["npm test"],
        runCommand,
      },
    });

    expect(outcome.verdict.decision).toBe("accept");
    expect(outcome.integration?.ok).toBe(true);
    expect(outcome.applied.decisionEvent).toMatchObject({ type: "acceptance_decision", decision: "accept" });
    expect(outcome.applied.escalationEvent).toBeNull();
    expect(t.store.stateSnapshot().units.U1.status).toBe("accepted");
    expect(t.store.stateSnapshot().open_gaps).toHaveLength(0);
  });
});
