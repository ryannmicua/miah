/**
 * Paseo lifecycle adapter (D2-a, U4).
 *
 * Implements the 5-capability contract over the `paseo` CLI:
 *
 *   launch(prompt, opts) -> PaseoHandle   via `paseo run --background --json ...`
 *   status(handle)       -> lifecycle     via `paseo inspect --json <id>`
 *   inspect(handle)      -> {provider, model, usage, mode, capabilities}
 *   stop(handle)         via `paseo agent stop <id>`
 *   cancel(handle)       via `paseo agent stop <id>` (v0.3.0-beta.2 has no
 *                        finer-grained cancel primitive; both use the CLI's
 *                        interrupt mechanism)
 *
 * Every call goes through `child_process.execFile`. On Windows the npm `.cmd`
 * shim (e.g. `paseo.cmd`) cannot be spawned directly by execFile, so the shim
 * is resolved to its node entry and spawned as `node <script> <args>` — still
 * execFile, no shell, no injection surface. On POSIX the resolved PATH entry
 * is spawned directly.
 *
 * JSON outputs are parsed defensively: the CLI interleaves human text, tips,
 * and ANSI color codes with its machine-readable JSON. `extractJsonObject`
 * tolerates all of that and returns the first complete JSON object.
 *
 * When the `paseo` CLI is unavailable (not on PATH, or the daemon cannot be
 * reached), calls throw a typed error rather than fabricating a result.
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Thrown when the paseo CLI exits non-zero or returns an error object. */
export class PaseoCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly output: string,
  ) {
    super(message);
    this.name = "PaseoCliError";
  }
}

/** Thrown when the paseo CLI cannot be found or spawned at all. */
export class PaseoCliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaseoCliUnavailableError";
  }
}

/** The agent identity returned by `paseo run --background --json`. */
export interface PaseoHandle {
  /** Stable agent id returned by the CLI. */
  agentId: string;
  /** Working directory / worktree path reported at launch, when known. */
  cwd: string | null;
  /** Workspace id parsed from the launch output, when present. */
  workspaceId: string | null;
}

/** Usage telemetry from `paseo inspect --json` (PascalCase `LastUsage`). */
export interface PaseoUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
}

/** `paseo inspect --json` mapped onto the adapter contract. */
export interface PaseoInspectResult {
  agentId: string;
  lifecycle: string;
  provider: string | null;
  model: string | null;
  mode: string | null;
  cwd: string | null;
  usage: PaseoUsage;
  capabilities: Record<string, unknown>;
}

export interface PaseoLaunchOptions {
  /** Provider name (e.g. `opencode`). Required by the live CLI. */
  provider: string;
  /** Model id (e.g. `opencode-go/deepseek-v4-flash`). */
  model?: string;
  title?: string;
  /** Defaults to `worktree` per the U4 dispatch contract. */
  workspace?: "worktree" | "local";
  /** Defaults to `branch-off`. */
  worktreeMode?: string;
  baseRef?: string;
  mode?: string;
  /** Extra `--env <key=value>` entries (added, never scrubbed — R88). */
  env?: Record<string, string>;
  /** Working directory for the run (`--cwd`). */
  cwd?: string;
}

/** The 5-capability lifecycle contract (D2-a). */
export interface PaseoAdapter {
  launch(prompt: string, opts: PaseoLaunchOptions): Promise<PaseoHandle>;
  status(handle: PaseoHandle): Promise<string>;
  inspect(handle: PaseoHandle): Promise<PaseoInspectResult>;
  stop(handle: PaseoHandle): Promise<void>;
  cancel(handle: PaseoHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// CLI resolution and execution
// ---------------------------------------------------------------------------

/** Result of one `paseo` CLI invocation (success or non-zero exit). */
export interface CliResult {
  /** Process exit code; 0 on success. */
  code: number;
  stdout: string;
  stderr: string;
  /** Combined stdout + stderr for defensive JSON extraction. */
  text: string;
}

/** Injectable `child_process.execFile` so tests never touch the real daemon. */
export type ExecFileFn = (
  file: string,
  args: string[],
  options: cp.ExecFileOptions,
  callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void,
) => cp.ChildProcess;

/** The CLI runner the adapter and probe share. Resolves with non-zero exits. */
export interface CliExecutor {
  (args: string[], opts?: { cwd?: string }): Promise<CliResult>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Search PATH for `name` (plus platform extensions on Windows). */
function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  const isWin = process.platform === "win32";
  const extensions = isWin ? [".cmd", ".exe", ""] : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, ext === "" ? name : `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // not this candidate
      }
    }
  }
  return null;
}

/**
 * Resolve the node script behind an npm-style `.cmd` shim. The shim runs
 * `node ... "<script>" %*`; we read the file and take the last quoted path on
 * the line that carries `%*`, expanding `%dp0%`/`%~dp0%` to the shim's dir.
 */
function parseCmdShimTarget(cmdPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const dp0 = path.dirname(cmdPath) + path.sep;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("%*")) {
      continue;
    }
    const quoted = line.match(/"[^"]*"/g);
    if (quoted === null || quoted.length === 0) {
      continue;
    }
    const last = quoted[quoted.length - 1].slice(1, -1);
    if (last.length === 0) {
      continue;
    }
    return last.replace(/%dp0%/gi, dp0).replace(/%~dp0%/gi, dp0);
  }
  return null;
}

/** How the CLI is invoked: an executable file, or node with a script prefix. */
export interface CliInvocation {
  file: string;
  argsPrefix: string[];
}

let cachedInvocation: CliInvocation | null = null;

/** Resolve the paseo CLI entry from PATH (cached). Throws when unavailable. */
export function resolveCliInvocation(): CliInvocation {
  if (cachedInvocation !== null) {
    return cachedInvocation;
  }
  const found = findOnPath("paseo");
  if (found === null) {
    throw new PaseoCliUnavailableError("paseo CLI not found on PATH");
  }
  if (process.platform === "win32" && found.toLowerCase().endsWith(".cmd")) {
    const script = parseCmdShimTarget(found);
    if (script === null) {
      throw new PaseoCliUnavailableError(
        `could not resolve the node script behind the paseo shim at ${found}`,
      );
    }
    cachedInvocation = { file: process.execPath, argsPrefix: [script] };
  } else {
    cachedInvocation = { file: found, argsPrefix: [] };
  }
  return cachedInvocation;
}

/** Reset the cached CLI invocation (test helper). */
export function resetCliInvocationCache(): void {
  cachedInvocation = null;
}

/**
 * Default `child_process.execFile` binding, pinned to the string-encoding
 * overload so stdout/stderr are always `string` regardless of the caller's
 * options (the CLI output is text; JSON extraction happens on the combined
 * text).
 */
function defaultExecFile(
  file: string,
  args: string[],
  options: cp.ExecFileOptions,
  callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void,
): cp.ChildProcess {
  return cp.execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    callback(error, String(stdout), String(stderr));
  });
}

/**
 * Default executor: `child_process.execFile` on the resolved CLI entry. A
 * non-zero exit resolves with `code` (the caller parses JSON defensively); a
 * spawn-level failure (ENOENT etc.) rejects with `PaseoCliUnavailableError`.
 */
export function createDefaultExecutor(execFileImpl?: ExecFileFn): CliExecutor {
  const exec: ExecFileFn = execFileImpl ?? defaultExecFile;
  return (args, opts = {}) =>
    new Promise<CliResult>((resolve, reject) => {
      let invocation: CliInvocation;
      try {
        invocation = resolveCliInvocation();
      } catch (error) {
        reject(error);
        return;
      }
      const fullArgs = [...invocation.argsPrefix, ...args];
      exec(
        invocation.file,
        fullArgs,
        { cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error !== null) {
            if (typeof error.code === "number") {
              resolve({ code: error.code, stdout, stderr, text: `${stdout}${stderr}` });
              return;
            }
            reject(new PaseoCliUnavailableError(`paseo CLI failed to spawn: ${error.message}`));
            return;
          }
          resolve({ code: 0, stdout, stderr, text: `${stdout}${stderr}` });
        },
      );
    });
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing
// ---------------------------------------------------------------------------

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Remove ANSI escape sequences (the CLI colorizes stderr even for JSON). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Extract the first complete JSON object from CLI output. Handles: plain JSON,
 * ANSI-colored JSON, human lines before the JSON, and JSON whose string values
 * contain braces (via a string-aware brace scan).
 */
export function extractJsonObject(text: string): unknown {
  const whole = stripAnsi(text).trim();
  if (whole.length === 0) {
    return null;
  }
  const tryParse = (value: string): unknown | null => {
    try {
      const parsed: unknown = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(whole);
  if (direct !== null) {
    return direct;
  }

  for (const line of whole.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = tryParse(trimmed);
    if (parsed !== null) {
      return parsed;
    }
  }

  const start = whole.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < whole.length; i++) {
    const ch = whole[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = whole.slice(start, i + 1);
        const parsed = tryParse(candidate);
        if (parsed !== null) {
          return parsed;
        }
        break;
      }
    }
  }
  return null;
}

/** Parse the CLI's `{"error": {code, message}}` shape; null when not an error. */
export interface CliErrorInfo {
  code: string;
  message: string;
}

export function parseCliError(json: unknown): CliErrorInfo | null {
  if (!isPlainObject(json)) {
    return null;
  }
  const err = json.error;
  if (!isPlainObject(err)) {
    return null;
  }
  const code = typeof err.code === "string" ? err.code : null;
  const message = typeof err.message === "string" ? err.message : null;
  if (code === null && message === null) {
    return null;
  }
  return { code: code ?? "ERROR", message: message ?? "" };
}

/** Best-effort parse of the `Created workspace wks_...` launch log line. */
function extractWorkspaceId(text: string): string | null {
  const match = stripAnsi(text).match(/Created workspace (wks_[0-9a-f]+)/i);
  return match === null ? null : match[1];
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function requireJsonObject(result: CliResult, label: string): unknown {
  const json = extractJsonObject(result.text);
  if (json === null) {
    throw new PaseoCliError(`${label} returned no machine-readable JSON`, result.code, result.text);
  }
  return json;
}

function assertNoCliError(json: unknown, label: string, result: CliResult): void {
  const err = parseCliError(json);
  if (err !== null) {
    throw new PaseoCliError(`${label} failed: ${err.code}: ${err.message}`, result.code, result.text);
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class PaseoCliAdapter implements PaseoAdapter {
  constructor(private readonly exec: CliExecutor = createDefaultExecutor()) {}

  /**
   * Launch a background agent via `paseo run --background --json`. The command
   * shape matches the U4 dispatch contract:
   *   paseo run --background --json --provider <p> --model <m>
   *           --new-workspace worktree --worktree-mode branch-off
   *           [--title <t>] [--env <k=v>] ... <prompt>
   */
  async launch(prompt: string, opts: PaseoLaunchOptions): Promise<PaseoHandle> {
    const args: string[] = ["run", "--background", "--json"];
    args.push("--provider", opts.provider);
    if (opts.model !== undefined) {
      args.push("--model", opts.model);
    }
    if (opts.title !== undefined) {
      args.push("--title", opts.title);
    }
    args.push("--new-workspace", opts.workspace ?? "worktree");
    args.push("--worktree-mode", opts.worktreeMode ?? "branch-off");
    if (opts.baseRef !== undefined) {
      args.push("--base", opts.baseRef);
    }
    if (opts.mode !== undefined) {
      args.push("--mode", opts.mode);
    }
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    if (opts.cwd !== undefined) {
      args.push("--cwd", opts.cwd);
    }
    args.push(prompt);

    const result = await this.exec(args, { cwd: opts.cwd });
    const json = requireJsonObject(result, "paseo run");
    assertNoCliError(json, "paseo run", result);
    const obj = json as Record<string, unknown>;
    const agentId = stringField(obj.agentId);
    if (agentId === null) {
      throw new PaseoCliError("paseo run JSON is missing agentId", result.code, result.text);
    }
    return {
      agentId,
      cwd: stringField(obj.cwd),
      workspaceId: extractWorkspaceId(result.text),
    };
  }

  /** Lifecycle via `paseo inspect --json <id>` (the inspect `Status` field). */
  async status(handle: PaseoHandle): Promise<string> {
    const result = await this.exec(["inspect", "--json", handle.agentId]);
    const json = requireJsonObject(result, "paseo inspect");
    assertNoCliError(json, "paseo inspect", result);
    const status = stringField((json as Record<string, unknown>).Status);
    if (status === null) {
      throw new PaseoCliError("paseo inspect JSON is missing Status", result.code, result.text);
    }
    return status;
  }

  /** Full `paseo inspect --json <id>` mapped onto the adapter contract. */
  async inspect(handle: PaseoHandle): Promise<PaseoInspectResult> {
    const result = await this.exec(["inspect", "--json", handle.agentId]);
    const json = requireJsonObject(result, "paseo inspect");
    assertNoCliError(json, "paseo inspect", result);
    const obj = json as Record<string, unknown>;
    const usageRaw = isPlainObject(obj.LastUsage) ? obj.LastUsage : {};
    return {
      agentId: stringField(obj.Id) ?? handle.agentId,
      lifecycle: stringField(obj.Status) ?? "unknown",
      provider: stringField(obj.Provider),
      model: stringField(obj.Model),
      mode: stringField(obj.Mode),
      cwd: stringField(obj.Cwd),
      usage: {
        inputTokens: numberField(usageRaw.InputTokens),
        outputTokens: numberField(usageRaw.OutputTokens),
        cachedTokens: numberField(usageRaw.CachedTokens),
        costUsd: numberField(usageRaw.CostUsd),
      },
      capabilities: isPlainObject(obj.Capabilities) ? obj.Capabilities : {},
    };
  }

  /** Terminate via `paseo agent stop <id>`. */
  async stop(handle: PaseoHandle): Promise<void> {
    await this.stopOrCancel(handle);
  }

  /**
   * Cancel via `paseo agent stop <id>`. v0.3.0-beta.2 exposes no separate
   * cancel primitive, so both stop and cancel use the CLI's interrupt command.
   */
  async cancel(handle: PaseoHandle): Promise<void> {
    await this.stopOrCancel(handle);
  }

  private async stopOrCancel(handle: PaseoHandle): Promise<void> {
    const result = await this.exec(["agent", "stop", handle.agentId]);
    const json = extractJsonObject(result.text);
    if (json !== null) {
      assertNoCliError(json, "paseo agent stop", result);
    }
  }
}
