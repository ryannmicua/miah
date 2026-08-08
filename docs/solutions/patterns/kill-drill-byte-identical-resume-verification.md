---
title: "Kill-drill byte-identical resume verification with deterministic crash-tail injection"
date: 2026-08-08
category: patterns
problem_type: knowledge
component: test-strategy
tags: [miah, kill-drill, crash-recovery, byte-identical, e2e, deterministic-injection, ci-gating, cross-project]
applies_when: "A system claims crash-recovery (resume is the only implementation) and the claim must be verified — especially a disk-first loop whose state is reconstructed from a durable record on every invocation, where the proof is byte-identical supervisor-derived state after a mid-run kill."
---

# Kill-drill byte-identical resume verification with deterministic crash-tail injection

> **Cross-project knowledge.** This pattern is staged in the Miah repo because the validating implementation happened here, but it applies to any system that claims crash-recovery and must prove it — a durable journal with replay, a dispatch pipeline with reconciliation, a driver loop that resumes after its own death. The operator will synthesize it into other projects.

## Context

Miah v1's central correctness property (D1, `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md`) is *"resume is the only implementation."* The supervisor loop is a pure step function over a durable run directory: every invocation replays the journal, reconciles reality, performs the next safe transition, and appends. The proof that this holds after a crash is the **kill drill** — kill the supervisor mid-run, resume, and assert byte-identical derived state.

The plan stages the kill drill at three levels, each proving a different layer of the recovery contract:

- **Kill drill v1 (U3, commit `9021851`)** — journal/lease level: append events, `process.kill()` mid-append, resume → byte-identical reconstructed state, no lost/duplicate events. Proves the journal+tlease recovery path.
- **Kill drill v2 (U5, commit `d578b80`)** — dispatch level: kill after `dispatch_intent` before `dispatch_created` → resume → adapter queried → no handle → `dispatch_failed` → rework; kill after `dispatch_created` → reconcile → harvest if terminal, resume poll if live. Proves the R37 intent-reconciliation path.
- **Kill drill v3 (U10, commit `d311fc4`)** — full E2E: `miah start`, `miah run`, kill mid-dispatch at U2, `miah run --once` → byte-identical state, intent reconciled, continue to completion. The first-class verification milestone the plan marks "non-negotiable" (G0.6 in the audit file).

The implementation produced four E2E test files against the real `PaseoCliAdapter` and live daemon: `test/e2e/kill-drill.test.ts` (221 lines), `test/e2e/full-run.test.ts` (398 lines), `test/e2e/deadline-refusal.test.ts` (148 lines), `test/e2e/substrate-fail-closed.test.ts` (128 lines), plus a 766-line harness (`test/e2e/helpers/e2e-harness.ts`) and a child-process driver (`test/e2e/helpers/drive-run-child.ts`, 119 lines). The final pre-PR code review (`docs/reviews/2026-08-08-final-code-review.md`, §4) assessed the kill-drill rigor as a strength.

Two engineering lessons fell out of the implementation that the plan had not called out, and the code review flagged them:

1. **Random kill timing is not enough — inject a deterministic crash-truncated tail.** The random `process.kill()` does not always land mid-write; without a truncated tail the journal-repair path is exercised probabilistically, not deterministically. `test/kill-drill-v1.test.ts:166-178` injects a manual crash-truncated tail when the random kill does not produce one, so the repair path is covered on every run (code review §4, "Kill-drill rigor").

2. **Live-daemon E2E tests must gate on CLI availability for CI resilience.** Three of the four E2E files invoked the real `paseo` CLI; on a CI host where the `paseo` binary is not on `PATH` or the daemon is down, those tests would *fail* (not skip) and break the pipeline. The harness already shipped the `paseoCliAvailable()` helper at `test/e2e/helpers/e2e-harness.ts:177-184`; only `substrate-fail-closed.test.ts:65,106` used it. The code review flagged this as L1; the fix commit `420f23b` wrapped each `it(...)` in `it.runIf(paseoCliAvailable())(...)` in the other three files.

A third lesson: the byte-identical state assertion must compare **independent artifacts**, not a value against itself. `test/kill-drill-v1.test.ts:208-218` compares the raw journal prefix (written before the kill) against the derived-state serialization (reconstructed by replay after resume). A regression in either the writer or the replayer is caught because the two artifacts are independently produced.

## Guidance

Five rules make a kill drill trustworthy. Each is independent.

**1. Stage the drill at every layer that claims recovery.**
A single end-to-end kill test proves the happy path; it does not prove each layer's recovery contract independently. Stage the drill at the journal/lease layer (kill mid-append, assert byte-identical reconstructed state), the dispatch layer (kill after intent/before created, after created/before terminated, assert reconciliation), and the end-to-end loop (kill mid-run, resume, continue to completion). Each stage proves a different branch of the recovery FSM.

**2. Assert byte-identical derived state, comparing independent artifacts.**
The assertion is: `serialize(derived_state_after_replay) === serialize(expected_state_from_raw_record)`. The two sides are independently produced — the raw record was written before the kill; the derived state is reconstructed by replay after resume. A regression in either the writer or the replier produces a mismatch. Comparing a value against itself (e.g. derived state read, killed, read again) tests nothing.

**3. Inject a deterministic crash-truncated tail when random kill timing is not reliable.**
A random `process.kill()` lands mid-write probabilistically. When the property under test is the journal-repair path (truncate the malformed trailing line, restore the last complete event), inject a manual truncated tail in the test setup when the random kill did not produce one. The whole test suite must exercise the repair path on every run, not on most runs.

**4. Treat exit-0 as secondary evidence — completion tails flake.**
A test that asserts the driver exited `0` after resume is fragile: the completion path can flake for unrelated reasons (daemon delay, file-system race). The byte-identical state assertion is the primary evidence; exit-0 is a secondary check. When the completion tail flakes, the state assertion still holds and the test fails for the right reason (state mismatch), not the flaky reason (non-zero exit).

**5. Gate live-daemon E2E on CLI availability so CI without the daemon skips rather than fails.**
Any E2E test that spawns a real adapter against a live daemon must wrap its `it(...)` in `it.runIf(paseoCliAvailable())(...)` (or a `describe` block) so a CI host without the binary/daemon skips the test instead of failing the suite. The helper belongs in the harness, not inlined per test, so adding the gate is one line per test. Unit tests that inject the adapter are unaffected — they run everywhere.

## Why This Matters

A system that claims crash-recovery but has never been killed mid-run is making an untested claim. A kill drill that only tests the happy path (random kill lands cleanly, resume proceeds) is testing the common case and silently skipping the edge case (kill mid-write, malformed trailing line) that is the actual failure mode a crash produces. A live-daemon E2E suite that fails when the daemon is absent is a CI liability — every developer who runs the suite without the daemon gets a red build that is not their fault.

The byte-identical assertion is the proof that the durable record is the state of record, not a hint. Without it, the system can drift: the writer and the replayer evolve independently, a refactor changes one, and the drift is invisible until a real crash exposes it — by which point the recovery contract has been silently broken for months.

This is the same crash-recovery discipline Miah itself institutionalizes one level down: `dispatch_intent` is journaled before the adapter call; result envelopes are read from disk after termination; the supervisor's derived state is reconstructed from the journal on every invocation. The kill drill is the proof that the disk-first invariant (sibling `disk-first-paseo-loop.md`) holds under the failure mode it is designed for.

## When to Apply

- Any system whose central correctness property is crash-recovery (resume is the only implementation).
- Any durable journal with replay — stage the drill at the journal layer.
- Any dispatch pipeline with intent-reconciliation — stage the drill at the dispatch layer.
- Any driver loop that resumes after its own death — stage the drill end-to-end.
- Any E2E suite that spawns a real CLI against a live daemon — gate on CLI availability for CI resilience.

## Examples

**Wrong way:**
- A single end-to-end kill test with `process.kill()` and an `expect(exit_code).toBe(0)` assertion — proves the happy path, not the recovery contract.
- A byte-identical assertion that compares derived state against itself (read, kill, read again) — tests nothing.
- Random kill timing with no deterministic-injection fallback — the repair path is exercised probabilistically.
- E2E tests that spawn the real daemon without a CLI-availability gate — every CI host without the daemon gets a red build.

**Right way (from the Miah v1 build):**
- `test/kill-drill-v1.test.ts:166-178` — injects a manual crash-truncated tail when the random kill does not produce one, so the journal-repair path is deterministic.
- `test/kill-drill-v1.test.ts:208-218` — `expect(serialize(replayFromSnapshot(raw))).toEqual(serialize(expected))` comparing the raw journal prefix against the reconstructed derived state. Independent artifacts.
- `test/e2e/kill-drill.test.ts` (U10, commit `d311fc4`) — `miah start`, `miah run`, kill mid-dispatch at U2, `miah run --once` → byte-identical state, intent reconciled, continue to completion.
- `test/e2e/helpers/e2e-harness.ts:177-184` — `paseoCliAvailable()` helper; applied to all four E2E files after the code review's L1 finding (fix commit `420f23b`).
- Audit file `docs/plans/2026-08-06-003-miah-implementation-plan.audit.md` "Kill-drill milestones" section — v1 at U3, v2 at U5, v3 at U10, each with its bar cited from the plan.