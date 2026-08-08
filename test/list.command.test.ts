/**
 * `miah list` command tests (U9.13, R63, KTD15).
 *
 * `miah list` scans `~/.miah/runs/` and prints one line per run: run id, plan
 * title, phase, and last journal activity. Read-only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { runList } from "../src/commands/list";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { makeFakeProbe } from "./fixtures/fake-substrate-probe";

const PLAN_A = [
  "---",
  "title: List Plan Alpha",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# List Plan Alpha",
  "",
  "## Implementation Units",
  "",
  "### U1. Alpha module",
  "",
  "- **creates:** `src/alpha.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - `src/alpha.ts` exists and is exported — `tier: deterministic`",
  "",
].join("\n");

const PLAN_B = [
  "---",
  "title: List Plan Beta",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# List Plan Beta",
  "",
  "## Implementation Units",
  "",
  "### U1. Beta module",
  "",
  "- **creates:** `src/beta.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - `src/beta.ts` exists and is exported — `tier: deterministic`",
  "",
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

async function admit(basePath: string, planText: string): Promise<string> {
  const admission = await admitPlan(planText, {
    probe: makeFakeProbe(),
    config: fastConfig(),
    basePath,
    holderId: "admit-holder",
    workspacePaths: [],
  });
  if (!admission.ok || admission.run === null) {
    throw new Error(`admission failed: ${JSON.stringify(admission.failures)}`);
  }
  return admission.run.runId;
}

function capture(callback: () => number): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  const code = callback();
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("list command", () => {
  it("shows every run: run id, plan title, phase, last activity (R63)", async () => {
    const basePath = makeTempDir("miah-list-");
    const runA = await admit(basePath, PLAN_A);
    const runB = await admit(basePath, PLAN_B);

    const { code, stdout } = capture(() => runList({ basePath }));
    expect(code).toBe(0);
    expect(stdout).toContain(runA);
    expect(stdout).toContain(runB);
    expect(stdout).toContain("List Plan Alpha");
    expect(stdout).toContain("List Plan Beta");
    expect(stdout).toContain("not-started");
    expect(stdout).toContain("last activity:");
  });

  it("prints a message when the run store is empty", () => {
    const { code, stdout } = capture(() =>
      runList({ basePath: makeTempDir("miah-list-empty-") }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("no runs");
  });
});
