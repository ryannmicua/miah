/**
 * U10 E2E — deadline-past-death refusal (R5, R44; U10.3).
 *
 * A dispatch is made with a recorded deadline, then "Miah is dead" past that
 * deadline (the test advances an injected clock by more than the per-agent
 * max-duration; the real specialist keeps working in real time). On resume, the
 * reconciliation must refuse all work produced past the recorded deadline:
 * terminate the specialist immediately, record `gap_recorded: deadline`, close
 * the dispatch with `dispatch_terminated: deadline-exceeded`, and never harvest
 * the envelope. With max-takes = 1 the unit's budget is exhausted, so the run
 * pauses in Attention instead of re-dispatching (no take-2 dispatch).
 *
 * Real dispatch (the live daemon); fake probe only to admit the run.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFixtureRepo,
  derivedState,
  e2eConfig,
  journalEvents,
  paseoCliAvailable,
  quietDriveOnce,
  startRun,
  TEST_PLAN,
  type E2EOptions,
} from "./helpers/e2e-harness";
import { makeFakeProbe } from "../fixtures/fake-substrate-probe";

const tempDirs: string[] = [];
const fixtureRepos: Array<{ repoRoot: string; cleanup: () => void }> = [];

function makeBasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miah-dr-base-"));
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

interface Clock {
  now: number;
  fn: () => number;
}

describe("e2e deadline refusal", () => {
  it.runIf(paseoCliAvailable())(
    "deadline expired while Miah was dead -> resume -> specialist terminated -> work refused -> gap_recorded: deadline-exceeded (R5)",
    async () => {
      const repo = makeFixtureRepo();
      const config = e2eConfig({ run: { max_takes: 1 } });
      const basePath = makeBasePath();
      const t0 = 1_000_000;
      const clock: Clock = { now: t0, fn: () => clock.now };
      const opts: E2EOptions = { basePath, config, repoRoot: repo.repoRoot, now: clock.fn };

      // Admit the run and dispatch U1 at time T0 (deadline = T0 + max_duration).
      const runId = await startRun(TEST_PLAN, opts, makeFakeProbe());
      const dispatched = await quietDriveOnce(opts, runId);
      expect(dispatched).toBe(0);
      const eventsAfterDispatch = journalEvents(basePath, runId);
      const u1Intent = eventsAfterDispatch.find(
        (event) => event.type === "dispatch_intent" && event.unit_id === "U1",
      );
      expect(u1Intent).toBeDefined();
      const deadline = u1Intent?.deadline;
      expect(typeof deadline).toBe("string");
      expect(eventsAfterDispatch.some((e) => e.type === "dispatch_created" && e.unit_id === "U1")).toBe(
        true,
      );

      // "Miah is dead" past the deadline: advance the clock beyond it. The real
      // specialist keeps working (or has already stopped) — either way the
      // refusal is decided from the recorded deadline, not the agent's state.
      const deadlineMs = Date.parse(deadline as string);
      expect(Number.isNaN(deadlineMs)).toBe(false);
      clock.now = deadlineMs + 60_000;

      // Resume: reconciliation must terminate the specialist and refuse the work
      // before deciding any next transition (R5, R44).
      const resumeCode = await quietDriveOnce(opts, runId);
      // The run is paused (Attention, R66): exact RUN_BLOCKED_EXIT_CODE = 1.
      expect(resumeCode).toBe(1);

      const events = journalEvents(basePath, runId);
      // The reconcile recorded the deadline-exceeded finding before the refusal.
      expect(
        events.some(
          (e) => e.type === "reconcile_record" && e.unit_id === "U1" && e.finding === "deadline-exceeded",
        ),
      ).toBe(true);
      // The dispatch was terminated with the deadline-exceeded outcome.
      expect(
        events.some(
          (e) => e.type === "dispatch_terminated" && e.unit_id === "U1" && e.outcome === "deadline-exceeded",
        ),
      ).toBe(true);
      // The refusal is an open evidence gap referencing the deadline (R5, R52).
      const gap = events.find(
        (e) => e.type === "gap_recorded" && e.unit_id === "U1" && e.criterion === "deadline",
      );
      expect(gap).toBeDefined();
      expect(String(gap?.reason)).toContain("deadline");

      // Work produced past the deadline was refused: no envelope observed, no
      // evidence harvested for the dispatch.
      expect(events.some((e) => e.type === "result_envelope_observed" && e.unit_id === "U1")).toBe(
        false,
      );
      expect(events.some((e) => e.type === "evidence_harvested" && e.unit_id === "U1")).toBe(false);

      // The refusal did not silently re-dispatch: no take-2 intent for U1, and
      // the unit's budget (max-takes = 1) is exhausted -> the run pauses.
      expect(
        events.filter((e) => e.type === "dispatch_intent" && e.unit_id === "U1"),
      ).toHaveLength(1);
      const state = derivedState(basePath, runId);
      expect(state.phase).toBe("Attention");
      expect(state.open_gaps.some((g) => g.unit_id === "U1" && g.criterion === "deadline")).toBe(true);
      expect(state.in_flight_intents).toHaveLength(0);
    },
    1_800_000,
  );
});
