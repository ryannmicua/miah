/**
 * U5 dispatch pipeline + reconciliation tests.
 *
 * Every dispatch in this suite runs against a scripted in-memory adapter
 * (injected fake executor) — no real agent is ever created. The reconciliation
 * tests drive the R37/R38 restart semantics; the child-process kill drill
 * (kill-drill-v2.test.ts) exercises the same logic across a real process kill.
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultGitCommitReader,
  dispatchUnit,
  isPastDeadline,
  pollUntilTerminal,
  reconcileIntents,
  resolveRoleDefaults,
  type DispatchContext,
  type ReconcileResult,
} from "../src/dispatch";
import { writeEnvelope, type ResultEnvelope } from "../src/envelope";
import { ScriptedAdapter } from "./helpers/scripted-adapter";
import {
  cleanupTempDirs,
  createTestStore,
  makeTempDir,
  type TestStore,
} from "./helpers";
import { D8I_ROLE_DEFAULTS, PlanUnit, SpecialistRole } from "../src/types";

const PLAN_TEXT = [
  "---",
  "title: Dispatch Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Dispatch Test Plan",
  "",
  "## Implementation Units",
  "",
  "### U1. Source module",
  "",
  "- **Goal:** Create the src/hello.ts source module.",
  "- **Requirements:** R1.",
  "- **creates:** `src/hello.ts`",
  "- **inputs:** none",
  "- **depends-on:** none",
  "",
  "### U2. Consumer module",
  "",
  "- **Goal:** Create the src/greeter.ts consumer module.",
  "- **creates:** `src/greeter.ts`",
  "- **inputs:** `src/hello.ts`",
  "- **depends-on:** U1",
  "",
].join("\n");

const UNIT_U1: PlanUnit = {
  id: "U1",
  number: 1,
  title: "Source module",
  goal: "Create the src/hello.ts source module.",
  requirements: "R1",
  creates: ["src/hello.ts"],
  inputs: [],
  dependsOn: [],
  acceptance: null,
};

function unitsJson(): Record<string, PlanUnit> {
  return { U1: UNIT_U1 };
}

/** A run store with a plan snapshot + units.json, holding the lease. */
function setupStore(): TestStore {
  const t = createTestStore({ holderId: "holder-A" });
  const acquired = t.store.lease.acquire("holder-A");
  if (!acquired.ok) {
    throw new Error(`lease acquire failed: ${acquired.reason}`);
  }
  fs.writeFileSync(t.layout.planSnapshotPath, PLAN_TEXT, "utf8");
  fs.writeFileSync(t.layout.unitsJsonPath, `${JSON.stringify(unitsJson(), null, 2)}\n`, "utf8");
  return t;
}

function makeCtx(t: TestStore, adapter: ScriptedAdapter, extra: Partial<DispatchContext> = {}): DispatchContext {
  return {
    store: t.store,
    adapter,
    repoRoot: makeTempDir(),
    preferencesPath: path.join(makeTempDir(), "no-preferences.json"),
    now: t.clock.fn,
    ...extra,
  };
}

function envelopeFor(role: SpecialistRole, unitId: string, take: number): ResultEnvelope {
  return {
    schema_version: 1,
    producer_role: role,
    attempt_id: `dispatch-${role}-${unitId}-t${take}`,
    take,
    unit_id: unitId,
    self_claim: `Finished ${unitId} take ${take}.`,
    produced_files: [{ path: "src/hello.ts", sha256: "a".repeat(64) }],
    wall_clock_estimate_s: 10,
  };
}

function futureDeadline(clockNow: number): string {
  return new Date(clockNow + 3_600_000).toISOString();
}

function pastDeadline(clockNow: number): string {
  return new Date(clockNow - 3_600_000).toISOString();
}

afterEach(cleanupTempDirs);

describe("dispatch pipeline", () => {
  it("journals dispatch_intent BEFORE the adapter call and records observed identity (R17, R36)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    const adapter = new ScriptedAdapter();
    adapter.launchResult = { agentId: "agent-1", cwd: worktree, workspaceId: "wks_1" };

    let intentSeenBeforeLaunch = false;
    adapter.onLaunch = () => {
      // The R17 assertion happens at the moment the adapter call leaves.
      intentSeenBeforeLaunch = t.store.journal
        .readEvents()
        .some((event) => event.type === "dispatch_intent" && event.unit_id === "U1");
    };

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const outcome = await dispatchUnit(ctx, {
      unit: UNIT_U1,
      role: "builder",
      take: 1,
      deadline: futureDeadline(t.clock.now),
    });

    expect(intentSeenBeforeLaunch).toBe(true);
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") {
      return;
    }
    // seq ordering: intent is journaled strictly before created.
    expect(outcome.intent.seq).toBeLessThan(outcome.created.seq);
    expect(outcome.created).toMatchObject({
      unit_id: "U1",
      agent_id: "agent-1",
      workspace_id: "wks_1",
      base_commit: "commit-fake",
    });
    // The adapter launch was given the U4 dispatch contract (R7-R11): a fresh
    // session in a dedicated worktree, branch-off.
    expect(adapter.launchCalls[0].opts).toMatchObject({
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      workspace: "worktree",
      worktreeMode: "branch-off",
    });
    expect(adapter.launchCalls[0].opts.title).toBe("miah-builder-U1-t1");
    // The packet (not the base commit) is what reaches the specialist.
    expect(adapter.launchCalls[0].prompt).toContain("Miah Dispatch Packet");
    expect(adapter.launchCalls[0].prompt).not.toContain("commit-fake");
  });

  it("adapter call fails → dispatch_failed journaled with the reason (R36)", async () => {
    const t = setupStore();
    const adapter = new ScriptedAdapter();
    adapter.launchError = new Error("paseo run failed: MISSING_PROVIDER: Provider is required");

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const outcome = await dispatchUnit(ctx, {
      unit: UNIT_U1,
      role: "builder",
      take: 1,
      deadline: futureDeadline(t.clock.now),
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") {
      return;
    }
    expect(outcome.intent.seq).toBeLessThan(outcome.failed.seq);
    expect(outcome.failed.unit_id).toBe("U1");
    expect(outcome.failed.idempotency_key).toBe("dispatch-builder-U1-t1");
    expect(String(outcome.failed.reason)).toContain("MISSING_PROVIDER");
    // No created event: the adapter never produced a handle.
    const types = t.store.journal.readEvents().map((event) => event.type);
    expect(types).not.toContain("dispatch_created");
  });

  it("dispatch_intent carries sender role, unit id, take, idempotency key, packet hash, deadline, provider/model (D8-i)", async () => {
    const t = setupStore();
    const adapter = new ScriptedAdapter();
    adapter.launchResult = { agentId: "agent-1", cwd: makeTempDir(), workspaceId: "wks_1" };

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    await dispatchUnit(ctx, {
      unit: UNIT_U1,
      role: "builder",
      take: 1,
      deadline: futureDeadline(t.clock.now),
    });

    const intent = t.store.journal
      .readEvents()
      .find((event) => event.type === "dispatch_intent") as Record<string, unknown>;
    expect(intent).toMatchObject({
      sender_role: "miah",
      role: "builder",
      unit_id: "U1",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      deadline: futureDeadline(t.clock.now),
    });
    expect(intent.packet_hash).toMatch(/^[0-9a-f]{64}$/);
    // D8-i defaults: builder maps to opencode / opencode-go-deepseek-v4-flash.
    expect(intent.provider).toBe(D8I_ROLE_DEFAULTS.builder.provider);
    expect(intent.model).toBe(D8I_ROLE_DEFAULTS.builder.model);
  });

  it("role defaults: D8-i table when preferences absent, operator preferences override when present", () => {
    const absent = resolveRoleDefaults("builder", {
      preferencesPath: path.join(makeTempDir(), "missing.json"),
    });
    expect(absent).toEqual(D8I_ROLE_DEFAULTS.builder);

    const prefsDir = makeTempDir();
    const prefsPath = path.join(prefsDir, "orchestration-preferences.json");
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({ builder: { provider: "codex", model: "gpt-5.6-sol" } }),
      "utf8",
    );
    const overridden = resolveRoleDefaults("builder", { preferencesPath: prefsPath });
    expect(overridden).toEqual({ paseo_role: "impl", provider: "codex", model: "gpt-5.6-sol" });

    // Planner follows its own D8-i row.
    expect(resolveRoleDefaults("planner", { preferencesPath: prefsPath })).toEqual(
      D8I_ROLE_DEFAULTS.planner,
    );
  });

  it("dispatch a planner: packet has plan snapshot only (no code-writing authority); envelope read after termination", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    const adapter = new ScriptedAdapter();
    adapter.launchResult = { agentId: "agent-planner", cwd: worktree, workspaceId: "wks_p" };
    adapter.statusFor = () => "idle"; // terminal immediately

    // The specialist wrote its result envelope to the declared path before Miah
    // observed termination.
    writeEnvelope(
      path.join(worktree, ".miah", "envelope-planner-U1-t1.json"),
      envelopeFor("planner", "U1", 1),
    );

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const outcome = await dispatchUnit(ctx, {
      unit: UNIT_U1,
      role: "planner",
      take: 1,
      deadline: futureDeadline(t.clock.now),
    });

    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") {
      return;
    }
    // The planner packet carries the immutable plan snapshot and no code-writing
    // authority (R8).
    expect(outcome.packet.plan_excerpt).toBe(PLAN_TEXT);
    expect(outcome.packet.authority_bounds.read_only).toBe(true);
    expect(outcome.packet.authority_bounds.code_writing).toBe(false);
    expect(outcome.packet.result_envelope_path).toBe(".miah/envelope-planner-U1-t1.json");

    const poll = await pollUntilTerminal(ctx, outcome.handle, outcome.ref, {
      cadenceMs: 1,
      maxPolls: 10,
    });
    expect(poll.status).toBe("terminated");
    if (poll.status !== "terminated") {
      return;
    }
    expect(poll.envelope).not.toBeNull();
    expect(poll.envelope?.producer_role).toBe("planner");
    expect(poll.gapEvent).toBeNull();
    expect(poll.terminatedEvent).toMatchObject({ unit_id: "U1", outcome: "success" });

    const types = t.store.journal.readEvents().map((event) => event.type);
    expect(types).toContain("result_envelope_observed");
    expect(types).toContain("dispatch_terminated");
    expect(types).not.toContain("gap_recorded");
  });

  it("result envelope absent at harvest → evidence gap, not auto-failure and not auto-completion (R43)", async () => {
    const t = setupStore();
    const worktree = makeTempDir(); // specialist wrote nothing
    const adapter = new ScriptedAdapter();
    adapter.launchResult = { agentId: "agent-1", cwd: worktree, workspaceId: "wks_1" };
    adapter.statusFor = () => "idle";

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const outcome = await dispatchUnit(ctx, {
      unit: UNIT_U1,
      role: "builder",
      take: 1,
      deadline: futureDeadline(t.clock.now),
    });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") {
      return;
    }

    const poll = await pollUntilTerminal(ctx, outcome.handle, outcome.ref, {
      cadenceMs: 1,
      maxPolls: 10,
    });
    expect(poll.status).toBe("terminated");
    if (poll.status !== "terminated") {
      return;
    }
    // Closed as an evidence gap: not auto-failed, not auto-completed.
    expect(poll.gapEvent).not.toBeNull();
    expect(poll.gapEvent?.criterion).toBe("result-envelope");
    expect(String(poll.gapEvent?.reason)).toContain("R43");
    expect(poll.terminatedEvent.outcome).toBe("envelope-missing");
    expect(poll.envelope).toBeNull();

    const types = t.store.journal.readEvents().map((event) => event.type);
    expect(types).not.toContain("acceptance_decision");
    // Derived state: the gap stays open and the unit is not accepted.
    const state = t.store.stateSnapshot();
    expect(state.open_gaps.some((gap) => gap.criterion === "result-envelope")).toBe(true);
    expect(state.units.U1.status).not.toBe("accepted");
  });

  it("dispatch_created records the base commit read from git, not from the packet (A6)", async () => {
    const t = setupStore();
    const repoRoot = makeTempDir();
    const headCommit = makeGitRepo(repoRoot);

    const adapter = new ScriptedAdapter();
    adapter.launchResult = { agentId: "agent-1", cwd: makeTempDir(), workspaceId: "wks_1" };

    const ctx: DispatchContext = {
      store: t.store,
      adapter,
      repoRoot,
      now: t.clock.fn,
      // Default git reader: reads the actual worktree HEAD.
      gitReader: defaultGitCommitReader,
    };
    const outcome = await dispatchUnit(ctx, {
      unit: UNIT_U1,
      role: "builder",
      take: 1,
      deadline: futureDeadline(t.clock.now),
    });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") {
      return;
    }
    expect(outcome.created.base_commit).toBe(headCommit);
    // The packet never carried the commit (A6: observed, not self-reported).
    expect("base_commit" in outcome.packet).toBe(false);
    expect(adapter.launchCalls[0].prompt).not.toContain(headCommit);
  });

  it("poll gives up (no terminated event) when the agent never reaches terminal", async () => {
    const t = setupStore();
    const adapter = new ScriptedAdapter();
    adapter.launchResult = { agentId: "agent-1", cwd: makeTempDir(), workspaceId: "wks_1" };
    adapter.statusFor = () => "running";

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const outcome = await dispatchUnit(ctx, {
      unit: UNIT_U1,
      role: "builder",
      take: 1,
      deadline: futureDeadline(t.clock.now),
    });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") {
      return;
    }
    const poll = await pollUntilTerminal(ctx, outcome.handle, outcome.ref, {
      cadenceMs: 1,
      maxPolls: 3,
    });
    expect(poll.status).toBe("gave-up");
    expect(poll.status === "gave-up" && poll.lastStatus).toBe("running");
    const types = t.store.journal.readEvents().map((event) => event.type);
    expect(types).not.toContain("dispatch_terminated");
  });

  it("poll refuses work once the deadline passes before harvest (R5/R44)", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    const adapter = new ScriptedAdapter();
    adapter.launchResult = { agentId: "agent-1", cwd: worktree, workspaceId: "wks_1" };
    adapter.statusFor = () => "idle";

    const deadline = futureDeadline(t.clock.now); // e.g. now + 1h
    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const outcome = await dispatchUnit(ctx, {
      unit: UNIT_U1,
      role: "builder",
      take: 1,
      deadline,
    });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") {
      return;
    }

    // Miah dies; the specialist runs past the recorded deadline while Miah is
    // dead. On resume the work is refused (R5).
    t.clock.now = Date.parse(deadline) + 60_000;
    t.store.lease.maybeHeartbeat("holder-A");
    const poll = await pollUntilTerminal(ctx, outcome.handle, outcome.ref, {
      cadenceMs: 1,
      maxPolls: 10,
    });
    expect(poll.status).toBe("terminated");
    if (poll.status !== "terminated") {
      return;
    }
    expect(poll.terminatedEvent.outcome).toBe("deadline-exceeded");
    expect(poll.gapEvent?.criterion).toBe("deadline");
    expect(adapter.stopCalls).toHaveLength(1);
    // The envelope, even if written, was refused (never read as admissible).
    const types = t.store.journal.readEvents().map((event) => event.type);
    expect(types).not.toContain("result_envelope_observed");
  });

  it("isPastDeadline is strict-now and lenient on malformed/absent deadlines", () => {
    expect(isPastDeadline(new Date(1_000_000).toISOString(), 1_000_001)).toBe(true);
    expect(isPastDeadline(new Date(1_000_000).toISOString(), 1_000_000)).toBe(false);
    expect(isPastDeadline("not-a-date", 9_999_999_999)).toBe(false);
    expect(isPastDeadline("", 9_999_999_999)).toBe(false);
    expect(isPastDeadline(null, 9_999_999_999)).toBe(false);
  });
});

describe("dispatch reconciliation", () => {
  it("intent-without-created → adapter queried → no handle → reconcile_record + dispatch_failed → rework (R37)", async () => {
    const t = setupStore();
    // Miah died right after journaling the intent, before the adapter call.
    const intentPayload = {
      sender_role: "miah",
      role: "builder",
      unit_id: "U1",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      packet_hash: "a".repeat(64),
      deadline: futureDeadline(t.clock.now),
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    };
    t.store.append("dispatch_intent", intentPayload);

    const adapter = new ScriptedAdapter();
    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const results = await reconcileIntents(ctx);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.outcome).toBe("no-handle");
    expect(result.failedEvent).not.toBeNull();
    expect(String(result.failedEvent?.reason)).toContain("no handle");
    expect(result.createdEvent).toBeNull();

    // R38: reconcile_record precedes the decision event.
    const events = t.store.journal.readEvents();
    const reconcileSeq = events.find((e) => e.type === "reconcile_record")?.seq ?? -1;
    const failedSeq = events.find((e) => e.type === "dispatch_failed")?.seq ?? -1;
    expect(reconcileSeq).toBeGreaterThan(0);
    expect(failedSeq).toBeGreaterThan(reconcileSeq);

    // The unit is routed to rework: no in-flight intent remains and the unit is
    // eligible for a fresh take.
    const state = t.store.stateSnapshot();
    expect(state.in_flight_intents).toHaveLength(0);
    expect(state.units.U1.status).toBe("not_started");
  });

  it("intent-without-created → handle found → dispatch_created with discovered identity → harvest if terminal (R37)", async () => {
    const t = setupStore();
    t.store.append("dispatch_intent", {
      sender_role: "miah",
      role: "builder",
      unit_id: "U1",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      packet_hash: "a".repeat(64),
      deadline: futureDeadline(t.clock.now),
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    });

    const worktree = makeTempDir();
    writeEnvelope(
      path.join(worktree, ".miah", "envelope-builder-U1-t1.json"),
      envelopeFor("builder", "U1", 1),
    );

    const adapter = new ScriptedAdapter();
    adapter.inspectFor = () => ({
      agentId: "agent-recovered",
      lifecycle: "idle",
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      mode: "default",
      cwd: worktree,
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
      capabilities: {},
    });

    const ctx = makeCtx(t, adapter, {
      gitReader: () => "recovered-commit",
      handleResolver: async ({ intent }) =>
        intent.idempotency_key === "dispatch-builder-U1-t1"
          ? { agentId: "agent-recovered", cwd: worktree, workspaceId: "wks_recovered" }
          : null,
    });
    const results = await reconcileIntents(ctx);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.outcome).toBe("handle-found");
    expect(result.createdEvent).toMatchObject({
      unit_id: "U1",
      agent_id: "agent-recovered",
      workspace_id: "wks_recovered",
      base_commit: "recovered-commit",
    });
    expect(result.terminatedEvent?.outcome).toBe("success");
    expect(result.refused).toBe(false);

    const types = t.store.journal.readEvents().map((event) => event.type);
    expect(types).toContain("reconcile_record");
    expect(types).toContain("dispatch_created");
    expect(types).toContain("result_envelope_observed");
    expect(types).toContain("dispatch_terminated");
  });

  it("kill after dispatch_created before dispatch_terminated → resume → handle found → terminal → harvest", async () => {
    const t = setupStore();
    const worktree = makeTempDir();
    t.store.append("dispatch_intent", {
      sender_role: "miah",
      role: "builder",
      unit_id: "U1",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      packet_hash: "a".repeat(64),
      deadline: futureDeadline(t.clock.now),
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    });
    t.store.append("dispatch_created", {
      unit_id: "U1",
      agent_id: "agent-1",
      workspace_id: "wks_1",
      base_commit: "commit-before-death",
    });
    writeEnvelope(
      path.join(worktree, ".miah", "envelope-builder-U1-t1.json"),
      envelopeFor("builder", "U1", 1),
    );

    const adapter = new ScriptedAdapter();
    adapter.inspectFor = () => ({
      agentId: "agent-1",
      lifecycle: "idle",
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      mode: "default",
      cwd: worktree,
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
      capabilities: {},
    });

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const results = await reconcileIntents(ctx);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.outcome).toBe("handle-found");
    expect(result.status).toBe("idle");
    // Created identity already existed — reconciliation must NOT re-journal it.
    expect(result.createdEvent).toBeNull();
    expect(result.terminatedEvent?.outcome).toBe("success");
    expect(result.handle?.cwd).toBe(worktree);

    const types = t.store.journal.readEvents().map((event) => event.type);
    const createdCount = types.filter((type) => type === "dispatch_created").length;
    expect(createdCount).toBe(1);
    expect(types).toContain("reconcile_record");
    expect(types).toContain("result_envelope_observed");
  });

  it("kill after dispatch_created before dispatch_terminated → resume → status live → resume polling", async () => {
    const t = setupStore();
    t.store.append("dispatch_intent", {
      sender_role: "miah",
      role: "builder",
      unit_id: "U1",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      packet_hash: "a".repeat(64),
      deadline: futureDeadline(t.clock.now),
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    });
    t.store.append("dispatch_created", {
      unit_id: "U1",
      agent_id: "agent-1",
      workspace_id: "wks_1",
      base_commit: "commit-before-death",
    });

    const adapter = new ScriptedAdapter();
    adapter.inspectFor = () => ({
      agentId: "agent-1",
      lifecycle: "running",
      provider: null,
      model: null,
      mode: null,
      cwd: null,
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
      capabilities: {},
    });

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const results = await reconcileIntents(ctx);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.outcome).toBe("handle-found");
    expect(result.status).toBe("running");
    expect(result.terminatedEvent).toBeNull();
    expect(result.handle?.agentId).toBe("agent-1");

    const types = t.store.journal.readEvents().map((event) => event.type);
    expect(types).toContain("reconcile_record");
    expect(types).not.toContain("dispatch_terminated");
    expect(types).not.toContain("dispatch_failed");
  });

  it("deadline passed while Miah was dead → work refused, specialist terminated immediately (R5)", async () => {
    const t = setupStore();
    t.store.append("dispatch_intent", {
      sender_role: "miah",
      role: "builder",
      unit_id: "U1",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      packet_hash: "a".repeat(64),
      deadline: pastDeadline(t.clock.now),
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    });
    t.store.append("dispatch_created", {
      unit_id: "U1",
      agent_id: "agent-1",
      workspace_id: "wks_1",
      base_commit: "commit-before-death",
    });

    const worktree = makeTempDir();
    writeEnvelope(
      path.join(worktree, ".miah", "envelope-builder-U1-t1.json"),
      envelopeFor("builder", "U1", 1),
    );

    const adapter = new ScriptedAdapter();
    adapter.inspectFor = () => ({
      agentId: "agent-1",
      lifecycle: "idle",
      provider: null,
      model: null,
      mode: null,
      cwd: worktree,
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
      capabilities: {},
    });

    const ctx = makeCtx(t, adapter, { gitReader: () => "commit-fake" });
    const results = await reconcileIntents(ctx);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.refused).toBe(true);
    expect(adapter.stopCalls.map((handle) => handle.agentId)).toContain("agent-1");
    expect(result.terminatedEvent?.outcome).toBe("deadline-exceeded");

    const gap = t.store.stateSnapshot().open_gaps.find((g) => g.criterion === "deadline");
    expect(gap).toBeDefined();
    expect(String(gap?.reason)).toContain("R5");
    // Work was refused: the envelope was never read as admissible.
    const types = t.store.journal.readEvents().map((event) => event.type);
    expect(types).not.toContain("result_envelope_observed");
  });

  it("reconcile with an in-flight intent whose adapter status is unknown lifecycle still closes safely", async () => {
    const t = setupStore();
    t.store.append("dispatch_intent", {
      sender_role: "miah",
      role: "builder",
      unit_id: "U1",
      take: 1,
      idempotency_key: "dispatch-builder-U1-t1",
      packet_hash: "a".repeat(64),
      deadline: futureDeadline(t.clock.now),
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
    });

    const adapter = new ScriptedAdapter();
    adapter.inspectFor = () => ({
      agentId: "agent-1",
      lifecycle: "running",
      provider: null,
      model: null,
      mode: null,
      cwd: null,
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
      capabilities: {},
    });

    const ctx = makeCtx(t, adapter, {
      gitReader: () => "commit-fake",
      handleResolver: async () => ({ agentId: "agent-1", cwd: null, workspaceId: "wks_1" }),
    });
    const results = await reconcileIntents(ctx);
    const result: ReconcileResult = results[0];
    // A live session resumes polling — the unit stays in flight for U8 to poll.
    expect(result.outcome).toBe("handle-found");
    expect(result.status).toBe("running");
    expect(result.terminatedEvent).toBeNull();
  });
});

/** Create a real temp git repo; returns its HEAD commit. */
function makeGitRepo(dir: string): string {
  cp.execFileSync("git", ["init", "-q", dir]);
  cp.execFileSync("git", ["-C", dir, "config", "user.email", "miah-test@example.com"]);
  cp.execFileSync("git", ["-C", dir, "config", "user.name", "Miah Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "test repo\n", "utf8");
  cp.execFileSync("git", ["-C", dir, "add", "-A"]);
  cp.execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  return cp.execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
}
