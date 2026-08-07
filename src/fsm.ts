/**
 * Run-phase FSM (KTD14, R64, R35).
 *
 * The run phases are Admitting → Ready → Implementing → Reviewing →
 * AwaitingApproval → Complete, plus the two orthogonal pause phases Attention
 * (escalation raised, run paused awaiting operator resolve) and Stopping
 * (operator stop, terminating in-flight, releasing the lease).
 *
 * Phase meanings (KTD14 table):
 *
 * | Phase | Meaning |
 * |---|---|
 * | Admitting | Preflight + substrate probe + lease acquisition |
 * | Ready | Lease held, units parsed, no work dispatched yet |
 * | Implementing | Builder(s) dispatched for eligible units |
 * | Reviewing | Tester/reviewer dispatched for a frozen candidate |
 * | AwaitingApproval | All units accepted, approval package written, awaiting operator |
 * | Attention | Escalation raised, run paused, awaiting operator resolve |
 * | Stopping | Operator issued stop, terminating in-flight, releasing lease |
 * | Complete | Operator approved, run terminated |
 *
 * Transitions (plan U8 approach): Admitting→Ready (after lease),
 * Ready→Implementing (first dispatch), Implementing→Reviewing (candidate
 * frozen for testing), Reviewing→Implementing (next unit) or→AwaitingApproval
 * (all units done), AwaitingApproval→Complete (operator approve), any→Attention
 * (escalation), any→Stopping (operator stop). A transition is journaled as a
 * `phase_transition` event (R35, R42) so the run's phase is always derivable
 * from the durable record.
 */
import type { JournalEvent } from "./types";
import type { RunStore } from "./run-store";

/** The KTD14 run-phase enum. */
export const RUN_PHASES = [
  "Admitting",
  "Ready",
  "Implementing",
  "Reviewing",
  "AwaitingApproval",
  "Attention",
  "Stopping",
  "Complete",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

/**
 * Normal phase-to-phase transitions (KTD14). `Attention` and `Stopping` are
 * reachable from any phase and handled separately, so they are omitted here.
 */
const PHASE_TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  Admitting: ["Ready"],
  Ready: ["Implementing"],
  Implementing: ["Reviewing"],
  Reviewing: ["Implementing", "AwaitingApproval"],
  AwaitingApproval: ["Complete"],
  Attention: ["Ready"],
  Stopping: ["Ready"],
  Complete: [],
};

/** The pre-transition sentinel phase produced by replay before any event. */
export const INITIAL_PHASE_SENTINEL = "not-started";

/**
 * Whether a `from -> to` transition is permitted by the FSM (KTD14). Any
 * transition into `Attention` (escalation) or `Stopping` (operator stop) is
 * allowed from every phase per the plan; the sentinel "not-started" phase may
 * only open the machine (into Admitting/Ready) or pause it.
 */
export function isValidTransition(from: string, to: string): boolean {
  if (from === to) {
    return true;
  }
  if (from === INITIAL_PHASE_SENTINEL) {
    return to === "Admitting" || to === "Ready" || to === "Attention" || to === "Stopping";
  }
  if (to === "Attention" || to === "Stopping") {
    return true;
  }
  const fromPhase = RUN_PHASES.find((phase) => phase === from);
  if (fromPhase === undefined) {
    return false;
  }
  return (PHASE_TRANSITIONS[fromPhase] as readonly string[]).includes(to);
}

/**
 * Journal a `phase_transition` event when the run moves from `from` to `to`
 * (R35). A no-op (from === to) returns null without appending; an invalid
 * transition throws rather than corrupting the run's phase history. The
 * `from` value is taken from the caller (normally the reconstructed phase);
 * the appended event is the durable record R42 replays from.
 */
export function transitionPhase(
  store: RunStore,
  from: string,
  to: string,
): JournalEvent | null {
  if (from === to) {
    return null;
  }
  if (!isValidTransition(from, to)) {
    throw new Error(`invalid phase transition: ${from} -> ${to}`);
  }
  return store.append("phase_transition", { from, to });
}

/**
 * Transition the run into `to` using the store's *current* reconstructed phase
 * as the `from` value. Idempotent: when the run is already in `to`, nothing is
 * journaled. Throws on an invalid transition.
 */
export function ensurePhase(store: RunStore, to: string): JournalEvent | null {
  const from = store.stateSnapshot().phase;
  return transitionPhase(store, from, to);
}
