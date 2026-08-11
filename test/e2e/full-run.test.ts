/**
 * U10 E2E — full run, calibrated-judge escalation, stop/resume, and amend.
 *
 * Full run (U10.5, U10.6): `miah start` with the injected fake substrate probe
 * (KTD9/U10.11), `miah run` to completion, `miah approve`. Asserts every unit
 * accepted, evidence harvested, integration completed into the canonical repo,
 * and `approval-package.json` written.
 *
 * Calibrated-judge escalation path: with empty default corpora (KTD10) U2's
 * `calibrated-judge` criterion can never pass mechanically. The implemented
 * U7/U8 ladder grades it ungraded/route-rework, so after the unit's rework
 * budget is exhausted the run pauses with `escalation_raised` (R78/R82). The
 * operator resolves it with `miah resolve --decision approve`; the resolve
 * journals `escalation_resolved` + `acceptance_decision: accept` for U2 and the
 * run continues (F14, R66/R69).
 *
 * Stop/resume (U10.8, R65): a stop recorded while no driver is alive is
 * honored at the next step boundary (in-flight specialist terminated,
 * `phase_transition: Stopping`), and a subsequent `miah run` resumes the run.
 *
 * Amend (U10.9, R68): a change order that changes U2's `creates:` mid-run
 * creates a new snapshot version, marks U2 affected, and the run continues with
 * the amended deliverable.
 *
 * Real agent dispatches are the point (R90): these tests drive the live Paseo
 * daemon with the real adapter. The fake probe fakes only the substrate
 * verdicts, never the dispatches.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAmend } from "../../src/commands/amend";
import { runStop } from "../../src/commands/stop";
import {
  approve as approveRun,
  createFixtureRepo,
  derivedState,
  drive,
  driveToAwaitingApproval,
  e2eConfig,
  journalEvents,
  layoutOf,
  openEscalations,
  paseoCliAvailable,
  quietDriveOnce,
  resolveApprove,
  startRun,
  status,
  statusReport,
  TEST_PLAN,
  until,
  type E2EOptions,
} from "./helpers/e2e-harness";
import { makeFakeProbe } from "../fixtures/fake-substrate-probe";

const tempDirs: string[] = [];
const fixtureRepos: Array<{ repoRoot: string; cleanup: () => void }> = [];

function makeBasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miah-e2e-base-"));
  tempDirs.push(dir);
  return dir;
}

function makeFixtureRepo(): { repoRoot: string; cleanup: () => void } {
  const repo = createFixtureRepo();
  fixtureRepos.push(repo);
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  while (fixtureRepos.length > 0) {
    const repo = fixtureRepos.pop() as { cleanup: () => void };
    try {
      repo.cleanup();
    } catch {
      // best effort
    }
  }
});

/** Run `miah status` without spraying the test output. */
function quietStatus(opts: E2EOptions, runId: string): number {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    return status(opts, runId);
  } finally {
    spy.mockRestore();
  }
}

/** Drive `miah run` (non-once) until the run is Stopping (stop honored). */
async function driveToStopped(opts: E2EOptions, runId: string): Promise<void> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await drive(opts, runId);
    expect(code).toBe(0);
  } finally {
    spy.mockRestore();
  }
  expect(derivedState(opts.basePath, runId).phase).toBe("Stopping");
}

describe("e2e full-run", () => {
  it.runIf(paseoCliAvailable())(
    "start (fake probe) -> run to completion -> approve: all units accepted, evidence harvested, integration completed, approval package written, calibrated-judge escalation resolved",
    async () => {
      const repo = makeFixtureRepo();
      const opts: E2EOptions = {
        basePath: makeBasePath(),
        config: e2eConfig(),
        repoRoot: repo.repoRoot,
      };

      // `miah start` with the fake probe (U10.11: fake probe used here).
      const runId = await startRun(TEST_PLAN, opts, makeFakeProbe());

      // Checkpoint 1 (U10.7): freshly admitted run — no unit is accepted yet.
      expect(quietStatus(opts, runId)).toBe(0);
      let report = statusReport(opts, runId);
      expect(report.units.find((u) => u.id === "U1")?.status).toBe("not_started");

      // Drive U1 to acceptance (deterministic criteria: the verifier certifies
      // the frozen candidate's mechanical evidence — no operator needed).
      await until(opts, runId, (s) => s.units.U1?.status === "accepted", "U1 accepted");

      // Checkpoint 2: U1 accepted, U2 not yet accepted. (U2 may already be
      // in_flight: the step that accepted U1 can be retried on a transient
      // daemon error, and the retried step dispatches U2 — real-dispatch
      // timing, not a state violation.)
      report = statusReport(opts, runId);
      const u1 = report.units.find((u) => u.id === "U1");
      const u2 = report.units.find((u) => u.id === "U2");
      expect(u1?.status).toBe("accepted");
      expect(u2?.status).not.toBe("accepted");
      expect(["not_started", "blocked", "in_flight"]).toContain(u2?.status ?? "");
      const eventsAfterU1 = journalEvents(opts.basePath, runId);
      expect(
        eventsAfterU1.filter((e) => e.type === "evidence_harvested" && e.unit_id === "U1").length,
      ).toBeGreaterThan(0);

      // Drive U2: the verifier grades its calibrated-judge criterion, but the
      // empty default corpora (KTD10) mean no profile clears the calibration
      // bar — the verdict stays ungraded and the run pauses in Attention with
      // a no-checker-profile escalation (R48/R20, KTD6).
      await until(
        opts,
        runId,
        (s) => s.phase === "Attention",
        "U2 calibrated-judge escalation (Attention)",
        { allowAttention: true },
      );

      // Checkpoint 3: the run is paused in Attention; U2 has the open escalation.
      report = statusReport(opts, runId);
      expect(report.phase).toBe("Attention");
      expect(report.escalations.length).toBeGreaterThan(0);
      expect(report.escalations[0].unit_id).toBe("U2");
      expect(report.escalations[0].trigger).toBe("no-checker-profile-clears-calibration-bar");
      expect(["awaiting_verification", "verifying"]).toContain(
        report.units.find((u) => u.id === "U2")?.status,
      );

      // The calibration gate is the reason: U2's acceptance decision records the
      // calibrated-judge criterion as not passing.
      const attentionEvents = journalEvents(opts.basePath, runId);
      const u2Decision = attentionEvents.find(
        (e) =>
          e.type === "acceptance_decision" && e.unit_id === "U2" && e.decision === "not_accepted",
      );
      expect(u2Decision).toBeDefined();
      const criteria =
        (u2Decision?.criteria as Array<{ criterion: string; tier: string; pass: boolean }>) ?? [];
      expect(criteria.some((c) => c.tier === "calibrated-judge" && c.pass === false)).toBe(true);
      expect(
        attentionEvents.some((e) => e.type === "escalation_raised" && e.unit_id === "U2"),
      ).toBe(true);

      // Operator resolves the escalation with `miah resolve --decision approve`.
      // The approve records an operator PASS grade for U2's calibrated
      // criterion (KTD6/KTD7); the predicate re-evaluation accepts U2.
      const escalation = openEscalations(opts, runId)[0];
      const resolveCode = await resolveApprove(opts, runId, escalation.escalation_id);
      expect(resolveCode).toBe(0);
      const resolvedEvents = journalEvents(opts.basePath, runId);
      expect(
        resolvedEvents.some(
          (e) =>
            e.type === "operator_decision" &&
            e.decision === "resolve" &&
            e.escalation_id === escalation.escalation_id,
        ),
      ).toBe(true);
      expect(
        resolvedEvents.some(
          (e) =>
            e.type === "escalation_resolved" &&
            e.decision === "approve" &&
            e.escalation_id === escalation.escalation_id,
        ),
      ).toBe(true);
      expect(
        resolvedEvents.some(
          (e) => e.type === "acceptance_decision" && e.unit_id === "U2" && e.decision === "accept",
        ),
      ).toBe(true);

      // Drive U3 to completion: all units accepted -> AwaitingApproval.
      await driveToAwaitingApproval(opts, runId, ["U2"]);

      // Checkpoint 4: AwaitingApproval, all units accepted.
      report = statusReport(opts, runId);
      expect(report.phase).toBe("AwaitingApproval");
      for (const unit of report.units) {
        expect(unit.status, `unit ${unit.id}`).toBe("accepted");
      }

      // Approval package written (R67).
      const approvalPath = layoutOf(opts.basePath, runId).approvalPackagePath;
      expect(fs.existsSync(approvalPath)).toBe(true);
      const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
      expect(approval.schema).toBe("miah/approval-package/v1");
      expect(approval.units.U1.status).toBe("accepted");
      expect(approval.units.U2.status).toBe("accepted");
      expect(approval.units.U3.status).toBe("accepted");
      expect(approval.phase).toBe("AwaitingApproval");
      expect(typeof approval.plan_hash).toBe("string");

      // Integration completed into the canonical repo (R89): only the declared
      // creates: files are present.
      expect(fs.existsSync(path.join(repo.repoRoot, "src", "hello.ts"))).toBe(true);
      expect(fs.existsSync(path.join(repo.repoRoot, "src", "greeter.ts"))).toBe(true);
      expect(fs.existsSync(path.join(repo.repoRoot, "config", "app.json"))).toBe(true);

      // Evidence harvested per unit (evidence dirs exist).
      const evidenceDir = layoutOf(opts.basePath, runId).evidenceDir;
      for (const unitId of ["U1", "U2", "U3"]) {
        expect(fs.existsSync(path.join(evidenceDir, unitId))).toBe(true);
      }

      // `miah approve` -> run_terminal: complete.
      const approveCode = await approveRun(opts, runId);
      expect(approveCode).toBe(0);
      const finalState = derivedState(opts.basePath, runId);
      expect(finalState.phase).toBe("Complete");
      expect(finalState.terminal).toBe("complete");
      const finalEvents = journalEvents(opts.basePath, runId);
      expect(
        finalEvents.some((e) => e.type === "operator_decision" && e.decision === "approve"),
      ).toBe(true);
      expect(finalEvents.some((e) => e.type === "run_terminal" && e.status === "complete")).toBe(
        true,
      );

      // Checkpoint 5: Complete.
      report = statusReport(opts, runId);
      expect(report.phase).toBe("Complete");
      expect(report.terminal).toBe("complete");
      expect(report.escalations).toHaveLength(0);
    },
    2_400_000,
  );
});

describe("e2e stop and resume", () => {
  it.runIf(paseoCliAvailable())(
    "miah stop terminates the in-flight specialist and honors the stop on the next run; a later miah run resumes to completion (U10.8, R65)",
    async () => {
      const repo = makeFixtureRepo();
      const opts: E2EOptions = {
        basePath: makeBasePath(),
        config: e2eConfig(),
        repoRoot: repo.repoRoot,
      };
      const runId = await startRun(TEST_PLAN, opts, makeFakeProbe());

      // Dispatch U1 (in-flight) via a single --once step.
      await quietDriveOnce(opts, runId);
      let state = derivedState(opts.basePath, runId);
      expect(state.units.U1?.status).toBe("in_flight");
      expect(
        journalEvents(opts.basePath, runId).some(
          (e) => e.type === "dispatch_intent" && e.unit_id === "U1",
        ),
      ).toBe(true);

      // Operator issues `miah stop` while no driver is alive (R65: journaled decision + flag).
      const stopCode = runStop(runId, { basePath: opts.basePath, config: opts.config });
      expect(stopCode).toBe(0);
      const stopEvents = journalEvents(opts.basePath, runId);
      expect(stopEvents.some((e) => e.type === "operator_decision" && e.decision === "stop")).toBe(
        true,
      );

      // The next `miah run` honors the stop: in-flight specialist terminated,
      // phase -> Stopping, lease released.
      await driveToStopped(opts, runId);

      state = derivedState(opts.basePath, runId);
      expect(state.phase).toBe("Stopping");
      expect(
        journalEvents(opts.basePath, runId).some(
          (e) => e.type === "dispatch_terminated" && e.outcome === "stopped",
        ),
      ).toBe(true);
      // Only take 1 was dispatched for U1; the stop was honored without a new dispatch.
      expect(
        journalEvents(opts.basePath, runId).filter(
          (e) => e.type === "dispatch_intent" && e.unit_id === "U1",
        ),
      ).toHaveLength(1);

      // A later `miah run` resumes: U1 is re-dispatched (take 2), U2 escalates on
      // the calibrated-judge gate, resolves, U3 completes.
      await driveToAwaitingApproval(opts, runId, ["U2"]);
      const resumedEvents = journalEvents(opts.basePath, runId);
      const u1Intents = resumedEvents.filter(
        (e) => e.type === "dispatch_intent" && e.unit_id === "U1",
      );
      // >= 2: the stop (take 1) plus the resume re-dispatch; a provider-dud
      // take-2 is reworked by the harness, which may add takes.
      expect(u1Intents.length).toBeGreaterThanOrEqual(2);
      state = derivedState(opts.basePath, runId);
      expect(state.phase).toBe("AwaitingApproval");
      expect(state.units.U1?.status).toBe("accepted");
      expect(state.units.U2?.status).toBe("accepted");
      expect(state.units.U3?.status).toBe("accepted");
    },
    2_400_000,
  );
});

describe("e2e amend", () => {
  it.runIf(paseoCliAvailable())(
    "miah amend changes U2's creates: mid-run -> new snapshot, U2 re-dispatched, run continues to completion (U10.9, R68)",
    async () => {
      const repo = makeFixtureRepo();
      const opts: E2EOptions = {
        basePath: makeBasePath(),
        config: e2eConfig(),
        repoRoot: repo.repoRoot,
      };
      const runId = await startRun(TEST_PLAN, opts, makeFakeProbe());

      // Drive U1 to accepted; U2 not accepted yet. (U2 may already be
      // in_flight: the step that accepted U1 can be retried on a transient
      // daemon error, and the retried step dispatches U2. The amend pauses an
      // in-flight U2 below, R68.)
      await until(opts, runId, (s) => s.units.U1?.status === "accepted", "U1 accepted");
      expect(derivedState(opts.basePath, runId).units.U2?.status).not.toBe("accepted");

      // Build the amended plan: U2's deliverable becomes src/greeter-renamed.ts
      // everywhere (creates:, goal, files) so the re-dispatched specialist
      // produces the renamed file the amended creates: declares.
      const original = fs.readFileSync(TEST_PLAN, "utf8");
      const amended = original.split("src/greeter.ts").join("src/greeter-renamed.ts");
      expect(amended).not.toBe(original);
      const amendedPath = path.join(makeBasePath(), "test-plan-amended.md");
      fs.writeFileSync(amendedPath, amended, "utf8");

      // `miah amend` the change order.
      const amendCode = await runAmend(runId, amendedPath, {
        basePath: opts.basePath,
        config: opts.config,
        workspaceRoot: opts.repoRoot,
      });
      expect(amendCode).toBe(0);
      const amendEvents = journalEvents(opts.basePath, runId);
      const applied = amendEvents.find((e) => e.type === "amendment_applied");
      expect(applied).toBeDefined();
      expect(applied?.affected_units).toEqual(["U2"]);
      expect(applied?.changed_units).toEqual(["U2"]);
      expect(applied?.version).toBe(2);
      // New snapshot version created; the original is never mutated (KTD16).
      expect(
        fs.existsSync(path.join(layoutOf(opts.basePath, runId).root, "plan-snapshot.v2.md")),
      ).toBe(true);

      // The run continues: U2 re-dispatched with the amended creates, escalates on
      // the calibration gate, resolves, U3 completes.
      await driveToAwaitingApproval(opts, runId, ["U2"]);
      const state = derivedState(opts.basePath, runId);
      expect(state.phase).toBe("AwaitingApproval");
      expect(state.units.U2?.status).toBe("accepted");
      expect(state.units.U3?.status).toBe("accepted");

      // Integration reflects the amended deliverable: greeter-renamed.ts present,
      // the pre-amendment path absent.
      expect(fs.existsSync(path.join(repo.repoRoot, "src", "hello.ts"))).toBe(true);
      expect(fs.existsSync(path.join(repo.repoRoot, "src", "greeter-renamed.ts"))).toBe(true);
      expect(fs.existsSync(path.join(repo.repoRoot, "src", "greeter.ts"))).toBe(false);
    },
    2_400_000,
  );
});
