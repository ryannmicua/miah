/**
 * Shared step/driver test harness (U8; not a vitest test file).
 *
 * Builds an admitted-style run store (lease held, units.json + plan snapshot
 * written, phase transitioned to Ready), a seeded specialist worktree, and a
 * scripted in-memory adapter so step/driver tests never touch the live daemon.
 */
import * as fs from "fs";
import * as path from "path";
import type { PaseoInspectResult } from "../../src/adapter/paseo";
import { writeEnvelope } from "../../src/envelope";
import {
  allUnitsAccepted,
  createStepRuntime,
  readUnitsFromStore,
  runStep,
  type StepContext,
  type StepOutcome,
  type StepRuntime,
} from "../../src/step";
import type { Config, PlanUnit } from "../../src/types";
import {
  createTestStore,
  fastConfig,
  makeTempDir,
  type Clock,
  type TestStore,
} from "../helpers";
import { ScriptedAdapter } from "./scripted-adapter";

/** A deterministic-tier acceptance criterion (passes on verification all-pass). */
export const DET_CRITERION = { text: "behaves per contract", tier: "deterministic" };

/** Build a PlanUnit with sane defaults. */
export function makeUnit(
  id: string,
  number: number,
  opts: Partial<PlanUnit> = {},
): PlanUnit {
  return {
    id,
    number,
    title: `unit ${id}`,
    goal: `Create unit ${id}.`,
    requirements: null,
    creates: opts.creates ?? [],
    inputs: opts.inputs ?? [],
    dependsOn: opts.dependsOn ?? [],
    acceptance: opts.acceptance ?? [DET_CRITERION],
    ...opts,
  };
}

export interface CommandResultLike {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface StepHarness {
  t: TestStore;
  adapter: ScriptedAdapter;
  config: Config;
  holderId: string;
  repoRoot: string;
  canonicalWorktree: string;
  worktree: string;
  clock: Clock;
  runCommand?: (command: string, cwd: string) => Promise<CommandResultLike>;
  verificationCommandsFor?: (unit: PlanUnit) => string[];
}

export interface SetupHarnessOptions {
  config?: Config;
  runCommand?: (command: string, cwd: string) => Promise<CommandResultLike>;
  verificationCommandsFor?: (unit: PlanUnit) => string[];
  /** Seed the specialist worktree (creates files + envelopes). */
  seed?: (worktree: string) => void;
}

/** An admitted-style harness: store holds the lease, phase = Ready. */
export function setupHarness(
  units: Record<string, PlanUnit>,
  opts: SetupHarnessOptions = {},
): StepHarness {
  const config = opts.config ?? fastConfig();
  const t = createTestStore({ holderId: "holder-A", config });
  const acquired = t.store.lease.acquire("holder-A");
  if (!acquired.ok) {
    throw new Error(`lease acquire failed: ${acquired.reason}`);
  }
  fs.writeFileSync(t.layout.planSnapshotPath, "---\n", "utf8");
  fs.writeFileSync(t.layout.unitsJsonPath, `${JSON.stringify(units, null, 2)}\n`, "utf8");
  t.store.append("run_start", { run_id: t.layout.runId, plan_hash: "a".repeat(64) });
  t.store.append("phase_transition", { from: "not-started", to: "Ready" });
  const worktree = makeTempDir();
  const adapter = new ScriptedAdapter();
  opts.seed?.(worktree);
  return {
    t,
    adapter,
    config,
    holderId: "holder-A",
    repoRoot: makeTempDir(),
    canonicalWorktree: makeTempDir(),
    worktree,
    clock: t.clock,
    runCommand: opts.runCommand,
    verificationCommandsFor: opts.verificationCommandsFor,
  };
}

/** Write a builder's creates files + result envelope into its worktree. */
export function seedBuilderWorktree(
  worktree: string,
  unitId: string,
  take: number,
  creates: string[],
): void {
  for (const rel of creates) {
    const full = path.join(worktree, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// ${unitId}\n`, "utf8");
  }
  writeEnvelope(path.join(worktree, ".miah", `envelope-builder-${unitId}-t${take}.json`), {
    schema_version: 1,
    producer_role: "builder",
    attempt_id: `dispatch-builder-${unitId}-t${take}`,
    take,
    unit_id: unitId,
    self_claim: `Finished ${unitId} take ${take}.`,
    produced_files: [],
    wall_clock_estimate_s: 1,
  });
}

/** A verification runner that passes. */
export function passRunner(command: string): Promise<CommandResultLike> {
  return Promise.resolve({ command, exit_code: 0, stdout: "ok\n", stderr: "" });
}

/** A verification runner that fails. */
export function failRunner(command: string): Promise<CommandResultLike> {
  return Promise.resolve({ command, exit_code: 1, stdout: "", stderr: "verification failed\n" });
}

const FIXED_DIFF = {
  diff: "diff --git a/src/hello.ts b/src/hello.ts\n+export const hi = 'hi';\n",
  changedFiles: ["src/hello.ts"],
  untrackedFiles: [],
  commands: [] as string[],
};

export function stepContext(h: StepHarness): StepContext {
  return {
    store: h.t.store,
    adapter: h.adapter,
    repoRoot: h.repoRoot,
    canonicalWorktree: h.canonicalWorktree,
    config: h.config,
    diffRunner: async () => FIXED_DIFF,
    runCommand: h.runCommand,
    verificationCommandsFor: h.verificationCommandsFor,
    now: h.clock.fn,
  };
}

export function inspectResult(
  agentId: string,
  lifecycle: string,
  cwd: string | null,
): PaseoInspectResult {
  return {
    agentId,
    lifecycle,
    provider: "opencode",
    model: "opencode-go/deepseek-v4-flash",
    mode: "default",
    cwd,
    usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
    capabilities: {},
  };
}

/** Point the scripted adapter at the harness worktree with a fixed lifecycle. */
export function configureTerminalAdapter(
  h: StepHarness,
  opts: { lifecycle?: string; agentId?: string } = {},
): void {
  const lifecycle = opts.lifecycle ?? "idle";
  const agentId = opts.agentId ?? "agent-1";
  h.adapter.launchResult = { agentId, cwd: h.worktree, workspaceId: `wks-${agentId}` };
  h.adapter.statusFor = () => lifecycle;
  h.adapter.inspectFor = () => inspectResult(agentId, lifecycle, h.worktree);
}

export interface DriveResult {
  outcomes: StepOutcome[];
  runtime: StepRuntime;
  ctx: StepContext;
}

/**
 * Run steps until the run is terminal (all accepted), escalates, or blocks.
 * The first step reconciles (no in-flight -> no-op); each subsequent step
 * dispatches/polls/harvests.
 */
export async function driveSteps(h: StepHarness, maxSteps = 25): Promise<DriveResult> {
  const runtime = createStepRuntime();
  const ctx = stepContext(h);
  const outcomes: StepOutcome[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const outcome = await runStep(ctx, runtime);
    outcomes.push(outcome);
    const state = h.t.store.replay().state;
    const units = readUnitsFromStore(h.t.store) ?? {};
    if (
      outcome.escalated.length > 0 ||
      allUnitsAccepted(state, units) ||
      (state.in_flight_intents.length === 0 && outcome.idle)
    ) {
      break;
    }
  }
  return { outcomes, runtime, ctx };
}
