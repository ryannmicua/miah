/**
 * U10 E2E — the kill drill (v3), the first-class verification milestone
 * (R42, R90, KTD18, AE29; U10.2).
 *
 * A real driver (`miah run`, real Paseo dispatches) is spawned in a child
 * process and force-killed mid-run at U2's dispatch. A `miah run --once` resume
 * must:
 *
 *   1. reconstruct byte-identical supervisor-derived state from the durable
 *      record (R42) — the pre-kill journal bytes are a prefix of the post-resume
 *      journal (append-only, tail-repaired only), and deriving state from the
 *      pre-kill event set yields the same serialized state before and after the
 *      resume;
 *   2. take the stale lease (R39/R72: stale-takeover, never fresh-steal);
 *   3. reconcile the in-flight dispatch intent by querying the adapter (R37,
 *      R38): the `dispatch_intent` without a `dispatch_created` (intent-
 *      without-created) is closed via `reconcile_record` + `dispatch_failed`, or
 *      a created handle is re-read from the adapter; and
 *   4. continue to completion (U10.2: "continue → complete").
 *
 * The fake substrate probe is used ONLY to get `miah start` admitted (KTD9);
 * the dispatches themselves are real specialists on the live daemon.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFixtureRepo,
  derivedState,
  driveToAwaitingApproval,
  e2eConfig,
  journalEvents,
  killChild,
  layoutOf,
  quietDriveOnce,
  serializeState,
  spawnDriveChild,
  startRun,
  TEST_PLAN,
  validJournalPrefix,
  waitForChildExit,
  waitForJournalEvent,
  waitForLeaseAvailable,
  type E2EOptions,
} from "./helpers/e2e-harness";
import { makeFakeProbe } from "../fixtures/fake-substrate-probe";
import { readJournalFile } from "../../src/journal";
import { deriveState } from "../../src/replay";
import { RunStore } from "../../src/run-store";
import { readUnitsFromStore } from "../../src/step";
import type { DerivedState, JournalEvent } from "../../src/types";

const tempDirs: string[] = [];
const fixtureRepos: Array<{ repoRoot: string; cleanup: () => void }> = [];

function makeBasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miah-kd-base-"));
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

describe("e2e kill drill", () => {
  it(
    "kill the driver mid-dispatch at U2 -> resume -> byte-identical state -> intent reconciled -> continue to completion",
    async () => {
      const repo = makeFixtureRepo();
      const config = e2eConfig();
      const basePath = makeBasePath();
      const opts: E2EOptions = { basePath, config, repoRoot: repo.repoRoot };

      // `miah start` with the fake probe (U10.11).
      const runId = await startRun(TEST_PLAN, opts, makeFakeProbe());
      const journalPath = layoutOf(basePath, runId).journalPath;

      // Spawn a real looping driver (real dispatches; the child re-works
      // provider-dud dispatches itself) and wait for U2's dispatch_intent — the
      // supervisor is now mid-dispatch at U2.
      const driveChild = spawnDriveChild({
        runId,
        basePath,
        config,
        workspaceRoot: repo.repoRoot,
        verificationCommands: {
          U1: ["node -e \"require('fs').existsSync('src/hello.ts')||process.exit(1)\""],
          U2: ["node -e \"require('fs').existsSync('src/greeter.ts')||process.exit(1)\""],
          U3: ["node -e \"JSON.parse(require('fs').readFileSync('config/app.json','utf8'))\""],
        },
        once: false,
      });
      const u2Intent = await waitForJournalEvent(
        journalPath,
        (event) => event.type === "dispatch_intent" && event.unit_id === "U2",
        900_000,
      );
      expect(u2Intent).toBeDefined();
      const killed = killChild(driveChild.child);
      await waitForChildExit(driveChild.child, 20_000);
      expect(killed, "the driver should have been killed mid-run").toBe(true);

      // Wait for the killed driver's lease to go stale so the resumer can take it.
      const layout = layoutOf(basePath, runId);
      await waitForLeaseAvailable(layout.leasePath, config.lease.ttl_s, 240_000);

      // Capture the pre-kill durable record and the state it reconstructs (R42).
      const rawBefore = fs.readFileSync(journalPath, "utf8");
      const preKillRead = readJournalFile(journalPath);
      const preKillEvents = preKillRead.events;
      expect(preKillEvents.length).toBeGreaterThan(0);
      const lastPreKillSeq = preKillEvents[preKillEvents.length - 1].seq;
      const stateBefore = derivedState(basePath, runId);
      const stateBeforeSerialized = serializeState(stateBefore);

      // Resume with `miah run --once` (R3: acquire lease, replay, reconcile,
      // advance one step).
      const resumeCode = await quietDriveOnce(opts, runId);
      expect(resumeCode).toBe(0);

      // --- Byte-identical supervisor-derived state (R42) ---------------------
      // The durable record is append-only: the pre-kill journal bytes (up to the
      // last complete event) are a prefix of the post-resume journal. A
      // crash-truncated partial tail is the only thing the resumer repairs.
      const rawAfter = fs.readFileSync(journalPath, "utf8");
      expect(rawAfter.startsWith(validJournalPrefix(rawBefore))).toBe(true);

      // Deriving state from the pre-kill event set yields the identical state
      // before and after the resume — replay is deterministic and the resume did
      // not rewrite history.
      const allEventsAfter = journalEvents(basePath, runId);
      const preKillOnlyAfter = allEventsAfter.filter((event) => event.seq <= lastPreKillSeq);
      expect(serializeState(derivedStateFromEvents(basePath, runId, preKillOnlyAfter))).toBe(
        stateBeforeSerialized,
      );
      // The pre-kill event prefix itself is byte-identical (same seqs, same
      // payloads) after the resume.
      expect(preKillOnlyAfter.map((event) => event.seq)).toEqual(
        preKillEvents.map((event) => event.seq),
      );

      // --- The resume took the stale lease, never a fresh-steal (R39/R72) -----
      const eventsAfterResume = journalEvents(basePath, runId);
      const postKillLease = eventsAfterResume.find(
        (event) => event.type === "lease_acquired" && event.seq > lastPreKillSeq,
      );
      expect(postKillLease).toBeDefined();
      expect(postKillLease?.stale_takeover).toBe(true);

      // --- The in-flight intent was reconciled by querying the adapter (R37/R38)
      const u2Reconcile = eventsAfterResume.find(
        (event) => event.type === "reconcile_record" && event.unit_id === "U2",
      );
      expect(u2Reconcile).toBeDefined();
      expect(["no-handle", "handle-found", "deadline-exceeded"]).toContain(u2Reconcile?.finding);
      const u2Closed = eventsAfterResume.some(
        (event) =>
          (event.type === "dispatch_failed" && event.unit_id === "U2") ||
          (event.type === "dispatch_terminated" && event.unit_id === "U2"),
      );
      expect(u2Closed).toBe(true);

      // --- Continue to completion (U10.2) -------------------------------------
      // U2 escalates on the calibrated-judge gate (empty corpora, KTD10), the
      // operator approves via `miah resolve --decision approve`, U3 completes.
      await driveToAwaitingApproval(opts, runId, ["U2"]);
      const finalState = derivedState(basePath, runId);
      expect(finalState.phase).toBe("AwaitingApproval");
      expect(finalState.units.U1?.status).toBe("accepted");
      expect(finalState.units.U2?.status).toBe("accepted");
      expect(finalState.units.U3?.status).toBe("accepted");
      expect(finalState.in_flight_intents).toHaveLength(0);
      expect(fs.existsSync(layoutOf(basePath, runId).approvalPackagePath)).toBe(true);

      // The run store's lease was released on the clean final exit.
      const finalLease = JSON.parse(fs.readFileSync(layoutOf(basePath, runId).leasePath, "utf8"));
      expect(finalLease.released).toBe(true);
    },
    2_400_000,
  );
});

/** Derive state over a specific event set (the pre-kill prefix), R42. */
function derivedStateFromEvents(
  basePath: string,
  runId: string,
  events: JournalEvent[],
): DerivedState {
  const store = new RunStore({
    basePath,
    runId,
    config: e2eConfig(),
    holderId: "kd-reader",
  });
  const units = readUnitsFromStore(store) ?? {};
  return deriveState(events, { units });
}
