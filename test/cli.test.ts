import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProgram } from "../src/index";
import { loadConfig, resolveConfigBasePath } from "../src/config";
import { DEFAULT_CONFIG } from "../src/types";
import { COMMANDS } from "../src/commands";
import pkg from "../package.json";

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
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
  }
  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miah-test-"));
}

describe("cli", () => {
  let envBackup: string | undefined;
  let realMiahConfigExisted: boolean;

  beforeAll(() => {
    envBackup = process.env.MIAH_CONFIG_HOME;
    process.env.MIAH_CONFIG_HOME = makeTempDir();
    realMiahConfigExisted = fs.existsSync(path.join(os.homedir(), ".miah", "config.json"));
  });

  afterAll(() => {
    if (envBackup === undefined) {
      delete process.env.MIAH_CONFIG_HOME;
    } else {
      process.env.MIAH_CONFIG_HOME = envBackup;
    }
    const realConfigExistedNow = fs.existsSync(path.join(os.homedir(), ".miah", "config.json"));
    expect(realConfigExistedNow).toBe(realMiahConfigExisted);
  });

  it("--version prints the package version", () => {
    const result = runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("--help lists all 10 commands", () => {
    const result = runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    for (const command of COMMANDS) {
      expect(result.stdout).toContain(command);
    }
  });

  it("preflight --help shows preflight usage", () => {
    const result = runCli(["preflight", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("preflight");
    expect(result.stdout).toContain("<plan>");
    expect(result.stdout.toLowerCase()).toContain("usage");
  });

  it("run --help shows the --once option", () => {
    const result = runCli(["run", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--once");
    expect(result.stdout).toContain("[run-id]");
  });

  describe("config", () => {
    it("creates config.json with defaults when absent", () => {
      const base = makeTempDir();
      const config = loadConfig({ configBasePath: base });
      expect(config).toEqual(DEFAULT_CONFIG);
      const written = JSON.parse(
        fs.readFileSync(path.join(base, "config.json"), "utf8"),
      ) as unknown;
      expect(written).toEqual(DEFAULT_CONFIG);
    });

    it("applies overrides from config.json on top of defaults", () => {
      const base = makeTempDir();
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(
        path.join(base, "config.json"),
        JSON.stringify({ lease: { ttl_s: 120 }, dispatch: { no_progress_polls: 5 } }),
        "utf8",
      );
      const config = loadConfig({ configBasePath: base });
      expect(config.lease.ttl_s).toBe(120);
      expect(config.dispatch.no_progress_polls).toBe(5);
      expect(config.journal.snapshot_cadence).toBe(DEFAULT_CONFIG.journal.snapshot_cadence);
      expect(config.dispatch.max_duration).toBe(DEFAULT_CONFIG.dispatch.max_duration);
      expect(config.run.max_takes).toBe(DEFAULT_CONFIG.run.max_takes);
    });

    it("honors the MIAH_CONFIG_HOME env var as the injectable base path", () => {
      const base = makeTempDir();
      process.env.MIAH_CONFIG_HOME = base;
      try {
        expect(resolveConfigBasePath()).toBe(base);
        const config = loadConfig();
        expect(config).toEqual(DEFAULT_CONFIG);
        expect(fs.existsSync(path.join(base, "config.json"))).toBe(true);
      } finally {
        process.env.MIAH_CONFIG_HOME = envBackup as string;
      }
    });
  });
});
