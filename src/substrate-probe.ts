/**
 * Substrate readiness probe (R57, R86-R87, KTD4/KTD5/KTD9).
 *
 * The probe is the admission gate's honesty mechanism: it queries the live
 * Paseo substrate and reports what is actually there, never fabricating
 * "present" for an unshipped feature. Three checks (KTD4 table):
 *
 *   (a) per-agent max-duration: scan `paseo run --help` for a
 *       `--max-duration` / `--expires-at` / `--budget` flag. v0.3.0-beta.2 is
 *       ABSENT (only `--wait-timeout`, which bounds the waiter, not the agent);
 *       admission fails closed on absent (R4/R5, R86).
 *   (b) MCP injection scoping: read `~/.paseo/config.json`
 *       `daemon.mcp.injectIntoAgents`; when enabled, check for a per-agent MCP
 *       scoping flag in `paseo run --help` / `paseo agent update --help`.
 *       None exists in v0.3.0-beta.2 -> unscopable; admission fails closed
 *       (R21, R87).
 *   (c) post-termination workspace immutability: dispatch a throwaway agent to
 *       a worktree, terminate it, try to write to the worktree path, and record
 *       whether the write succeeds (immutability absent) or is blocked
 *       (present). The result is recorded honestly as a manifest caveat (R46);
 *       admission does NOT fail on immutability absence.
 *
 * The CLI runner and the config path are injectable so tests never touch the
 * real daemon; the live-probe test exercises the real implementation. The
 * throwaway immutability dispatch is the one sanctioned exception to the
 * no-dispatch test rule and is always terminated and archived promptly.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createDefaultExecutor,
  PaseoCliAdapter,
  type CliExecutor,
  type PaseoAdapter,
  type PaseoHandle,
} from "./adapter/paseo";

/** Presence verdicts used by the checks. */
export type PresenceStatus = "present" | "absent";
/** MCP scoping verdict (KTD5): scoped, unscopable, or globally disabled. */
export type McpScopingStatus = "scoped" | "unscopable" | "disabled";
/** Immutability verdict: present, absent, or honestly unverifiable. */
export type ImmutabilityStatus = "present" | "absent" | "unverifiable";

/** A verdict plus the evidence that supports it. */
export interface Verdict {
  status: string;
  evidence: string[];
}

export interface MaxDurationVerdict extends Verdict {
  status: PresenceStatus;
}

export interface McpInjectionVerdict extends Verdict {
  status: McpScopingStatus;
  global_injection_enabled: boolean;
  per_agent_scoping: boolean;
}

export interface ImmutabilityVerdict extends Verdict {
  status: ImmutabilityStatus;
}

/** Full probe report consumed by the admission gate and the manifest. */
export interface SubstrateProbeReport {
  /** `paseo --version` output, or null when the CLI is unavailable. */
  paseo_version: string | null;
  max_duration: MaxDurationVerdict;
  mcp_injection: McpInjectionVerdict;
  immutability: ImmutabilityVerdict;
  /** Non-fatal caveats for the manifest (e.g. immutability absent — R46). */
  caveats: string[];
}

/**
 * Injectable probe seam (U4). U10 substitutes `test/fixtures/fake-substrate-probe.ts`
 * (reports all checks present) so the full pipeline is E2E-testable now; the
 * real-probe fail-closed tests always use the real implementation.
 */
export interface SubstrateProbe {
  run(): Promise<SubstrateProbeReport>;
}

/** Default path of the operator's Paseo daemon config. */
export const DEFAULT_PASEO_CONFIG_PATH = () => path.join(os.homedir(), ".paseo", "config.json");

export interface PaseoSubstrateProbeOptions {
  /** CLI runner; defaults to the real `paseo` CLI on PATH. */
  exec?: CliExecutor;
  /** Paseo adapter for the throwaway immutability dispatch. */
  adapter?: PaseoAdapter;
  /** Path of `~/.paseo/config.json`; injectable for tests. */
  paseoConfigPath?: string;
  /** Provider/model for the throwaway dispatch. Without these, the
   *  immutability check is honestly reported `unverifiable` (no dispatch). */
  provider?: string;
  model?: string;
  /** Title for the throwaway agent. */
  title?: string;
  /** Working directory for the throwaway dispatch (defaults to cwd). */
  cwd?: string;
}

const FLAG_TARGETS = ["--max-duration", "--expires-at", "--budget"];
const MCP_FLAG_PATTERN = /\B--[a-z0-9-]*mcp[a-z0-9-]*/i;

function hasFlag(helpText: string, flag: string): boolean {
  return new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(helpText);
}

export class PaseoSubstrateProbe implements SubstrateProbe {
  private readonly exec: CliExecutor;
  private readonly adapter: PaseoAdapter;
  private readonly configPath: string;
  private readonly provider?: string;
  private readonly model?: string;
  private readonly title?: string;
  private readonly cwd?: string;

  constructor(options: PaseoSubstrateProbeOptions = {}) {
    this.exec = options.exec ?? createDefaultExecutor();
    this.adapter = options.adapter ?? new PaseoCliAdapter(this.exec);
    this.configPath = options.paseoConfigPath ?? DEFAULT_PASEO_CONFIG_PATH();
    this.provider = options.provider;
    this.model = options.model;
    this.title = options.title;
    this.cwd = options.cwd;
  }

  async run(): Promise<SubstrateProbeReport> {
    const max_duration = await this.checkMaxDuration();
    const mcp_injection = await this.checkMcpInjection();
    const immutability = await this.checkImmutability();
    const paseo_version = await this.readVersion();

    const caveats: string[] = [];
    if (immutability.status === "absent") {
      caveats.push(
        "post-termination-immutability-absent: a terminated agent's worktree remained writable; " +
          "the dual-hash T2-T3 continuity check is the mitigation (R46).",
      );
    } else if (immutability.status === "unverifiable") {
      caveats.push(
        "post-termination-immutability-unverifiable: the probe could not test worktree immutability " +
          "(see evidence). Recorded as a caveat, not a refusal.",
      );
    }

    return { paseo_version, max_duration, mcp_injection, immutability, caveats };
  }

  // -- (a) per-agent max-duration -------------------------------------------

  private async cliHelp(): Promise<{ text: string | null; error: string | null }> {
    try {
      const result = await this.exec(["run", "--help"]);
      return { text: result.text, error: null };
    } catch (error) {
      return { text: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async checkMaxDuration(): Promise<MaxDurationVerdict> {
    const { text, error } = await this.cliHelp();
    const evidence: string[] = [];
    if (text === null) {
      evidence.push(`paseo CLI unavailable; cannot confirm the feature: ${error}`);
      return { status: "absent", evidence };
    }
    const found = FLAG_TARGETS.filter((flag) => hasFlag(text, flag));
    if (found.length > 0) {
      evidence.push(`found per-agent duration/expiry flag(s): ${found.join(", ")}`);
      return { status: "present", evidence };
    }
    if (hasFlag(text, "--wait-timeout")) {
      evidence.push("found --wait-timeout (bounds the waiter, not the agent)");
    }
    evidence.push(
      `no --max-duration / --expires-at / --budget flag in \`paseo run --help\``,
    );
    return { status: "absent", evidence };
  }

  // -- (b) MCP injection scoping ---------------------------------------------

  private readGlobalInjection(): boolean {
    try {
      if (!fs.existsSync(this.configPath)) {
        return false;
      }
      const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as {
        daemon?: { mcp?: { injectIntoAgents?: unknown } };
      };
      return parsed?.daemon?.mcp?.injectIntoAgents === true;
    } catch {
      return false;
    }
  }

  private async perAgentScopingExists(): Promise<boolean> {
    for (const args of [["run", "--help"], ["agent", "update", "--help"]]) {
      try {
        const result = await this.exec(args);
        if (MCP_FLAG_PATTERN.test(result.text)) {
          return true;
        }
      } catch {
        // The help command failed (CLI unavailable); treat as no scoping flag.
      }
    }
    return false;
  }

  private async checkMcpInjection(): Promise<McpInjectionVerdict> {
    const globalInjection = this.readGlobalInjection();
    const evidence: string[] = [
      `daemon.mcp.injectIntoAgents=${String(globalInjection)} (${this.configPath})`,
    ];
    if (!globalInjection) {
      evidence.push("global MCP injection disabled — no scoping needed (R87)");
      return {
        status: "disabled",
        global_injection_enabled: false,
        per_agent_scoping: false,
        evidence,
      };
    }
    const scoping = await this.perAgentScopingExists();
    if (scoping) {
      evidence.push("per-agent MCP scoping flag found in the CLI");
      return {
        status: "scoped",
        global_injection_enabled: true,
        per_agent_scoping: true,
        evidence,
      };
    }
    evidence.push(
      "no per-agent MCP scoping flag in `paseo run --help` or `paseo agent update --help`",
    );
    return {
      status: "unscopable",
      global_injection_enabled: true,
      per_agent_scoping: false,
      evidence,
    };
  }

  // -- (c) post-termination immutability -------------------------------------

  private async checkImmutability(): Promise<ImmutabilityVerdict> {
    const evidence: string[] = [];
    if (this.provider === undefined) {
      evidence.push(
        "skipped: no provider/model configured for the probe's throwaway dispatch",
      );
      return { status: "unverifiable", evidence };
    }

    let handle: PaseoHandle | null = null;
    try {
      const launched = await this.adapter.launch("Reply with exactly: PROBE-OK", {
        provider: this.provider,
        model: this.model,
        title: this.title ?? "miah-substrate-probe",
        workspace: "worktree",
        worktreeMode: "branch-off",
        cwd: this.cwd,
      });
      handle = launched;
      evidence.push(`dispatched throwaway agent ${launched.agentId}`);

      let worktreePath = launched.cwd;
      if (worktreePath === null) {
        const inspected = await this.adapter.inspect(launched);
        worktreePath = inspected.cwd;
      }

      await this.adapter.stop(launched);
      evidence.push(`terminated throwaway agent ${launched.agentId}`);

      if (worktreePath === null) {
        evidence.push("could not determine the terminated agent's worktree path");
        return { status: "unverifiable", evidence };
      }
      if (!fs.existsSync(worktreePath)) {
        evidence.push(`terminated agent's worktree path does not exist: ${worktreePath}`);
        return { status: "unverifiable", evidence };
      }

      const marker = path.join(worktreePath, `.miah-immutability-${Date.now()}.tmp`);
      try {
        fs.writeFileSync(marker, "miah immutability probe", "utf8");
        fs.rmSync(marker, { force: true });
        evidence.push(`write to the terminated agent's worktree succeeded: ${worktreePath}`);
        return { status: "absent", evidence };
      } catch (writeError) {
        evidence.push(
          `write to the terminated agent's worktree was blocked: ${
            writeError instanceof Error ? writeError.message : String(writeError)
          }`,
        );
        return { status: "present", evidence };
      }
    } catch (error) {
      evidence.push(
        `immutability check could not dispatch/terminate a throwaway agent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { status: "unverifiable", evidence };
    } finally {
      if (handle !== null) {
        try {
          await this.adapter.stop(handle);
        } catch {
          // best effort
        }
        try {
          await this.exec(["agent", "archive", handle.agentId]);
        } catch {
          // best effort
        }
        if (handle.workspaceId !== null) {
          try {
            await this.exec(["workspace", "archive", handle.workspaceId]);
          } catch {
            // best effort
          }
        }
      }
    }
  }

  // -- version ---------------------------------------------------------------

  private async readVersion(): Promise<string | null> {
    try {
      const result = await this.exec(["--version"]);
      const text = result.text.trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }
}
