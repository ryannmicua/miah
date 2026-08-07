/**
 * U4 substrate-probe tests. Most run against injected fake CLI executor and
 * fake adapter (no real dispatch). The `substrate probe (live)` suite runs the
 * REAL probe against the live Paseo daemon — the one sanctioned throwaway
 * dispatch — and asserts whatever the daemon honestly reports.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaseoSubstrateProbe,
  type SubstrateProbeReport,
} from "../src/substrate-probe";
import {
  PaseoCliUnavailableError,
  resolveCliInvocation,
  type CliExecutor,
  type PaseoAdapter,
  type PaseoHandle,
} from "../src/adapter/paseo";

const tempDirs: string[] = [];

function makeTempDir(prefix = "miah-probe-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const HELP_NO_DURATION = `Usage: paseo run [options] <prompt>

Options:
  -d, --background                  Run in background
  --provider <provider>             Agent provider, or provider/model
  --model <model>                   Model to use
  --wait-timeout <duration>         Maximum time to wait for agent to finish
  --json                            Output in JSON format
  -h, --help                        display help for command`;

const HELP_WITH_DURATION = HELP_NO_DURATION + "\n  --max-duration <duration>       Per-agent max duration";

const HELP_NO_MCP = `Usage: paseo agent update [options] <id>

Options:
  --name <name>    Update the agent's display name
  --json           Output in JSON format
  -h, --help       display help for command`;

const HELP_WITH_MCP = HELP_NO_MCP + "\n  --mcp-disable    Disable MCP injection for this agent";

interface FakeResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function fakeExecutor(handler: (args: string[]) => FakeResponse): CliExecutor {
  return async (args) => {
    const response = handler(args);
    const stdout = response.stdout ?? "";
    const stderr = response.stderr ?? "";
    return { code: response.exitCode ?? 0, stdout, stderr, text: `${stdout}${stderr}` };
  };
}

function helpExecutor(options: {
  runHelp?: string;
  agentUpdateHelp?: string;
  version?: string;
  unavailable?: boolean;
} = {}): CliExecutor {
  return fakeExecutor((args) => {
    if (options.unavailable) {
      throw new PaseoCliUnavailableError("paseo CLI failed to spawn: spawn ENOENT");
    }
    if (args[0] === "--version") {
      return { stdout: options.version ?? "0.3.0-beta.2\n" };
    }
    if (args[0] === "run" && args[1] === "--help") {
      return { stdout: options.runHelp ?? HELP_NO_DURATION };
    }
    if (args[0] === "agent" && args[1] === "update" && args[2] === "--help") {
      return { stdout: options.agentUpdateHelp ?? HELP_NO_MCP };
    }
    return { stdout: "" };
  });
}

function writePaseoConfig(dir: string, injectIntoAgents: boolean): string {
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ version: 1, daemon: { mcp: { injectIntoAgents } } }),
    "utf8",
  );
  return configPath;
}

function fakeAdapter(opts: {
  launchError?: Error;
  worktreePath?: string | null;
  stopError?: Error;
}): { adapter: PaseoAdapter; stopped: string[]; launched: string[] } {
  const stopped: string[] = [];
  const launched: string[] = [];
  const adapter: PaseoAdapter = {
    async launch(prompt, launchOpts): Promise<PaseoHandle> {
      launched.push(launchOpts.title ?? "");
      if (opts.launchError !== undefined) {
        throw opts.launchError;
      }
      return { agentId: "throwaway-1", cwd: opts.worktreePath ?? null, workspaceId: "wks_probe" };
    },
    async status(): Promise<string> {
      return "idle";
    },
    async inspect(): Promise<never> {
      throw new Error("not used");
    },
    async stop(handle: PaseoHandle): Promise<void> {
      stopped.push(handle.agentId);
      if (opts.stopError !== undefined) {
        throw opts.stopError;
      }
    },
    async cancel(): Promise<void> {
      throw new Error("not used");
    },
  };
  return { adapter, stopped, launched };
}

async function reportFor(opts: {
  configDir?: string;
  configInject?: boolean;
  runHelp?: string;
  agentUpdateHelp?: string;
  adapter?: PaseoAdapter;
  provider?: string;
  worktreePath?: string | null;
  version?: string;
}): Promise<SubstrateProbeReport> {
  const configDir = opts.configDir ?? makeTempDir();
  const configPath = writePaseoConfig(configDir, opts.configInject ?? true);
  const probe = new PaseoSubstrateProbe({
    exec: helpExecutor({
      runHelp: opts.runHelp,
      agentUpdateHelp: opts.agentUpdateHelp,
      version: opts.version,
    }),
    adapter: opts.adapter ?? fakeAdapter({ worktreePath: opts.worktreePath ?? null }).adapter,
    paseoConfigPath: configPath,
    provider: opts.provider,
    model: "opencode-go/deepseek-v4-flash",
    cwd: makeTempDir(),
  });
  return probe.run();
}

describe("substrate probe: max-duration", () => {
  it("reports absent with --wait-timeout evidence when no duration flag exists (live v0.3.0-beta.2 shape)", async () => {
    const report = await reportFor({});
    expect(report.max_duration.status).toBe("absent");
    expect(report.max_duration.evidence.join(" ")).toContain("--wait-timeout");
    expect(report.max_duration.evidence.join(" ")).toContain("no --max-duration");
  });

  it("reports present when a --max-duration flag exists", async () => {
    const report = await reportFor({ runHelp: HELP_WITH_DURATION });
    expect(report.max_duration.status).toBe("present");
    expect(report.max_duration.evidence.join(" ")).toContain("--max-duration");
  });

  it("reports present when an --expires-at flag exists", async () => {
    const runHelp = HELP_NO_DURATION + "\n  --expires-at <time>   Per-agent expiry";
    const report = await reportFor({ runHelp });
    expect(report.max_duration.status).toBe("present");
  });

  it("reports absent when the CLI is unavailable (cannot confirm presence -> fail closed)", async () => {
    const probe = new PaseoSubstrateProbe({
      exec: helpExecutor({ unavailable: true }),
      adapter: fakeAdapter({}).adapter,
      paseoConfigPath: path.join(makeTempDir(), "config.json"),
      provider: "opencode",
      cwd: makeTempDir(),
    });
    const unavailableReport = await probe.run();
    expect(unavailableReport.max_duration.status).toBe("absent");
    expect(unavailableReport.max_duration.evidence.join(" ")).toContain("paseo CLI unavailable");
    expect(unavailableReport.paseo_version).toBeNull();
  });
});

describe("substrate probe: mcp injection scoping", () => {
  it("reports unscopable when global injection is on and no per-agent flag exists (live v0.3.0-beta.2)", async () => {
    const report = await reportFor({ configInject: true });
    expect(report.mcp_injection.status).toBe("unscopable");
    expect(report.mcp_injection.global_injection_enabled).toBe(true);
    expect(report.mcp_injection.per_agent_scoping).toBe(false);
  });

  it("reports disabled when injectIntoAgents is false", async () => {
    const report = await reportFor({ configInject: false });
    expect(report.mcp_injection.status).toBe("disabled");
    expect(report.mcp_injection.global_injection_enabled).toBe(false);
  });

  it("reports scoped when a per-agent MCP flag exists", async () => {
    const report = await reportFor({ agentUpdateHelp: HELP_WITH_MCP });
    expect(report.mcp_injection.status).toBe("scoped");
    expect(report.mcp_injection.per_agent_scoping).toBe(true);
  });

  it("reports disabled when the config file is absent", async () => {
    const probe = new PaseoSubstrateProbe({
      exec: helpExecutor(),
      adapter: fakeAdapter({}).adapter,
      paseoConfigPath: path.join(makeTempDir(), "missing", "config.json"),
      provider: "opencode",
      cwd: makeTempDir(),
    });
    const report = await probe.run();
    expect(report.mcp_injection.status).toBe("disabled");
  });
});

describe("substrate probe: post-termination immutability", () => {
  it("records absent when a write to the terminated agent's worktree succeeds", async () => {
    const worktreePath = makeTempDir("miah-wt-");
    const { adapter, stopped } = fakeAdapter({ worktreePath });
    const report = await reportFor({ adapter, provider: "opencode", worktreePath });
    expect(report.immutability.status).toBe("absent");
    expect(report.immutability.evidence.join(" ")).toContain("succeeded");
    expect(report.caveats.join(" ")).toContain("post-termination-immutability-absent");
    expect(stopped).toContain("throwaway-1");
  });

  it("records present when the write is blocked", async () => {
    // Point the worktree at an existing FILE; writing under it throws ENOTDIR.
    const blocker = path.join(makeTempDir(), "a-file.txt");
    fs.writeFileSync(blocker, "x");
    const { adapter } = fakeAdapter({ worktreePath: blocker });
    const report = await reportFor({ adapter, provider: "opencode", worktreePath: blocker });
    expect(report.immutability.status).toBe("present");
    expect(report.immutability.evidence.join(" ")).toContain("blocked");
    expect(report.caveats).toEqual([]);
  });

  it("records unverifiable when the throwaway dispatch fails", async () => {
    const { adapter } = fakeAdapter({ launchError: new PaseoCliUnavailableError("daemon unreachable") });
    const report = await reportFor({ adapter, provider: "opencode" });
    expect(report.immutability.status).toBe("unverifiable");
    expect(report.caveats.join(" ")).toContain("unverifiable");
  });

  it("records unverifiable (no dispatch) when no provider is configured", async () => {
    const { adapter } = fakeAdapter({ worktreePath: makeTempDir() });
    const probe = new PaseoSubstrateProbe({
      exec: helpExecutor(),
      adapter,
      paseoConfigPath: path.join(makeTempDir(), "config.json"),
      cwd: makeTempDir(),
    });
    const report = await probe.run();
    expect(report.immutability.status).toBe("unverifiable");
    expect(report.immutability.evidence.join(" ")).toContain("no provider/model configured");
  });

  it("never fabricates present: absent/unverifiable never coerce to present", async () => {
    const worktreePath = makeTempDir("miah-wt-");
    const { adapter } = fakeAdapter({ worktreePath });
    const report = await reportFor({ adapter, provider: "opencode", worktreePath });
    expect(["present", "absent", "unverifiable"]).toContain(report.immutability.status);
  });
});

describe("substrate probe (live daemon)", () => {
  it.runIf(cliAvailable())(
    "reports honestly against the live paseo CLI: max-duration absent, MCP per config, immutability recorded",
    async () => {
      const repo = makeTempDir("miah-probe-repo-");
      const seed = path.join(repo, "seed.txt");
      fs.writeFileSync(seed, "seed");
      git(repo, "init", "-b", "main");
      git(repo, "config", "user.email", "probe@local");
      git(repo, "config", "user.name", "probe");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "seed");

      const probe = new PaseoSubstrateProbe({
        provider: "opencode",
        model: "opencode-go/deepseek-v4-flash",
        title: "miah-u4-probe-live",
        cwd: repo,
      });
      const report = await probe.run();

      // (a) Honest max-duration: the live CLI v0.3.0-beta.2 has no flag.
      expect(report.max_duration.status).toBe("absent");
      expect(report.max_duration.evidence.join(" ")).toContain("no --max-duration");

      // (b) Honest MCP verdict per the live daemon config.
      const realConfigPath = path.join(os.homedir(), ".paseo", "config.json");
      const globalInjection =
        fs.existsSync(realConfigPath)
          ? (() => {
              try {
                const parsed = JSON.parse(fs.readFileSync(realConfigPath, "utf8")) as {
                  daemon?: { mcp?: { injectIntoAgents?: unknown } };
                };
                return parsed?.daemon?.mcp?.injectIntoAgents === true;
              } catch {
                return false;
              }
            })()
          : false;
      if (globalInjection) {
        expect(report.mcp_injection.status).toBe("unscopable");
        expect(report.mcp_injection.global_injection_enabled).toBe(true);
        expect(report.mcp_injection.per_agent_scoping).toBe(false);
      } else {
        expect(report.mcp_injection.status).toBe("disabled");
      }

      // (c) Immutability: recorded whatever the live daemon provides.
      expect(["present", "absent", "unverifiable"]).toContain(report.immutability.status);
      if (report.immutability.status === "absent") {
        expect(report.caveats.join(" ")).toContain("post-termination-immutability-absent");
      }
    },
    90_000,
  );

  it.skipIf(cliAvailable())(
    "reports the honest absent/unavailable path when the paseo CLI is not available",
    async () => {
      const probe = new PaseoSubstrateProbe({ cwd: makeTempDir() });
      const report = await probe.run();
      expect(report.max_duration.status).toBe("absent");
      expect(report.immutability.status).toBe("unverifiable");
    },
  );
});

function cliAvailable(): boolean {
  try {
    resolveCliInvocation();
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
