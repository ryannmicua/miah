---
title: "FSM transition validity must be state-aware, not just static adjacency — the R67 rework-resume gap"
date: 2026-08-08
category: patterns
problem_type: knowledge
component: run-phase-fsm
tags: [miah, fsm, state-guard, transitions, awaiting-approval, r67, rework, resume, derived-state, cross-project]
applies_when: "Designing or debugging a finite-state machine where a transition's legality depends on derived state (unit statuses, open gaps, in-flight intents) — not only on the source/target phase adjacency — especially an approval gate with a rework-resume exit that the static transition table silently omits."
---

# FSM transition validity must be state-aware, not just static adjacency

## Context

Miah v1's run-phase FSM (KTD14 in the plan) has eight phases: `Admitting`, `Ready`, `Implementing`, `Reviewing`, `AwaitingApproval`, `Attention`, `Stopping`, `Complete`. The original implementation (U8; shipped in PR #1, squash commit `d7eac30`) encoded transition legality as a **static adjacency table** — `PHASE_TRANSITIONS: Record<RunPhase, readonly RunPhase[]>` — with `isValidTransition(from, to)` checking only that `to` appears in `from`'s allowed list. This is correct for transitions whose legality depends only on the two phases (e.g. `Admitting → Ready` after the lease is acquired, `Implementing → Reviewing` when a candidate is frozen).

The gap surfaced during the post-completion hardening pass (session `ses_01effaed5ffeUd5QX1vg3YQPva`, 2026-08-08). The plan's D6-e says: when all units are accepted, Miah transitions to `AwaitingApproval` and the operator runs `miah approve` (→ `Complete`) or `miah reject --rework <unit-ids>` (marks units for re-dispatch). D6-f says `miah amend` resumes only affected units. The operator can mark units for re-dispatch **while the run sits at the `AwaitingApproval` gate** — the journal records `acceptance_decision: reject` with rework targets, or `amendment_applied` with affected unit ids, and the marked units' derived status becomes `rework` or `not_started`.

The bug: the driver, on resume, saw `initialPhase === "AwaitingApproval"` and unconditionally wrote the approval package and returned `complete` (original U8 implementation, `src/driver.ts` at the time). The `AwaitingApproval → Ready` transition — the R67 resume — was not in the static transition table, so it was not even a legal transition. A run with rework-marked units at the gate would silently complete instead of resuming, leaving the marked units re-dispatched only on paper. The marking worked; the resume did not.

The fix (the `fix(U8): resume from AwaitingApproval when units are marked for rework` commit; shipped in PR #1, squash `d7eac30`; session `ses_01effaed5ffeUd5QX1vg3YQPva`) made the transition validator state-aware:

- `hasReworkMarkedUnits(state: DerivedState): boolean` — returns true when any unit's derived status is `rework` or `not_started`.
- `isValidTransition(from, to, state?)` — the `AwaitingApproval → Ready` transition is allowed **only when `state` shows rework-marked units**; without them, the gate's only legal exit is `Complete`.
- `transitionPhase` now passes `store.stateSnapshot()` to `isValidTransition`.
- `driver.ts` checkpoint branches on the same predicate: when `initialPhase === "AwaitingApproval"` and `hasReworkMarkedUnits()`, it transitions to `Ready` and re-dispatches; otherwise it writes the approval package and completes. Both the initial-entry checkpoint and the mid-loop checkpoint got the branch (two sites in the driver).

## Guidance

Four rules keep an FSM honest when transition legality depends on derived state. Each is independent.

**1. When a transition's legality depends on more than the two phases, pass the derived state into the validator.**
A static adjacency table is correct for transitions whose legality is purely structural (`Admitting → Ready` after lease). It is wrong for transitions whose legality depends on what the units look like (`AwaitingApproval → Ready` only when rework-marked units exist). The validator signature gains a `state?` parameter; the guard is a predicate over `state`, not a table lookup. The predicate is the single source of truth — the driver and the validator both call it, so they cannot disagree.

**2. Branch on the same predicate at every checkpoint that could take the transition.**
The driver checks `initialPhase === "AwaitingApproval"` at two sites: the initial entry (before the loop) and the mid-loop checkpoint (after a step completes). Both must branch on `hasReworkMarkedUnits()`, not just one. A driver that branches at one site and not the other will resume correctly on first entry and then silently complete on the second pass — the bug returns on the second `miah run --once`.

**3. The resume predicate must read the same derived state the journal reconstructs.**
`hasReworkMarkedUnits(state)` reads `state.units` — the snapshot `store.replay().state` produces from the journal. The operator's `miah reject --rework` wrote `acceptance_decision: reject` with rework targets to the journal; the marker is durable; the predicate reads it back on resume. The resume never trusts in-memory state the journal does not back — the disk-first invariant (sibling `disk-first-paseo-loop.md`) holds.

**4. Test the resume path with a two-command lifecycle, not just a single run.**
The bug was a two-command lifecycle: `miah reject --rework` (marks units) → `miah run` (must resume, not complete). A test that calls `runDriver` once with `initialPhase = "AwaitingApproval"` and asserts completion does not catch the gap; the test must first mark units for rework (write the journal event), then run the driver and assert `AwaitingApproval → Ready`. The audit file's U8.4 covers the single-cycle path; the fix commit added `test/driver.test.ts` and `test/fsm.test.ts` cases for the rework-resume path.

## Why This Matters

A static adjacency table is a clean, testable representation of an FSM — until a transition's legality depends on state the table cannot see. The R67 gap is the canonical example: the operator can mark units for re-dispatch at the approval gate, the marking is durable, and the resume silently ignores it because the transition is not in the table. The run "completes" with units that were never re-dispatched — a problem that cannot disappear silently (R50, sibling `explicit-gap-close-before-supersede.md`) is silently disappearing because the door back to `Ready` does not exist in the transition model.

The fix pattern is small: one predicate, one extra `state?` parameter, two driver branch sites. The cost of the bug is large: a rework instruction from the operator is lost, the run completes, and the operator's next status check shows a complete run with units that were never actually re-dispatched. The fix is evidence that the FSM's transition model must be tested against every lifecycle the operator can drive — not just the happy path.

This is the same state-awareness discipline Miah itself institutionalizes one level down: the supervisor's decisions are made from reconstructed derived state, never from in-memory state the journal does not back. The transition validator is part of the same disk-first contract.

## When to Apply

- Any FSM where a transition's legality depends on derived state, not just the source/target phases.
- Any approval gate with a rework-resume exit (operator can send work back at the gate).
- Any two-command CLI lifecycle where a journal event written by one command changes what the next command may do.
- Any driver loop with multiple checkpoint sites that could take the same conditional transition — branch on the same predicate at every site.

## Examples

**Wrong way (the bug, original U8 implementation in PR #1, squash `d7eac30`):**
- `isValidTransition(from, to)` checks only `PHASE_TRANSITIONS[from].includes(to)`. `AwaitingApproval → Ready` is not in the table.
- Driver at `AwaitingApproval`: `writeApprovalPackage(store); return complete;` — unconditionally.
- Operator runs `miah reject --rework U2`, then `miah run` → run completes; U2 is "rework" in the journal but was never re-dispatched. Silent data loss.

**Right way (the fix, `fix(U8)` commit in PR #1, squash `d7eac30`):**
```ts
// fsm.ts
export function hasReworkMarkedUnits(state: DerivedState): boolean {
  return Object.values(state.units).some(
    (u) => u.status === "rework" || u.status === "not_started",
  );
}
export function isValidTransition(from: string, to: string, state?: DerivedState): boolean {
  // ... existing static checks ...
  if (fromPhase === "AwaitingApproval" && to === "Ready") {
    return state !== undefined && hasReworkMarkedUnits(state);
  }
  return PHASE_TRANSITIONS[fromPhase].includes(to);
}
```
```ts
// driver.ts — both checkpoints branch on the same predicate
if (initialPhase === "AwaitingApproval") {
  if (hasReworkMarkedUnits(store.replay().state)) {
    ensurePhase(store, "Ready"); // R67 resume
  } else {
    const pkgPath = writeApprovalPackage(store, config);
    return finishResult(store, holderId, "complete", 0, pkgPath);
  }
}
```
- `test/driver.test.ts` (PR #1, squash `d7eac30`): mark units for rework → `runDriver` → assert `phase === "Ready"`, units re-dispatched.
- `test/fsm.test.ts`: `isValidTransition("AwaitingApproval", "Ready", stateWithoutRework) === false`; `isValidTransition("AwaitingApproval", "Ready", stateWithRework) === true`.
- `test/reject.command.test.ts`: `miah reject --rework U2` → next `miah run` resumes at `Ready`.