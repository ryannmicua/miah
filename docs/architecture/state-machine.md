---
mode: explanation
verified: 2026-08-09
---

# The Run-Phase State Machine

Miah's supervision loop is driven by an eight-phase finite-state machine — the **Run-phase FSM** (the term defined in [`CONCEPTS.md`](../../CONCEPTS.md)). This document is an **explanation**: it walks through why the machine has the phases it has, what drives each transition, and how a run's phase is always derivable from the durable record. For the exact transition table, phase meanings, event types, and exit-code mapping, see the reference doc [state-machine-reference](./state-machine-reference.md).

## Why there is a state machine at all

Miah is a stateless interpreter over a durable run directory: any process may pick a run up, reconstruct its state, and take the next safe step. For that to work, the run's position must be **derivable, not held in memory**. The phase is that position. Every phase change is journaled as a `phase_transition` event (PLAN:R35, PLAN:R42), and replay reconstructs the current phase from the latest such event (`src/replay.ts:267-273` applies `phase_transition` into derived state). The FSM's transition table is the contract for which moves are legal; a run can never be in a phase the journal does not support.

## The two kinds of phases

The eight phases are not all the same kind of thing. Six of them form the **forward spine** — the run's progress through the work. Two of them, `Attention` and `Stopping`, are **orthogonal pause states**: they interrupt the spine from any point and are exited by a specific operator- or driver-driven event, not by completing more work.

The forward spine:

- **Admitting** — the admission gate: preflight + substrate probe + lease acquisition + `run_start`. Admission journals `phase_transition: not-started → Admitting` (`src/admission.ts:203-208`, issue #3); the first `miah run` then journals `Admitting → Ready` (`src/driver.ts:378-384`).
- **Ready** — lease held, units parsed, no work dispatched yet. Every fresh or resumed run opens from here.
- **Implementing** — builders dispatched for eligible units. Entered on the first dispatch (`src/step.ts:478`).
- **Reviewing** — a candidate unit's work was frozen and is being reviewed; entered when a terminated builder's evidence is harvested (`src/step.ts:550`).
- **AwaitingApproval** — every unit is accepted; the approval package has been written; the run is parked at the operator gate.
- **Complete** — the operator approved; the run is terminal.

The pause states:

- **Attention** — an escalation was raised and the run is paused awaiting the operator. Reachable from every phase (including the sentinel). The driver exits; `miah status` shows the pending escalations; `miah resolve` closes them and the run resumes to `Ready`.
- **Stopping** — the operator issued a stop; in-flight specialists are being terminated and the lease released. Also reachable from every phase. The run resumes from here on the next `miah run` (the stop is honored, in-flight work is not re-dispatched).

## What drives a transition

Two forces move the machine:

1. **The step function** (`src/step.ts:372`, `runStep`) — the engine. One step reconstructs state, reconciles, evaluates budget predicates, dispatches eligible units, polls in-flight specialists, and on termination harvests evidence and evaluates acceptance. At the end of the step it calls `ensurePhase` to move the phase to wherever the step's outcome puts it (escalation → `Attention`, all accepted → `AwaitingApproval`, in-flight work → `Implementing`, a harvested candidate → `Reviewing`) (`src/step.ts:561-572`).

2. **Operator commands** — the operator's decisions. `miah approve` moves `AwaitingApproval → Complete` (`src/commands/approve.ts:72`); `miah reject --rework` and `miah amend` mark units so that the run resumes; `miah resolve` moves `Attention → Ready` (`src/commands/resolve.ts:141-143`).

Transitions are journaled through `transitionPhase` / `ensurePhase`, which validate legality first (`src/fsm.ts:119`, `src/fsm.ts:138`).

## The subtle part: state-aware transitions

Most transitions are structural — their legality depends only on the two phases (`Admitting → Ready` after the lease, `Implementing → Reviewing` when a candidate is frozen). But one transition's legality depends on what the units look like: **`AwaitingApproval → Ready`**, the rework-resume.

The reason is that the operator can mark units for re-dispatch *while the run is parked at the approval gate*: `miah reject --rework <units>` journals `rework_started` for those units (`src/commands/reject.ts:92-94`), and `miah amend` journals `rework_started` for affected units (`src/commands/amend.ts:237-241`). The marked units' derived status becomes `rework` or `not_started`. A run that reaches `AwaitingApproval` with rework-marked units must **resume** (back to `Ready`, re-dispatch the marked units), not wait for an approval that would leave them re-dispatched only on paper.

So the validator is state-aware: `isValidTransition("AwaitingApproval", "Ready", state)` returns true only when `hasReworkMarkedUnits(state)` — some unit's status is `rework` or `not_started` (`src/fsm.ts:76`, `src/fsm.ts:106-108`). Without rework-marked units, the gate's only legal exit is `Complete`.

The driver branches on this same predicate at **both** of its `AwaitingApproval` checkpoints — the initial-entry checkpoint before the loop (`src/driver.ts:362-372`) and the mid-loop checkpoint after a step (`src/driver.ts:401-409`). Keeping both sites on the same predicate is what makes the second `miah run --once` behave like the first; a driver that branched at one site and not the other would resurrect the original bug on the second pass. This design point has its own history — the R67 rework-resume gap — documented in the [state-aware-fsm-transition-guards pattern](../../docs/solutions/patterns/state-aware-fsm-transition-guards.md).

## Terminal and recovery paths

The machine has two terminal outcomes, both recorded as `run_terminal` events:

- **complete** — the operator approved (`src/commands/approve.ts:73`).
- **rejected** — the operator ran `miah reject --end` (`src/commands/reject.ts:96`).

Every other exit is a pause, not a terminal. The driver returns a `DriverResult` describing what it did — `complete`, `attention`, `stopped`, `lease-held`, or `advanced` (`src/driver.ts:98-112`) — and the CLI maps those to exit codes (see the reference).

Recovery works because the phase is journaled: a run killed mid-`Implementing` resumes at `Implementing`; a run stopped resumes from `Stopping`; a run with rework-marked units at the gate resumes from `Ready`. The phase never has to be remembered — it is re-derived from the journal on every invocation, which is exactly why the machine can be driven by a stateless interpreter.

## Where the phase fits in the system

The phase is the summary of the run's position; the units' derived statuses are the detail. Both live in the same `DerivedState` structure that replay reconstructs (`src/types.ts:284-295`). Status (`miah status`) renders them together from the journal without acquiring the lease (`src/commands/status.ts:86-90`, `readOnlyState`). The reference doc [state-machine-reference](./state-machine-reference.md) carries the exact table; the data model lives in [data-and-security](./data-and-security.md).
