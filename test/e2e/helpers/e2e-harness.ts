/**
 * Shared harness for the U10 E2E suite (test/e2e/*.test.ts; not a vitest test
 * file).
 *
 * Real agent dispatches are the point of this unit: these helpers drive Miah's
 * command functions against the LIVE Paseo daemon with the real adapter,
 * dispatching real specialists into git worktrees branched off a throwaway
 * fixture repo. Only the substrate-probe verdicts are faked — and ONLY by the
 * full-run and kill-drill tests (U10.11); substrate-fail-closed always uses the
 * real probe.
 *
 * Every helper that touches the live daemon also cleans up after itself:
 * archive the fixture project's workspaces (which archives their agents), drop
 * the derived project record from the daemon registries, and remove the temp
 * repo — so a test run leaves no Paseo artifacts behind.
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expect, vi } from "vitest";
import {
  PaseoCliAdapter,
  PaseoCliError,
  PaseoCliUnavailableError,
  resolveCliInvocation,
  type PaseoAdapter,
} from "../../../src/adapter/paseo";
import { runApprove } from "../../../src/commands/approve";
import { runCommand, type RunCommandOptions } from "../../../src/commands/run";
import { runResolve } from "../../../src/commands/resolve";
import { runStart } from "../../../src/commands/start";
import { runStatus, buildStatusReport, type StatusReport } from "../../../src/commands/status";
import { unresolvedEscalations, type EscalationSummary } from "../../../src/escalation";
import { readJournalFile } from "../../../src/journal";
import { readManifest } from "../../../src/manifest";
import { readUnitsFromStore } from "../../../src/step";
import { deriveState } from "../../../src/replay";
import { resolveRunLayout, RunStore } from "../../../src/run-store";
import type { Config, DerivedState, JournalEvent, PlanUnit, UnitId } from "../../../src/types";
import { fastConfig } from "../../../test/helpers";

export const FIXTURES_DIR = path.join(__dirname, "..", "..", "fixtures");
export const TEST_PLAN = path.join(FIXTURES_DIR, "test-plan.md");
export const TEST_PLAN_BAD = path.join(FIXTURES_DIR, "test-plan-bad.md");

/** Deep-partial overrides so tests can tweak one nested threshold at a time. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** A real adapter shared by the E2E tests (live Paseo daemon). */
export function realAdapter(): PaseoAdapter {
  return new PaseoCliAdapter();
}

/**
 * E2E run config.
 *
 * - `no_progress_polls` is raised far above the default 3 so the driver's
 *   step-boundary polling (no sleep in the loop) never escalates a healthy,
 *   working agent for "no-progress" (R76 is exercised in unit tests).
 * - `max_rework_cycles: 0` routes a `not_accepted` unit to its escalation on
 *   the FIRST attempt, so the calibrated-judge criterion on U2 (which can never
 *   pass mechanically with empty corpora, KTD10) escalates in one dispatch and
 *   the E2E keeps its real-dispatch footprint minimal.
 * - dispatch max_duration 3600s (60m): a tiny real specialist can take many
 *   minutes to terminate under daemon load, so the recorded deadline must never
 *   fire mid-test for a healthy agent (the deadline-refusal test injects its
 *   own clock and reads the deadline dynamically, so it is unaffected).
 * - lease timing heartbeat 15s / TTL 180s: a single step includes a real
 *   `paseo run` launch that can take tens of seconds under daemon load, and the
 *   driver heartbeats only at step boundaries, so the TTL must comfortably
 *   exceed one step; the kill drill waits out the TTL after the kill to take
 *   the stale lease. (The shipped default stays 60s per R72; the E2E harness
 *   uses a longer TTL so slow daemon steps under load don't stale the lease.)
 */
export function e2eConfig(overrides: DeepPartial<Config> = {}): Config {
  const base = fastConfig();
  return {
    ...base,
    ...overrides,
    journal: { ...base.journal, ...(overrides.journal ?? {}) },
    lease: { heartbeat_interval_s: 15, ttl_s: 180, ...(overrides.lease ?? {}) },
    dispatch: { ...base.dispatch, no_progress_polls: 100, max_duration: 3600, ...(overrides.dispatch ?? {}) },
    run: { ...base.run, max_rework_cycles: 0, ...(overrides.run ?? {}) },
    calibration: { ...base.calibration, ...(overrides.calibration ?? {}) },
  };
}

/** Options passed to every Miah command function for one E2E scenario. */
export interface E2EOptions {
  basePath: string;
  config: Config;
  repoRoot: string;
  once?: boolean;
  now?: () => number;
}

/** Build the shared run-command options for a scenario (real adapter + git). */
export function runOptions(opts: E2EOptions): RunCommandOptions {
  return {
    basePath: opts.basePath,
    config: opts.config,
    workspaceRoot: opts.repoRoot,
    canonicalWorktree: opts.repoRoot,
    once: opts.once ?? false,
    verificationCommandsFor,
    now: opts.now,
  };
}

// ---------------------------------------------------------------------------
// Verification commands for the fixture units (real Node checks run by Miah in
// the worktree and in the integrated checkout, R45/R54).
// ---------------------------------------------------------------------------

const nodeCheck = (body: string): string => `node -e "${body}"`;

function checkFileExistsAndContains(relPath: string, needle: string): string {
  // Single-quote the needle inside the double-quoted `node -e` shell string:
  // an embedded double quote (JSON.stringify) would close the shell quote and
  // mangle the JS (cp.exec runs through a shell on every platform).
  const needleJs = `'${needle.replace(/'/g, "\\'")}'`;
  return nodeCheck(
    `const fs=require('fs');const p='${relPath.replace(/'/g, "\\'")}';` +
      `if(!fs.existsSync(p))process.exit(1);` +
      `const t=fs.readFileSync(p,'utf8');` +
      `if(${needleJs}.split(',').some((n)=>n&&!t.includes(n)))process.exit(1);`,
  );
}

function checkValidJson(relPath: string): string {
  return nodeCheck(
    `JSON.parse(require('fs').readFileSync('${relPath.replace(/'/g, "\\'")}','utf8'));`,
  );
}

/**
 * Verification-contract commands per unit (R45). The U2 check reads the unit's
 * declared `creates:` so the same mapping serves both the original and the
 * amended (renamed) plans.
 */
export function verificationCommandsFor(unit: PlanUnit): string[] {
  switch (unit.id) {
    case "U1":
      return [checkFileExistsAndContains("src/hello.ts", "export")];
    case "U2": {
      const target = unit.creates?.[0] ?? "src/greeter.ts";
      return [
        checkFileExistsAndContains("src/hello.ts", "export"),
        checkFileExistsAndContains(target, "hello"),
      ];
    }
    case "U3":
      return [checkValidJson("config/app.json")];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Fixture repo + live-daemon cleanup
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Run a paseo CLI command synchronously and return its stdout. */
export function runCli(args: string[]): string {
  const invocation = resolveCliInvocation();
  return cp.execFileSync(invocation.file, [...invocation.argsPrefix, ...args], {
    encoding: "utf8",
  });
}

/** Whether the `paseo` CLI is resolvable on PATH (live-daemon tests gate on this). */
export function paseoCliAvailable(): boolean {
  try {
    resolveCliInvocation();
    return true;
  } catch {
    return false;
  }
}

/** Case-folded, separator-normalized path identity used by the daemon's registries. */
function normalizeIdentityPath(value: string): string {
  return path.resolve(value).replace(/[\\/]+/g, "\\").toLowerCase();
}

/** The daemon stores realpath'd roots; compare against both variants. */
function identityPaths(value: string): string[] {
  const variants = [normalizeIdentityPath(value)];
  try {
    variants.push(normalizeIdentityPath(fs.realpathSync(value)));
  } catch {
    // keep the plain variant
  }
  return [...new Set(variants)];
}

/** Remove the project record the daemon derived for a temp fixture repo. */
export function removeProjectRecord(repoRoot: string): void {
  const registry = path.join(os.homedir(), ".paseo", "projects", "projects.json");
  const workspacesRegistry = path.join(os.homedir(), ".paseo", "projects", "workspaces.json");
  try {
    if (!fs.existsSync(registry)) {
      return;
    }
    const projects = JSON.parse(fs.readFileSync(registry, "utf8")) as Array<{
      projectId: string;
      rootPath: string;
      archivedAt: string | null;
    }>;
    const identities = identityPaths(repoRoot);
    const matches = projects.filter(
      (project) =>
        project.archivedAt === null && identities.includes(normalizeIdentityPath(project.rootPath)),
    );
    if (matches.length === 0) {
      return;
    }
    const referenced =
      fs.existsSync(workspacesRegistry) &&
      (JSON.parse(fs.readFileSync(workspacesRegistry, "utf8")) as Array<{
        projectId: string;
        archivedAt: string | null;
      }>).some(
        (workspace) =>
          workspace.archivedAt === null &&
          matches.some((match) => match.projectId === workspace.projectId),
      );
    if (referenced) {
      return;
    }
    const removed = new Set(matches.map((match) => match.projectId));
    fs.writeFileSync(
      registry,
      JSON.stringify(projects.filter((project) => !removed.has(project.projectId)), null, 2) + "\n",
      "utf8",
    );
  } catch {
    // best effort
  }
}

/**
 * Best-effort teardown of the live-daemon artifacts a fixture repo derived:
 * archive every workspace bound to the repo's project (archiving their agents),
 * drop the project record, and remove the temp repo. Retries the daemon calls a
 * few times because the live daemon hiccups under load (the same flake the
 * `withTransientRetry` driver wrapper absorbs).
 */
export function cleanupFixtureRepo(repoRoot: string): void {
  const projectName = path.basename(repoRoot);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let workspaces: Array<{ workspaceId: string; project: string }> = [];
      try {
        workspaces = JSON.parse(runCli(["workspace", "ls", "--json"])) as Array<{
          workspaceId: string;
          project: string;
        }>;
      } catch {
        if (attempt < 2) {
          sleepSync(2_000);
          continue;
        }
        break;
      }
      const mine = workspaces.filter((workspace) => workspace.project === projectName);
      if (mine.length === 0) {
        break;
      }
      let allArchived = true;
      for (const workspace of mine) {
        try {
          runCli(["workspace", "archive", workspace.workspaceId]);
        } catch {
          allArchived = false;
        }
      }
      if (allArchived) {
        break;
      }
      sleepSync(2_000);
    }
  } catch {
    // best effort
  }
  removeProjectRecord(repoRoot);
  try {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // busy-wait: execFileSync-blocked callers cannot use async sleep
  }
}

/** Create a throwaway git fixture repo with one seeded commit. */
export function createFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miah-e2e-repo-"));
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "e2e@local");
  git(repoRoot, "config", "user.name", "e2e");
  fs.writeFileSync(path.join(repoRoot, "seed.txt"), "seed\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-qm", "seed");
  return { repoRoot, cleanup: () => cleanupFixtureRepo(repoRoot) };
}

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

/** `miah start <plan>` with the fake probe; returns the run id on success. */
export async function startRun(
  planPath: string,
  opts: E2EOptions,
  probe: { run(): Promise<unknown> },
): Promise<string> {
  const result = await runStart(planPath, {
    probe: probe as never,
    basePath: opts.basePath,
    config: opts.config,
    workspaceRoot: opts.repoRoot,
  });
  if (result !== 0) {
    throw new Error(`miah start failed with exit code ${result}`);
  }
  const runIds = fs
    .readdirSync(path.join(opts.basePath, "runs"))
    .filter((entry) => fs.statSync(path.join(opts.basePath, "runs", entry)).isDirectory());
  return runIds[runIds.length - 1];
}

/** `miah run` — drive the run. Returns the command exit code (0 = advanced/complete/stopped). */
export function drive(opts: E2EOptions, runId: string): Promise<number> {
  return withTransientRetry(() => runCommand(runId, runOptions(opts)));
}

/** `miah run --once` — one step and exit. Returns the command exit code. */
export function driveOnce(opts: E2EOptions, runId: string): Promise<number> {
  return runCommand(runId, runOptions({ ...opts, once: true }));
}

/** `miah approve` the run. */
export function approve(opts: E2EOptions, runId: string): Promise<number> {
  return runApprove(runId, { basePath: opts.basePath, config: opts.config });
}

/** `miah resolve --decision approve` for a specific escalation. */
export function resolveApprove(opts: E2EOptions, runId: string, escalationId: string): Promise<number> {
  return withTransientRetry(() =>
    runResolve(runId, escalationId, "approve", "e2e operator approval", {
      basePath: opts.basePath,
      config: opts.config,
      // R89: the approved unit's creates integrate into the canonical repo.
      canonicalWorktree: opts.repoRoot,
      verificationCommandsFor,
    }),
  );
}

/** `miah resolve --decision rework` for a specific escalation (dud retry). */
export function resolveRework(opts: E2EOptions, runId: string, escalationId: string): Promise<number> {
  return withTransientRetry(() =>
    runResolve(runId, escalationId, "rework", "e2e provider-dud retry", {
      basePath: opts.basePath,
      config: opts.config,
    }),
  );
}

/**
 * True when an open escalation is a PROVIDER DUD rather than a real evaluation
 * outcome. The live daemon intermittently returns "Model is unavailable" for a
 * launched specialist: the agent is created (`dispatch_created`) and then
 * closes immediately having produced no envelope, opening a `result-envelope`
 * gap (R43). The run then escalates the unit (no work -> verification fails ->
 * rework budget exhausted -> R78). A real calibrated-judge/human escalation has
 * no such gap: the work product and envelope exist. The E2E harness treats a
 * dud as retryable — `miah resolve --decision rework` re-dispatches the unit —
 * exactly the flake class `withTransientRetry` absorbs at the adapter level,
 * and never masks a real Miah failure (a dud leaves no deliverable, so its
 * acceptance/integration assertions can never pass).
 */
export function isDudEscalation(opts: E2EOptions, runId: string, escalation: EscalationSummary): boolean {
  if (escalation.unit_id === null) {
    return false;
  }
  const gaps = derivedState(opts.basePath, runId).open_gaps;
  return gaps.some((gap) => gap.unit_id === escalation.unit_id && gap.criterion === "result-envelope");
}

/** Re-work a dud escalation's unit (bounded), so a provider flake re-dispatches. */
async function retryDud(
  opts: E2EOptions,
  runId: string,
  escalation: EscalationSummary,
  budget: Map<string, number>,
  maxReworks: number,
  context: string,
): Promise<void> {
  const unitId = escalation.unit_id ?? "run";
  const reworks = budget.get(unitId) ?? 0;
  expect(
    reworks,
    `provider dud on ${unitId} exceeded the dud-retry budget while ${context}`,
  ).toBeLessThan(maxReworks);
  budget.set(unitId, reworks + 1);
  const code = await resolveRework(opts, runId, escalation.escalation_id);
  expect(code).toBe(0);
}

/** Default bound on dud re-dispatches per unit (a ~20-30% flake clears in 1-2). */
export const DEFAULT_MAX_DUD_REWORKS = 3;

/** Open (unresolved) escalations for a run, oldest first. */
export function openEscalations(opts: E2EOptions, runId: string): EscalationSummary[] {
  const store = new RunStore({
    basePath: opts.basePath,
    runId,
    config: opts.config,
    holderId: "e2e-reader",
  });
  return unresolvedEscalations(store);
}

/** `miah status` — returns the process exit code (also exercises the render path). */
export function status(opts: E2EOptions, runId: string): number {
  return runStatus(runId, { basePath: opts.basePath, config: opts.config });
}

/** Structured `miah status` report (R64) read from the journal without a driver. */
export function statusReport(opts: E2EOptions, runId: string): StatusReport {
  const layout = resolveRunLayout(opts.basePath, runId);
  const manifest = readManifest(layout);
  if (manifest === null) {
    throw new Error(`no manifest for run ${runId}`);
  }
  const store = new RunStore({
    basePath: opts.basePath,
    runId,
    config: opts.config,
    holderId: "e2e-reader",
  });
  return buildStatusReport(store, layout, manifest);
}

// ---------------------------------------------------------------------------
// Journal + state helpers
// ---------------------------------------------------------------------------

export function layoutOf(basePath: string, runId: string): ReturnType<typeof resolveRunLayout> {
  return resolveRunLayout(basePath, runId);
}

export function journalEvents(basePath: string, runId: string): JournalEvent[] {
  return readJournalFile(layoutOf(basePath, runId).journalPath).events;
}

/** Derived state from the journal (R42), with the units graph for `blocked`. */
export function derivedState(basePath: string, runId: string): DerivedState {
  const layout = resolveRunLayout(basePath, runId);
  const { events } = readJournalFile(layout.journalPath);
  const units = readUnitsJson(layout.unitsJsonPath);
  return deriveState(events, { units });
}

function readUnitsJson(unitsJsonPath: string): Record<UnitId, PlanUnit> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(unitsJsonPath, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<UnitId, PlanUnit>)
      : {};
  } catch {
    return {};
  }
}

export function manifestOf(basePath: string, runId: string): ReturnType<typeof readManifest> {
  return readManifest(layoutOf(basePath, runId));
}

/** Canonical serialization of derived state for byte-identical comparisons. */
export function serializeState(state: DerivedState): string {
  return JSON.stringify(state);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the journal contains an event matching `predicate` (or timeout). */
export async function waitForJournalEvent(
  journalPath: string,
  predicate: (event: JournalEvent) => boolean,
  timeoutMs = 120_000,
): Promise<JournalEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { events } = readJournalFile(journalPath);
    const found = events.find(predicate);
    if (found !== undefined) {
      return found;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for a journal event matching the predicate`);
}

/** Wait until the run's lease is released or its heartbeat is stale past TTL. */
export async function waitForLeaseAvailable(leasePath: string, ttlS: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(leasePath, "utf8");
      const lease = JSON.parse(raw) as { last_heartbeat_at?: number; released?: boolean };
      if (lease.released === true) {
        return;
      }
      if (
        typeof lease.last_heartbeat_at === "number" &&
        Date.now() - lease.last_heartbeat_at > ttlS * 1000
      ) {
        return;
      }
    } catch {
      // lease not readable yet
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for the lease to be available at ${leasePath}`);
}

/**
 * Valid journal text up to the last complete event (drops a crash-truncated
 * partial tail the same way a resumer's replay would).
 */
export function validJournalPrefix(raw: string): string {
  const lastNewline = raw.lastIndexOf("\n");
  return lastNewline < 0 ? "" : raw.slice(0, lastNewline + 1);
}

// ---------------------------------------------------------------------------
// Child driver process (kill drill)
// ---------------------------------------------------------------------------

const VITE_NODE_ENTRY = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules",
  "vite-node",
  "vite-node.mjs",
);
const DRIVE_RUN_CHILD = path.resolve(__dirname, "drive-run-child.ts");

export interface DriveChildScenario {
  runId: string;
  basePath: string;
  config: Config;
  workspaceRoot: string;
  verificationCommands: Record<UnitId, string[]>;
  once?: boolean;
}

export interface DriveChild {
  child: cp.ChildProcess;
  scenarioPath: string;
  markerPath: string;
  logPath: string;
}

/**
 * Spawn a real driver for a run in a child process (vite-node). The child runs
 * `miah run` via `runCommand` with the real adapter, real git diff runner, and
 * the injected verification commands. The parent can kill it to simulate a
 * mid-run supervisor death.
 */
export function spawnDriveChild(scenario: DriveChildScenario): DriveChild {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "miah-drive-child-"));
  const scenarioPath = path.join(base, "scenario.json");
  const markerPath = path.join(base, "marker.json");
  const logPath = path.join(base, "child.log");
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");
  const logFd = fs.openSync(logPath, "w");
  const child = cp.spawn(
    process.execPath,
    [VITE_NODE_ENTRY, DRIVE_RUN_CHILD, scenarioPath, markerPath],
    { stdio: ["ignore", "ignore", logFd] },
  );
  fs.closeSync(logFd);
  return { child, scenarioPath, markerPath, logPath };
}

/** Force-kill a child process (best-effort). Returns whether a kill was issued. */
export function killChild(child: cp.ChildProcess): boolean {
  if (child.exitCode !== null || child.pid === undefined) {
    return false;
  }
  try {
    process.kill(child.pid);
    return true;
  } catch {
    return false;
  }
}

export async function waitForChildExit(child: cp.ChildProcess, timeoutMs = 30_000): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(timeoutMs),
  ]);
}

// ---------------------------------------------------------------------------
// Step-driving helpers shared by the E2E tests
// ---------------------------------------------------------------------------

/**
 * Retry a driver call on transient live-daemon adapter errors (`paseo inspect`
 * / `status` hiccups under load — the plan's known live-daemon flake). Retrying
 * a step is safe because observations are read-only and journaled appends are
 * atomic: a retry replays the durable record and reconciles before acting, so
 * it never re-appends already-journaled events. Any launch failure is already
 * journaled as `dispatch_failed` by the dispatcher (bounded by max-takes).
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 4_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const transient =
        error instanceof PaseoCliError || error instanceof PaseoCliUnavailableError;
      if (!transient || attempt >= attempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

/** One `miah run --once` step without spraying the test output. */
export function quietDriveOnce(opts: E2EOptions, runId: string): Promise<number> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const promise = withTransientRetry(() => driveOnce(opts, runId));
  return promise.finally(() => spy.mockRestore());
}

/**
 * Drive `--once` steps until `predicate(state)` holds or the run pauses in
 * Attention. Provider-dud escalations (a dispatch that produced no envelope,
 * R43) are re-worked so the unit re-dispatches (bounded) instead of failing the
 * wait; any OTHER Attention pause throws (unless `allowAttention`).
 */
export async function until(
  opts: E2EOptions,
  runId: string,
  predicate: (state: DerivedState) => boolean,
  label: string,
  options: { allowAttention?: boolean; maxDudReworks?: number } = {},
): Promise<void> {
  const maxDudReworks = options.maxDudReworks ?? DEFAULT_MAX_DUD_REWORKS;
  const dudBudget = new Map<string, number>();
  for (let i = 0; i < 2000; i++) {
    const state = derivedState(opts.basePath, runId);
    if (predicate(state)) {
      return;
    }
    if (state.phase === "Attention") {
      const escalations = openEscalations(opts, runId);
      const duds = escalations.filter((escalation) => isDudEscalation(opts, runId, escalation));
      if (duds.length > 0) {
        for (const escalation of duds) {
          await retryDud(opts, runId, escalation, dudBudget, maxDudReworks, `waiting for: ${label}`);
        }
        continue;
      }
      if (!options.allowAttention) {
        throw new Error(
          `run paused at Attention while waiting for: ${label}\n` +
            describeAttention(opts, runId, state),
        );
      }
      return;
    }
    await quietDriveOnce(opts, runId);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Human-readable summary of an Attention pause (escalations, gaps, intents). */
function describeAttention(opts: E2EOptions, runId: string, state: DerivedState): string {
  const parts: string[] = [];
  for (const escalation of openEscalations(opts, runId)) {
    parts.push(`escalation: ${escalation.unit_id ?? "run"} ${escalation.trigger}: ${escalation.reason}`);
  }
  for (const gap of state.open_gaps) {
    parts.push(`gap: ${gap.unit_id} ${gap.criterion}: ${String(gap.reason)}`);
  }
  for (const intent of state.in_flight_intents) {
    parts.push(`in_flight: ${intent.unit_id} take ${intent.take} deadline ${intent.deadline}`);
  }
  return parts.join("\n");
}

/**
 * Drive `--once` steps until the run reaches AwaitingApproval, resolving any
 * pending per-unit escalation (the calibrated-judge gate on U2) via `miah
 * resolve --decision approve`. Provider-dud escalations (a dispatch that
 * produced no envelope, R43) are re-worked first so the unit re-dispatches
 * (bounded) — the live-daemon flake class `withTransientRetry` absorbs at the
 * adapter level. Only non-dud escalations whose unit is in
 * `allowedEscalationUnits` are auto-approved; anything else fails the test.
 */
export async function driveToAwaitingApproval(
  opts: E2EOptions,
  runId: string,
  allowedEscalationUnits: string[],
  options: { maxDudReworks?: number } = {},
): Promise<void> {
  const maxDudReworks = options.maxDudReworks ?? DEFAULT_MAX_DUD_REWORKS;
  const dudBudget = new Map<string, number>();
  for (let i = 0; i < 2000; i++) {
    const state = derivedState(opts.basePath, runId);
    if (state.phase === "AwaitingApproval") {
      return;
    }
    if (state.phase === "Attention") {
      const escalations = openEscalations(opts, runId);
      expect(escalations.length).toBeGreaterThan(0);
      for (const escalation of escalations) {
        if (isDudEscalation(opts, runId, escalation)) {
          await retryDud(opts, runId, escalation, dudBudget, maxDudReworks, "driving to approval");
          continue;
        }
        expect(
          allowedEscalationUnits,
          `unexpected escalation for ${escalation.unit_id ?? "run"} (${escalation.trigger}: ${escalation.reason})`,
        ).toContain(escalation.unit_id ?? "run");
        const code = await resolveApprove(opts, runId, escalation.escalation_id);
        expect(code).toBe(0);
      }
      continue;
    }
    await quietDriveOnce(opts, runId);
  }
  throw new Error("driveToAwaitingApproval: timed out");
}
