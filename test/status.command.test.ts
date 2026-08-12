/**
 * `miah status` command tests (U9.6, R64, D6-b, AE21).
 *
 * Status renders run id, plan title + snapshot hash, phase, per-unit state
 * (accepted / in-flight / blocked), open gaps, pending escalations, cumulative
 * usage, and the lease holder — all read from the journal. It never launches a
 * driver, never acquires the lease, and never mutates the journal.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitPlan } from "../src/admission";
import { runStatus } from "../src/commands/status";
import { readJournalFile } from "../src/journal";
import { RunStore } from "../src/run-store";
import { cleanupTempDirs, fastConfig, makeTempDir } from "./helpers";
import { makeFakeProbe } from "./fixtures/fake-substrate-probe";

const THREE_UNIT_PLAN = [
  "---",
  "title: Status Test Plan",
  "artifact_contract: ce-unified-plan/v1",
  "execution: code",
  "---",
  "",
  "# Status Test Plan",
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
  "- **Goal:** Create `src/b.ts`.",
  "- **creates:** `src/b.ts`",
  "- **inputs:** none",
  "- **depends-on:** U1",
  "- **Acceptance:**",
  "  - U2.AC1. `src/b.ts` exists and is exported — `tier: deterministic`",
  "- **Verification Contract:**",
  "  - **Commands:** `U2.CMD1` = `npm test`",
  "  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`",
  "  - **Evidence sources:** `verification`",
  "",
  "### U3. Top module",
  "",
  "- **Goal:** Create `src/c.ts`.",
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

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

interface AdmittedRun {
  basePath: string;
  runId: string;
  holderId: string;
  config: ReturnType<typeof fastConfig>;
}

async function admit(): Promise<AdmittedRun> {
  const basePath = makeTempDir("miah-status-");
  const config = fastConfig();
  const holderId = "admit-holder";
  const admission = await admitPlan(THREE_UNIT_PLAN, {
    probe: makeFakeProbe(),
    config,
    basePath,
    holderId,
    workspacePaths: [],
  });
  if (!admission.ok || admission.run === null) {
    throw new Error(`admission failed: ${JSON.stringify(admission.failures)}`);
  }
  return { basePath, runId: admission.run.runId, holderId, config };
}

/** Write usage evidence that `status` sums (cumulativeUsageFromEvidence). */
function writeUsageDelta(basePath: string, runId: string): void {
  const dir = path.join(basePath, "runs", runId, "evidence", "U1", "1", "builder");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "usage-delta.json"),
    JSON.stringify({ delta: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } }),
    "utf8",
  );
}

/** Build a multi-unit journal: U1 accepted, U2 in-flight with a gap + an
 * escalation, U3 blocked on U2. */
function simulateMultiUnitRun(store: RunStore): void {
  store.append("dispatch_intent", { unit_id: "U1", role: "builder", take: 1, idempotency_key: "k1", packet_hash: "p", deadline: "d", provider: "p", model: "m" });
  store.append("dispatch_created", { unit_id: "U1", agent_id: "a1", workspace_id: "w1" });
  store.append("dispatch_terminated", { unit_id: "U1", outcome: "success", idempotency_key: "k1" });
  store.append("acceptance_decision", { unit_id: "U1", decision: "accept" });
  store.append("dispatch_intent", { unit_id: "U2", role: "builder", take: 1, idempotency_key: "k2", packet_hash: "p", deadline: "d", provider: "p", model: "m" });
  store.append("gap_recorded", { unit_id: "U2", criterion: "the criterion", reason: "missing evidence" });
  store.append("escalation_raised", { escalation_id: "esc-5", unit_id: "U2", trigger: "no-progress", reason: "no lifecycle change for 3 polls" });
  store.append("phase_transition", { from: "not-started", to: "Implementing" });
}

function captureSync(callback: () => number): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  const code = callback();
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("status command", () => {
  it("renders run id, plan title+hash, phase, units, gaps, escalations, usage, and lease (R64)", async () => {
    const run = await admit();
    const store = new RunStore({ basePath: run.basePath, runId: run.runId, config: run.config, holderId: run.holderId });
    simulateMultiUnitRun(store);
    writeUsageDelta(run.basePath, run.runId);
    // A live driver holds the lease when status is queried.
    store.lease.release(run.holderId);
    const driverStore = new RunStore({ basePath: run.basePath, runId: run.runId, config: run.config, holderId: "driver-holder" });
    const acquired = driverStore.lease.acquire("driver-holder");
    expect(acquired.ok).toBe(true);

    const { code, stdout } = captureSync(() => runStatus(run.runId, { basePath: run.basePath }));
    expect(code).toBe(0);
    expect(stdout).toContain(`run id: ${run.runId}`);
    expect(stdout).toContain("Status Test Plan");
    expect(stdout).toContain("hash ");
    expect(stdout).toContain("phase: Implementing");
    expect(stdout).toContain("U1");
    expect(stdout).toContain("accepted");
    expect(stdout).toContain("U2");
    expect(stdout).toContain("in_flight");
    expect(stdout).toContain("U3");
    expect(stdout).toContain("blocked");
    expect(stdout).toContain("gaps:");
    expect(stdout).toContain("the criterion");
    expect(stdout).toContain("missing evidence");
    expect(stdout).toContain("escalations:");
    expect(stdout).toContain("esc-5");
    expect(stdout).toContain("no lifecycle change for 3 polls");
    expect(stdout).toContain("usage:");
    expect(stdout).toContain("input tokens: 100");
    expect(stdout).toContain("output tokens: 50");
    expect(stdout).toContain("lease:");
    expect(stdout).toContain("driver-holder");
  });

  it("reads the journal only: does not acquire the lease or mutate the journal (AE21)", async () => {
    const run = await admit();
    const store = new RunStore({ basePath: run.basePath, runId: run.runId, config: run.config, holderId: run.holderId });
    simulateMultiUnitRun(store);
    store.lease.release(run.holderId);
    const driverStore = new RunStore({ basePath: run.basePath, runId: run.runId, config: run.config, holderId: "driver-holder" });
    expect(driverStore.lease.acquire("driver-holder").ok).toBe(true);

    const journalPath = path.join(run.basePath, "runs", run.runId, "journal.jsonl");
    const before = fs.readFileSync(journalPath, "utf8");

    captureSync(() => runStatus(run.runId, { basePath: run.basePath }));

    // The journal is byte-identical and the lease is still held by the driver.
    expect(fs.readFileSync(journalPath, "utf8")).toBe(before);
    const lease = driverStore.lease.read();
    expect(lease?.holder_id).toBe("driver-holder");
    expect(lease?.released).toBeUndefined();
  });

  it("defaults to the most recent run when no run id is given (KTD15)", async () => {
    const run = await admit();
    const { code, stdout } = captureSync(() => runStatus(undefined, { basePath: run.basePath }));
    expect(code).toBe(0);
    expect(stdout).toContain(`run id: ${run.runId}`);
  });

  it("returns non-zero when the run does not exist", async () => {
    const { code, stderr } = captureSync(() =>
      runStatus("run-missing", { basePath: makeTempDir("miah-status-empty-") }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("no manifest for run run-missing");
  });

  it("returns non-zero when the run store is empty and no run id is given", async () => {
    const { code, stderr } = captureSync(() =>
      runStatus(undefined, { basePath: makeTempDir("miah-status-empty-") }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("no run found");
  });

  it("journal events are not mutated by status (readEvents unchanged)", async () => {
    const run = await admit();
    const { code } = captureSync(() => runStatus(run.runId, { basePath: run.basePath }));
    expect(code).toBe(0);
    const { events } = readJournalFile(path.join(run.basePath, "runs", run.runId, "journal.jsonl"));
    // Admission wrote lease_acquired + run_start + Admitting phase transition;
    // status adds nothing.
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("lease_acquired");
    expect(events[1].type).toBe("run_start");
    expect(events[2].type).toBe("phase_transition");
    expect(events[2]).toMatchObject({ from: "not-started", to: "Admitting" });
  });
});
