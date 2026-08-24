/**
 * U10 E2E — deadline-past-death refusal (R26, R5, R44; U10.3).
 *
 * A dispatch is made with a recorded deadline, then "Miah is dead" past that
 * deadline (the test advances an injected clock by more than the per-agent
 * max-duration; the real specialist keeps working in real time). On resume,
 * the reconciliation must find the overdue intent and record the finding but
 * NOT terminate the specialist or close the dispatch — the watchdog is the
 * sole reaper (R26). The intent stays in-flight.
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
    "deadline expired -> resume -> reconcile_record (not stop/gap/terminate) -> intent stays in-flight (R26)",
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

      // "Miah is dead" past the deadline: advance the clock beyond it.
      const deadlineMs = Date.parse(deadline as string);
      expect(Number.isNaN(deadlineMs)).toBe(false);
      clock.now = deadlineMs + 60_000;

      // Resume: reconciliation must record the finding but NOT terminate the
      // specialist or close the dispatch (R26: watchdog is sole reaper).
      // The run may or may not pause at Attention depending on the poll
      // result, but the key assertions are on the journal events.
      await quietDriveOnce(opts, runId);

      const events = journalEvents(basePath, runId);

      // P1-1: R26 — reconcile found the overdue intent and recorded the finding.
      expect(
        events.some(
          (e) =>
            e.type === "reconcile_record" &&
            e.unit_id === "U1" &&
            e.finding === "deadline-passed-defer-to-watchdog",
        ),
      ).toBe(true);

      // P1-1: R26 — did NOT append gap_recorded or dispatch_terminated.
      expect(
        events.some(
          (e) => e.type === "dispatch_terminated" && e.unit_id === "U1" && e.outcome === "deadline-exceeded",
        ),
      ).toBe(false);
      expect(
        events.some(
          (e) => e.type === "gap_recorded" && e.unit_id === "U1" && e.criterion === "deadline",
        ),
      ).toBe(false);

      // P1-1: R26 — intent stays in-flight (not terminated by reconcile).
      const stateAfterResume = derivedState(basePath, runId);
      expect(stateAfterResume.in_flight_intents.some((i) => i.unit_id === "U1")).toBe(true);

      // P1-1: No envelope was harvested for the past-deadline dispatch.
      expect(events.some((e) => e.type === "result_envelope_observed" && e.unit_id === "U1")).toBe(
        false,
      );
      expect(events.some((e) => e.type === "evidence_harvested" && e.unit_id === "U1")).toBe(false);

      // No re-dispatch: only one dispatch_intent for U1.
      expect(
        events.filter((e) => e.type === "dispatch_intent" && e.unit_id === "U1"),
      ).toHaveLength(1);
    },
    1_800_000,
  );
});
