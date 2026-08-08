/**
 * `miah run [run-id] [--once]` command (D6-a, R63, KTD15): the looping driver.
 *
 * `miah run` acquires the run's lease, reconstructs + reconciles, and loops the
 * step function until a stop condition. `--once` runs one step and exits; the
 * next `--once` continues. The run id defaults to the most recent run in the
 * run store. The admission-time config snapshot (manifest, R80) drives the
 * driver; the run in progress keeps the config it was admitted with.
 */
import { PaseoCliAdapter, type PaseoAdapter } from "../adapter/paseo";
import { loadConfig, resolveConfigBasePath } from "../config";
import { runDriver, type DriverOptions, type DriverResult } from "../driver";
import { readManifest } from "../manifest";
import { listRunIds, resolveRunLayout, RunStore } from "../run-store";
import type { Config } from "../types";

/** Exit code used when the run is paused/blocked or the driver could not start. */
export const RUN_BLOCKED_EXIT_CODE = 1;

export interface RunCommandOptions {
  adapter?: PaseoAdapter;
  config?: Config;
  basePath?: string;
  workspaceRoot?: string;
  canonicalWorktree?: string;
  holderId?: string;
  once?: boolean;
  diffRunner?: DriverOptions["diffRunner"];
  runCommand?: DriverOptions["runCommand"];
  verificationCommandsFor?: DriverOptions["verificationCommandsFor"];
  now?: () => number;
}

/**
 * Resolve the run id to drive: the given id, or the most recent run in the run
 * store when omitted (KTD15 "defaults to the current run").
 */
export function resolveRunId(basePath: string, runId?: string): string | null {
  if (runId !== undefined && runId.length > 0) {
    return runId;
  }
  const ids = listRunIds(basePath);
  if (ids.length === 0) {
    return null;
  }
  return ids[ids.length - 1];
}

/** Render the driver result to stdout. */
export function printRunResult(result: DriverResult): void {
  console.log(result.message);
}

/**
 * Run `miah run` for a run id. Returns the process exit code:
 * 0 on clean completion / advance / operator stop, RUN_BLOCKED_EXIT_CODE when
 * the run is paused (Attention), the lease is held elsewhere, or the run does
 * not exist.
 */
export async function runCommand(
  runIdArg: string | undefined,
  opts: RunCommandOptions = {},
): Promise<number> {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const runId = resolveRunId(basePath, runIdArg);
  if (runId === null) {
    console.error("miah run: no run found (and no run id given)");
    return RUN_BLOCKED_EXIT_CODE;
  }

  const layout = resolveRunLayout(basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    console.error(`miah run: no manifest for run ${runId}`);
    return RUN_BLOCKED_EXIT_CODE;
  }

  // R80: a run in progress uses the config read at admission time.
  const config = opts.config ?? manifest.config_snapshot ?? loadConfig();
  const holderId = opts.holderId ?? `miah-${process.pid}`;
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const canonicalWorktree = opts.canonicalWorktree ?? workspaceRoot;

  const store = new RunStore({
    basePath,
    runId,
    config,
    holderId,
    now: opts.now,
  });

  const result = await runDriver({
    store,
    holderId,
    config,
    adapter: opts.adapter ?? new PaseoCliAdapter(),
    repoRoot: workspaceRoot,
    canonicalWorktree,
    once: opts.once ?? false,
    diffRunner: opts.diffRunner,
    runCommand: opts.runCommand,
    verificationCommandsFor: opts.verificationCommandsFor,
    now: opts.now,
  });
  printRunResult(result);
  return result.status === "complete" || result.status === "advanced" || result.status === "stopped"
    ? 0
    : RUN_BLOCKED_EXIT_CODE;
}
