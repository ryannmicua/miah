/**
 * `miah amend` command tests (U9.11-U9.12, R68, F16, D6-f, KTD16, AE25).
 *
 * `miah amend <run-id> <new-plan>`: preflight the new plan, create a new
 * snapshot version, diff `units.json`, identify affected units (changed
 * creates/inputs/depends-on plus transitive dependents), pause in-flight
 * affected units first, journal `amendment_applied` with the new hash + the
 * affected list, and mark affected units for re-dispatch. The original
 * snapshot is never mutated.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAmend } from "../src/commands/amend";
import { runDriver } from "../src/driver";
import { readJournalFile } from "../src/journal";
import { writeManifest } from "../src/manifest";
import { RunStore } from "../src/run-store";
import { computeContentHash } from "../src/snapshot";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { createStepRuntime, runStep } from "../src/step";
import {
  configureTerminalAdapter,
  defaultVerifierEnvelope,
  makeUnit,
  passRunner,
  seedBuilderWorktree,
  setupHarness,
  stepContext,
  type StepHarness,
} from "./helpers/step-harness";

const V2_PLAN_2UNIT = [
  "---",
  "title: Amend Two-Unit Plan V2",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Amend Two-Unit Plan V2",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **Goal:** Create `src/a.ts`.",
  "- **creates:** `src/a.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - U1.AC1. `src/a.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U1.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
  "### U2. Consumer module",
  "",
  "- **Goal:** Create `src/b2.ts`.",
  "- **creates:** `src/b2.ts`",
  "- **inputs:** none",
  "- **depends-on:** U1",
  "- **Acceptance:**",
  "  - U2.AC1. `src/b2.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U2.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
].join("\n");

const V2_PLAN_3UNIT = [
  "---",
  "title: Amend Three-Unit Plan V2",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Amend Three-Unit Plan V2",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **creates:** `src/a.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - U1.AC1. `src/a.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U1.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
  "### U2. Consumer module",
  "",
  "- **creates:** `src/b2.ts`",
  "- **inputs:** none",
  "- **depends-on:** U1",
  "- **Acceptance:**",
  "  - U2.AC1. `src/b2.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U2.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
  "### U3. Top module",
  "",
  "- **creates:** `src/c.ts`",
  "- **inputs:** none",
  "- **depends-on:** U2",
  "- **Acceptance:**",
  "  - U3.AC1. `src/c.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U3.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U3.AC1` -> `U3.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
].join("\n");

const BAD_PLAN = [
  "---",
  "title: Amend Bad Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Amend Bad Plan",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **Goal:** Missing creates on purpose.",
  "- **inputs:** none",
  "- **depends-on:** none",
  "- **Acceptance:**",
  "  - U1.AC1. `src/a.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U1.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

/** The harness does not write a manifest; amend requires one (R31). */
function writeHarnessManifest(h: StepHarness): void {
  writeManifest(h.t.layout, {
    schema_version: 1,
    run_id: h.t.layout.runId,
    plan_hash: "a".repeat(64),
    plan_snapshot_file: "plan-snapshot.v1.md",
    created_at: new Date().toISOString(),
    config_snapshot: h.config,
    probe_verdicts: {},
  });
}

function writePlanFile(text: string): string {
  const dir = makeTempDir("miah-amend-plan-");
  const filePath = path.join(dir, "plan-v2.md");
  fs.writeFileSync(filePath, text, "utf8");
  return filePath;
}

function capture(callback: () => Promise<number>): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  return callback().then((code) => ({
    code,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  }));
}

describe("amend command", () => {
  it("changes U2's creates: → new snapshot v2, amendment_applied, U2 re-dispatched, U1 preserved (R68, AE25)", async () => {
    const h = setupHarness(
      {
        U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
        U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b.ts"] }),
      },
      {
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/a.ts"]);
          seedBuilderWorktree(w, "U2", 1, ["src/b.ts"]);
          seedBuilderWorktree(w, "U2", 2, ["src/b2.ts"]);
        },
      },
    );
    writeHarnessManifest(h);
    const v1Snapshot = fs.readFileSync(h.t.layout.planSnapshotPath, "utf8");

    // Drive to AE25's setup: U1 accepted, U2 in-flight (KTD5: the builder
    // termination step preserves the candidate; the verifier leg runs on the
    // following steps).
    const runtime = createStepRuntime();
    configureTerminalAdapter(h, { lifecycle: "running", agentId: "agent-u1" });
    await runStepWrapper(h, runtime);
    configureTerminalAdapter(h, { lifecycle: "idle", agentId: "agent-u1" });
    await runStepWrapper(h, runtime); // builder terminates -> candidate preserved
    await runStepWrapper(h, runtime); // verifier dispatched + terminates -> U1 accepted
    configureTerminalAdapter(h, { lifecycle: "running", agentId: "agent-u2" });
    await runStepWrapper(h, runtime); // U2 builder in-flight

    let state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.units.U2.status).toBe("in_flight");

    // Release the harness lease so the amend command can take it.
    h.t.store.lease.release(h.holderId);

    const newPlanPath = writePlanFile(V2_PLAN_2UNIT);
    const amend = await capture(() =>
      runAmend(h.t.layout.runId, newPlanPath, {
        basePath: h.t.basePath,
        config: h.config,
        holderId: "amend-holder",
        adapter: h.adapter,
        workspaceRoot: h.repoRoot,
      }),
    );
    expect(amend.code).toBe(0);
    expect(amend.stdout).toContain("affected: U2");

    // In-flight U2 was paused via the adapter first (R68, D6-f, AE25).
    expect(h.adapter.stopCalls.map((handle) => handle.agentId)).toContain("agent-u2");

    const events = h.t.store.journal.readEvents();
    // operator decision journaled with identity (R69).
    const opDecision = events.find((e) => e.type === "operator_decision");
    expect(opDecision).toMatchObject({ decision: "amend" });
    expect(typeof opDecision?.operator).toBe("string");
    expect((opDecision?.operator as string).length).toBeGreaterThan(0);

    // The in-flight intent was closed with outcome "amended".
    expect(
      events.some((e) => e.type === "dispatch_terminated" && e.outcome === "amended" && e.unit_id === "U2"),
    ).toBe(true);

    // amendment_applied carries the new hash and the affected list.
    const amended = events.find((e) => e.type === "amendment_applied");
    expect(amended).toBeDefined();
    expect(amended?.affected_units).toEqual(["U2"]);
    expect(amended?.changed_units).toEqual(["U2"]);

    // New snapshot version created; the original snapshot is never mutated.
    const v2Path = path.join(h.t.layout.root, "plan-snapshot.v2.md");
    expect(fs.existsSync(v2Path)).toBe(true);
    expect(fs.readFileSync(h.t.layout.planSnapshotPath, "utf8")).toBe(v1Snapshot);
    const v2Hash = computeContentHash(fs.readFileSync(v2Path, "utf8").replace(/\r\n?/g, "\n"));
    expect(amended?.new_hash).toBe(v2Hash);
    expect(amended?.version).toBe(2);

    // U1 preserved, U2 no longer in-flight (marked for re-dispatch).
    state = h.t.store.replay().state;
    expect(state.units.U1.status).toBe("accepted");
    expect(state.in_flight_intents).toHaveLength(0);
    expect(state.units.U2.status).toBe("not_started");

    // Resume: the next run re-dispatches U2 (take 2) and completes.
    configureTerminalAdapter(h, { lifecycle: "idle", agentId: "agent-u2" });
    const driverStore = new RunStore({
      basePath: h.t.basePath,
      runId: h.t.layout.runId,
      config: h.config,
      holderId: "drive-holder",
      now: h.clock.fn,
    });
    const result = await runDriver({
      store: driverStore,
      holderId: "drive-holder",
      config: h.config,
      adapter: h.adapter,
      runCommand: passRunner,
      verifierEnvelopeFor: defaultVerifierEnvelope,
      repoRoot: h.repoRoot,
      canonicalWorktree: h.canonicalWorktree,
      now: h.clock.fn,
    });
    expect(result.status).toBe("complete");
    const afterState = h.t.store.replay().state;
    expect(afterState.units.U2.status).toBe("accepted");
    expect(afterState.units.U1.status).toBe("accepted");
    const intents = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U2");
    expect(intents).toHaveLength(2);
  });

  it("with a dependency chain (U3 depends on U2), changing U2 re-dispatches U2 AND transitive-dependent U3 (R68)", async () => {
    const h = setupHarness(
      {
        U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
        U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b.ts"] }),
        U3: makeUnit("U3", 3, { dependsOn: ["U2"], creates: ["src/c.ts"] }),
      },
      {
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/a.ts"]);
          seedBuilderWorktree(w, "U2", 1, ["src/b.ts"]);
          seedBuilderWorktree(w, "U3", 1, ["src/c.ts"]);
        },
      },
    );
    writeHarnessManifest(h);
    h.t.store.lease.release(h.holderId);

    // Drive all three to accepted (AwaitingApproval).
    configureTerminalAdapter(h, { lifecycle: "idle", agentId: "agent-1" });
    const driverStore = new RunStore({
      basePath: h.t.basePath,
      runId: h.t.layout.runId,
      config: h.config,
      holderId: "drive-holder",
      now: h.clock.fn,
    });
    const driven = await runDriver({
      store: driverStore,
      holderId: "drive-holder",
      config: h.config,
      adapter: h.adapter,
      runCommand: passRunner,
      verifierEnvelopeFor: defaultVerifierEnvelope,
      repoRoot: h.repoRoot,
      canonicalWorktree: h.canonicalWorktree,
      now: h.clock.fn,
    });
    expect(driven.status).toBe("complete");

    const newPlanPath = writePlanFile(V2_PLAN_3UNIT);
    const amend = await capture(() =>
      runAmend(h.t.layout.runId, newPlanPath, {
        basePath: h.t.basePath,
        config: h.config,
        holderId: "amend-holder",
        adapter: h.adapter,
        workspaceRoot: h.repoRoot,
      }),
    );
    expect(amend.code).toBe(0);

    const events = h.t.store.journal.readEvents();
    const amended = events.find((e) => e.type === "amendment_applied");
    expect(amended?.affected_units).toEqual(["U2", "U3"]);
    expect(amended?.changed_units).toEqual(["U2"]);

    // Both affected accepted units are marked for re-dispatch; U1 is preserved.
    const rework = events.filter((e) => e.type === "rework_started");
    expect(rework.map((e) => e.unit_id)).toEqual(["U2", "U3"]);
    const state = h.t.store.replay().state;
    expect(state.units.U2.status).toBe("rework");
    expect(state.units.U3.status).toBe("rework");
    expect(state.units.U1.status).toBe("accepted");
  });

  it("refuses a new plan that fails preflight, before anything is written (R68)", async () => {
    const h = setupHarness({
      U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
    });
    writeHarnessManifest(h);
    h.t.store.lease.release(h.holderId);

    const badPlanPath = writePlanFile(BAD_PLAN);
    const { code, stderr } = await capture(() =>
      runAmend(h.t.layout.runId, badPlanPath, {
        basePath: h.t.basePath,
        config: h.config,
        holderId: "amend-holder",
        workspaceRoot: h.repoRoot,
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("fails preflight");

    const events = h.t.store.journal.readEvents();
    expect(events.some((e) => e.type === "amendment_applied")).toBe(false);
    expect(fs.existsSync(path.join(h.t.layout.root, "plan-snapshot.v2.md"))).toBe(false);
  });

  it("returns non-zero when the run does not exist", async () => {
    const { code, stderr } = await capture(() =>
      runAmend("run-missing", writePlanFile(V2_PLAN_2UNIT), {
        basePath: makeTempDir("miah-amend-empty-"),
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("no run found");
  });

  it("amend at AwaitingApproval → next `miah run` resumes and re-dispatches the affected unit to completion (R67)", async () => {
    const h = setupHarness(
      {
        U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
        U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b.ts"] }),
      },
      {
        seed: (w) => {
          seedBuilderWorktree(w, "U1", 1, ["src/a.ts"]);
          seedBuilderWorktree(w, "U2", 1, ["src/b.ts"]);
        },
      },
    );
    writeHarnessManifest(h);
    h.t.store.lease.release(h.holderId);

    // Drive both units to accepted (AwaitingApproval).
    configureTerminalAdapter(h, { lifecycle: "idle", agentId: "agent-1" });
    const driven = await runDriver({
      store: new RunStore({
        basePath: h.t.basePath,
        runId: h.t.layout.runId,
        config: h.config,
        holderId: "drive-holder",
        now: h.clock.fn,
      }),
      holderId: "drive-holder",
      config: h.config,
      adapter: h.adapter,
      runCommand: passRunner,
      verifierEnvelopeFor: defaultVerifierEnvelope,
      repoRoot: h.repoRoot,
      canonicalWorktree: h.canonicalWorktree,
      now: h.clock.fn,
    });
    expect(driven.status).toBe("complete");
    expect(driven.phase).toBe("AwaitingApproval");

    // Amend at the gate: U2's creates changes (src/b.ts -> src/b2.ts).
    const newPlanPath = writePlanFile(V2_PLAN_2UNIT);
    const amend = await capture(() =>
      runAmend(h.t.layout.runId, newPlanPath, {
        basePath: h.t.basePath,
        config: h.config,
        holderId: "amend-holder",
        adapter: h.adapter,
        workspaceRoot: h.repoRoot,
      }),
    );
    expect(amend.code).toBe(0);

    // Durable marking happened while the phase stayed at the gate (R67).
    let state = h.t.store.replay().state;
    expect(state.phase).toBe("AwaitingApproval");
    expect(state.units.U2.status).toBe("rework");
    expect(state.units.U1.status).toBe("accepted");

    // Resume: the next run re-dispatches U2 (take 2) against the new plan and
    // completes instead of exiting at the gate.
    seedBuilderWorktree(h.worktree, "U2", 2, ["src/b2.ts"]);
    configureTerminalAdapter(h, { lifecycle: "idle", agentId: "agent-u2" });
    const resumed = await runDriver({
      store: new RunStore({
        basePath: h.t.basePath,
        runId: h.t.layout.runId,
        config: h.config,
        holderId: "resume-holder",
        now: h.clock.fn,
      }),
      holderId: "resume-holder",
      config: h.config,
      adapter: h.adapter,
      runCommand: passRunner,
      verifierEnvelopeFor: defaultVerifierEnvelope,
      repoRoot: h.repoRoot,
      canonicalWorktree: h.canonicalWorktree,
      now: h.clock.fn,
    });
    expect(resumed.status).toBe("complete");
    expect(resumed.phase).toBe("AwaitingApproval");

    state = h.t.store.replay().state;
    expect(state.units.U2.status).toBe("accepted");
    expect(state.units.U1.status).toBe("accepted");
    const intents = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "dispatch_intent" && e.role === "builder" && e.unit_id === "U2");
    expect(intents).toHaveLength(2);
    expect(
      h.t.store.journal
        .readEvents()
        .some((e) => e.type === "phase_transition" && e.from === "AwaitingApproval" && e.to === "Ready"),
    ).toBe(true);
  });
});

describe("amend contract diff (KTD1, U1.AC3)", () => {
  it("a contract-only amendment marks its unit affected; an identical normalized contract does not", async () => {
    // Old plan: U1 and U2, each with a one-command contract.
    const h = setupHarness({
      U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
      U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b2.ts"] }),
    });
    writeHarnessManifest(h);
    h.t.store.lease.release(h.holderId);

    // Only U2's contract command string changes: `npm test` -> `npm test -- u2`.
    const changed = V2_PLAN_2UNIT.replace(
      "  - **Commands:** `U2.CMD1` = `npm test`",
      "  - **Commands:** `U2.CMD1` = `npm test -- u2`",
    );
    const changedPath = writePlanFile(changed);
    const amend = await capture(() =>
      runAmend(h.t.layout.runId, changedPath, {
        basePath: h.t.basePath,
        config: h.config,
        holderId: "amend-holder",
        workspaceRoot: h.repoRoot,
      }),
    );
    expect(amend.code).toBe(0);
    const amended = h.t.store.journal
      .readEvents()
      .find((e) => e.type === "amendment_applied");
    expect(amended?.changed_units).toEqual(["U2"]);
    expect(amended?.affected_units).toEqual(["U2"]);

    // A contract-only criterion-mapping change also marks the unit affected
    // (deterministic criteria keep >= 1 command, so the remap adds a second).
    const remapped = V2_PLAN_2UNIT
      .replace(
        "  - **Commands:** `U2.CMD1` = `npm test`",
        "  - **Commands:** `U2.CMD1` = `npm test`; `U2.CMD2` = `npm run build`",
      )
      .replace(
        "  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`",
        "  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`, `U2.CMD2`",
      );
    const remappedPath = writePlanFile(remapped);
    const amend2 = await capture(() =>
      runAmend(h.t.layout.runId, remappedPath, {
        basePath: h.t.basePath,
        config: h.config,
        holderId: "amend-holder",
        workspaceRoot: h.repoRoot,
      }),
    );
    expect(amend2.code).toBe(0);
    const amended2 = h.t.store.journal
      .readEvents()
      .filter((e) => e.type === "amendment_applied")
      .pop();
    expect(amended2?.changed_units).toEqual(["U2"]);
  });

  it("an identical contract with only whitespace/order differences is not a scope change", async () => {
    const h = setupHarness({
      U1: makeUnit("U1", 1, { creates: ["src/a.ts"] }),
      U2: makeUnit("U2", 2, { dependsOn: ["U1"], creates: ["src/b2.ts"] }),
    });
    writeHarnessManifest(h);
    h.t.store.lease.release(h.holderId);

    // Same commands/mappings, different declaration order and spacing.
    const reordered = V2_PLAN_2UNIT
      .replace(
        "  - **Commands:** `U1.CMD1` = `npm test`",
        "  - **Commands:** `U1.CMD1` =  `npm test`",
      )
      .replace(
        "  - **Commands:** `U2.CMD1` = `npm test`",
        "  - **Commands:** `U2.CMD1` =  `npm test`",
      );
    const reorderedPath = writePlanFile(reordered);
    const amend = await capture(() =>
      runAmend(h.t.layout.runId, reorderedPath, {
        basePath: h.t.basePath,
        config: h.config,
        holderId: "amend-holder",
        workspaceRoot: h.repoRoot,
      }),
    );
    expect(amend.code).toBe(0);
    const amended = h.t.store.journal
      .readEvents()
      .find((e) => e.type === "amendment_applied");
    expect(amended?.changed_units).toEqual([]);
    expect(amended?.affected_units).toEqual([]);
  });
});

// Run one step through the harness's step context (reconciles once per step).
async function runStepWrapper(h: StepHarness, runtime: ReturnType<typeof createStepRuntime>): Promise<void> {
  await runStep(stepContext(h), runtime);
}
