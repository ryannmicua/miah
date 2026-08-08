/**
 * U10 E2E — substrate fail-closed admission (R57, R86; U10.4).
 *
 * `miah start` is run against the LIVE Paseo daemon with the REAL substrate
 * probe — never the fake (U10.11). The live daemon (v0.3.0-beta.2) has no
 * per-agent `max-duration` flag, so the probe honestly reports the mechanism
 * absent and admission fails closed: the run is refused, the refusal message
 * names the missing mechanism, and NO journal / run store is created (the lease
 * is never acquired, R57).
 *
 * This test makes no agent dispatches: the default real probe records the
 * immutability check as honestly unverifiable (no throwaway provider/model
 * configured), which is a caveat, not a refusal — the max-duration absence is
 * the refusal.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStart } from "../../src/commands/start";
import { PaseoSubstrateProbe } from "../../src/substrate-probe";
import {
  createFixtureRepo,
  e2eConfig,
  paseoCliAvailable,
  TEST_PLAN,
} from "./helpers/e2e-harness";

const tempDirs: string[] = [];
const fixtureRepos: Array<{ repoRoot: string; cleanup: () => void }> = [];

function makeBasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miah-sfc-base-"));
  tempDirs.push(dir);
  return dir;
}

function makeFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repo = createFixtureRepo();
  fixtureRepos.push(repo);
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  while (fixtureRepos.length > 0) {
    const repo = fixtureRepos.pop() as { cleanup: () => void };
    try {
      repo.cleanup();
    } catch {
      // best effort
    }
  }
});

describe("e2e substrate fail-closed", () => {
  it.runIf(paseoCliAvailable())(
    "miah start against the live daemon with the REAL probe: max-duration absent -> admission refused -> no journal created",
    async () => {
      const basePath = makeBasePath();
      const config = e2eConfig();
      const repo = makeFixtureRepo();

      const stdout: string[] = [];
      const stderr: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
      vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));

      // The REAL probe (new PaseoSubstrateProbe()) — the fake is never used here.
      const code = await runStart(TEST_PLAN, {
        probe: new PaseoSubstrateProbe(),
        basePath,
        config,
        workspaceRoot: repo.repoRoot,
      });

      // Admission refused.
      expect(code).not.toBe(0);
      const output = stdout.join("\n") + stderr.join("\n");
      expect(output).toContain("admission: FAIL");
      expect(output).toContain("[max-duration-absent]");
      // The message names the missing mechanism and the fail-closed stance.
      expect(output).toContain("max-duration");
      expect(output).toContain("ABSENT");
      expect(output).toContain("fails closed");
      // Honest evidence from the live CLI (R86): no --max-duration flag exists.
      expect(output).toContain("no --max-duration");

      // Fail closed BEFORE any run store exists: no journal, no lease, no run.
      expect(fs.existsSync(path.join(basePath, "runs"))).toBe(false);
      expect(
        fs.readdirSync(basePath).filter((entry) => !entry.toLowerCase().startsWith("config")),
      ).toEqual([]);
    },
    120_000,
  );

  it.skipIf(paseoCliAvailable())(
    "when the paseo CLI is unavailable the probe still fails closed (max-duration absent), and no journal is created",
    async () => {
      const basePath = makeBasePath();
      const config = e2eConfig();
      const repo = makeFixtureRepo();

      const stdout: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));

      const code = await runStart(TEST_PLAN, {
        probe: new PaseoSubstrateProbe(),
        basePath,
        config,
        workspaceRoot: repo.repoRoot,
      });
      expect(code).not.toBe(0);
      expect(stdout.join("\n")).toContain("[max-duration-absent]");
      expect(fs.existsSync(path.join(basePath, "runs"))).toBe(false);
    },
    120_000,
  );
});
