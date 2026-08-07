/**
 * Commander wiring tests for the U9 commands (R63).
 *
 * These go through `createProgram().parse(...)` exactly as the real CLI does,
 * so they catch wiring regressions (e.g. an action body that is constructed
 * but never invoked) that direct-function tests would miss.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { readStopRequested } from "../src/driver";
import { createProgram } from "../src/index";
import { RunStore } from "../src/run-store";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { makeFakeProbe } from "./fixtures/fake-substrate-probe";

const PLAN = [
  "---",
  "title: Wiring Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Wiring Test Plan",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **creates:** `src/a.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - `src/a.ts` exists and is exported — `tier: deterministic`",
  "",
].join("\n");

afterEach(cleanupTempDirs);

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Parse CLI args through the real program, capturing output (cli.test.ts style). */
function runCli(args: string[]): CliResult {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const consoleLogs: string[] = [];
  const consoleErrors: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts) => consoleLogs.push(parts.join(" ")));
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts) => consoleErrors.push(parts.join(" ")));
  const program = createProgram();
  program.configureOutput({
    writeOut: (chunk) => stdoutChunks.push(String(chunk)),
    writeErr: (chunk) => stderrChunks.push(String(chunk)),
  });
  program.exitOverride();
  for (const subcommand of program.commands) {
    subcommand.exitOverride();
  }
  let exitCode = 0;
  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("commander.")) {
      const exitValue = (error as { exitCode?: number }).exitCode;
      exitCode = exitValue === undefined ? 1 : exitValue;
    } else {
      throw error;
    }
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  // Command bodies set process.exitCode (the real CLI's exit mechanism).
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    exitCode = process.exitCode;
    process.exitCode = 0;
  }
  return {
    stdout: stdoutChunks.join("") + consoleLogs.join("\n"),
    stderr: stderrChunks.join("") + consoleErrors.join("\n"),
    exitCode,
  };
}

describe("command wiring", () => {
  it("status, list, and stop are wired through the CLI program (R63)", async () => {
    const basePath = makeTempDir("miah-wiring-");
    const config = fastConfig();
    const holderId = "admit-holder";
    const admission = await admitPlan(PLAN, {
      probe: makeFakeProbe(),
      config,
      basePath,
      holderId,
      workspacePaths: [],
    });
    if (!admission.ok || admission.run === null) {
      throw new Error(`admission failed: ${JSON.stringify(admission.failures)}`);
    }
    const runId = admission.run.runId;

    // Point the CLI at the test run store (same seam cli.test.ts uses).
    const envBackup = process.env.MIAH_CONFIG_HOME;
    process.env.MIAH_CONFIG_HOME = basePath;
    try {
      // status renders the run through the real CLI.
      const status = runCli(["status", runId]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(`run id: ${runId}`);
      expect(status.stdout).toContain("Wiring Test Plan");

      // list shows the run through the real CLI.
      const list = runCli(["list"]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain(runId);
    } finally {
      if (envBackup === undefined) {
        delete process.env.MIAH_CONFIG_HOME;
      } else {
        process.env.MIAH_CONFIG_HOME = envBackup;
      }
    }

    // Release the admission lease so stop can journal, then stop through the CLI.
    const store = new RunStore({ basePath, runId, config, holderId });
    store.lease.release(holderId);
    process.env.MIAH_CONFIG_HOME = basePath;
    const stop = runCli(["stop", runId]);
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain("stop requested");
    expect(readStopRequested(store.layout)).toBe(true);
    delete process.env.MIAH_CONFIG_HOME;
  });

  it("a missing run surfaces a non-zero exit through the CLI", async () => {
    process.env.MIAH_CONFIG_HOME = makeTempDir("miah-wiring-empty-");
    const result = runCli(["status", "run-missing"]);
    delete process.env.MIAH_CONFIG_HOME;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no manifest");
  });
});
