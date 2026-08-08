---
title: Miah Implementation Plan - Audit Criteria
type: audit
date: 2026-08-07
topic: miah-implementation
audit_for: builder
plan_source: docs/plans/2026-08-06-003-miah-implementation-plan.md
derivation: derived solely from the plan (Goal Capsule, Requirements, Implementation Units, Verification Contract, Definition of Done); no criteria invented outside the plan
---

# Miah Implementation Plan — AUDIT FILE

**For auditors only.** This file converts the implementation plan's exit bars into checkable criteria an audit agent uses to measure builder agents' work. It adds nothing to the plan; every criterion cites its plan source. If a criterion contradicts plan text, the plan wins — escalate the drift to the operator, do not resolve it.

## How to use this file

1. Audit per unit, in plan sequence (U1 → U10). Never audit a unit whose `depends-on` unit is not yet accepted.
2. Evidence only, never agent prose. A builder's self-report is an input, not a fact (plan: Product Contract, Evidence and acceptance). Checkable evidence: diffs, exit codes, test outputs, file existence, command runs.
3. Verdict per criterion: `PASS` (evidence shown) or `FAIL` (evidence missing or contradicts). No partials; a gap in evidence is a FAIL.
4. A unit is **accepted only when** all its criteria PASS, its `creates:` files exist and are functional, and its Test Scenarios + Verification line pass (plan: Definition of Done — Per-unit).
5. Record each verdict with the evidence pointer. A FAIL must name the criterion and the missing/contradicting evidence.
6. Two consecutive FAIL verdicts on the same unit, or a broken dependency, stop the audit and go to the operator (dispatch loop rule).

## Sources of truth

- Requirements R1-R21: carried forward verbatim from `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md` (superseded_by 003, content authoritative).
- Requirements R22-R62: carried forward verbatim from `docs/plans/2026-08-06-002-feat-miah-artifacts-plan.md` (superseded_by 003, content authoritative).
- Requirements R63-R90, D6/D7/D8, KTD1-18, units, Verification Contract, Definition of Done: `docs/plans/2026-08-06-003-miah-implementation-plan.md`.

**Freeze rule for auditors:** R1-R62 are carried forward without modification. A builder that modifies, weakens, or amends any carried-forward requirement is a FAIL on the unit and an escalation, not a patch.

---

## G0. Global exit bar (audit the whole run against these)

Source: Goal Capsule Stop Conditions; Verification Contract; Definition of Done — Global.

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| G0.1 | Every requirement R1-R90 implemented and traceable to a unit | Walk R1-R90 against unit requirement lists (U1-U10); each R appears in ≥1 unit | DOD Global; Unit Index |
| G0.2 | `npm run build` compiles without errors | Run it; exit 0 | DOD Global; U1 Verification |
| G0.3 | `npm test` passes, including all e2e and kill-drill tests | Run it; exit 0 | DOD Global; Verification Contract |
| G0.4 | `miah preflight` works standalone on a test CE plan | Green verdict on `test/fixtures/test-plan.md`; structured failures on `test/fixtures/test-plan-bad.md` | DOD Global; Verification Contract |
| G0.5 | `miah start` fails closed when Paseo per-agent `max-duration` is absent, against the live daemon | Real-probe admission test; message names the missing mechanism | DOD Global; U4; R57 |
| G0.6 | Kill drill passes: kill mid-run → resume → byte-identical supervisor-derived state (R42, R90). **Non-negotiable** | `npm test -- --grep "kill-drill"` passes; assert byte-identical state incl. intent-without-created and dead-past-deadline cases | DOD Global; Verification Contract; U10 |
| G0.7 | Deadline-past-death refusal test passes (R5) | `npm test -- --grep "deadline"`; resume refuses work past deadline | DOD Global; U10 |
| G0.8 | All D7 thresholds configurable via `~/.miah/config.json` with documented defaults; config read at admission and snapshotted into manifest (R80) | Inspect config.ts defaults (K=50, heartbeat 30s, TTL 60s, max-duration 15m, max-takes 3, max-rework 2, concurrency 1, no-progress 3, calibration bar) and manifest snapshot | DOD Global; R71-R82; U1 |
| G0.9 | CLI installable via `npm install -g` or `npm link`; runs on Windows 10 + Git Bash; no POSIX-only primitives load-bearing (R84) | `test/portability/no-posix-only.test.ts` passes (no `flock`, `mkfifo`, `SIGTERM`/`SIGKILL`, `kill(` with PID in load-bearing `src/**` code) | DOD Global; R84; U1 |
| G0.10 | Abandoned-attempt code removed from the diff | Diff review: no experimental dead code | DOD Global |
| G0.11 | README updated to reflect Phase 3 completion — **after operator approval only** | Absence of this update is NOT a builder FAIL during unit audits | DOD Global |

---

## Per-unit criteria

### U1. CLI Skeleton and Configuration (depends-on: —)

Source: plan U1 section. Requirements: R1, R63, R80, R83, R84, R70.
`creates:` `package.json`, `tsconfig.json`, `src/index.ts`, `src/config.ts`, `src/commands/index.ts`, `src/types.ts`, `test/portability/no-posix-only.test.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U1.1 | `npm run build` compiles without errors | Run it | U1 Verification |
| U1.2 | `npm test -- --grep "cli"` passes | Run it | U1 Verification |
| U1.3 | `miah --help` renders the full command surface: preflight, start, run, status, stop, resolve, approve, reject, amend, list | Run `miah --help`; all 10 present | U1 Test Scenarios; R63 |
| U1.4 | `miah --version` prints the version | Run it | U1 Test Scenarios |
| U1.5 | `miah preflight --help` shows preflight usage | Run it | U1 Test Scenarios |
| U1.6 | Config file created with defaults on first run if absent; overrides from `~/.miah/config.json` applied | Test output; inspect config.ts | U1 Test Scenarios; R80 |
| U1.7 | All file paths use `path.join` / cross-platform APIs, not hardcoded separators | Code scan | U1 Test Scenarios; R84 |
| U1.8 | Portability scan asserts no load-bearing POSIX-only primitives in `src/**` | `npm test -- --grep "portability"` | U1 Test Scenarios; R84 |
| U1.9 | CLI requires no network access, no daemon installation, no system-level setup; runs from any directory referencing a target worktree; all durable state in `~/.miah/` | Code review of index.ts/config.ts | R70 |

### U2. Plan Parser and Preflight (depends-on: U1)

Source: plan U2 section. Requirements: R22-R30, R55-R60.
`creates:` `src/parser.ts`, `src/preflight.ts`, `src/snapshot.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U2.1 | `npm test -- --grep "preflight"` passes | Run it | U2 Verification |
| U2.2 | `npm test -- --grep "parser"` passes | Run it | U2 Verification |
| U2.3 | `miah preflight test/fixtures/valid-plan.md` returns a green verdict | Run it | U2 Verification |
| U2.4 | `miah preflight test/fixtures/bad-plan.md` returns structured failures by class and offending unit ID | Run it | U2 Verification; U2 Approach |
| U2.5 | Valid 3-unit plan with correct dependencies → no failures | Test output | U2 Test Scenarios |
| U2.6 | Missing `creates:` → structural failure naming the unit | Test output | U2 Test Scenarios; R56(a) |
| U2.7 | Cyclic `depends-on` (U1→U2→U1) → structural failure naming both | Test output | U2 Test Scenarios; R56(a) |
| U2.8 | `inputs:` not created by a transitive ancestor → referential failure | Test output | U2 Test Scenarios; R56(b) |
| U2.9 | Cross-unit `creates:` conflict → referential failure (R30) | Test output | U2 Test Scenarios; R30 |
| U2.10 | Acceptance criterion missing `tier:` → verifiability failure | Test output | U2 Test Scenarios; R56(c) |
| U2.11 | `execution: knowledge-work` plan handled (preflight flags; admission is a separate gate) | Test output | U2 Test Scenarios |
| U2.12 | Preflight is a pure function: no lease, no journal, no run state required | Code review; standalone invocation works | U2 Test Scenarios; U2 Approach |
| U2.13 | Snapshot: canonicalized content, out-of-tree path, SHA-256 hash computed | Code review of snapshot.ts + test | U2 Approach |

### U3. Run Store, Journal, and Lease (depends-on: U1, U2)

Source: plan U3 section. Requirements: R15, R31-R42.
`creates:` `src/run-store.ts`, `src/journal.ts`, `src/lease.ts`, `src/replay.ts`, `src/manifest.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U3.1 | `npm test -- --grep "journal"` passes | Run it | U3 Verification |
| U3.2 | `npm test -- --grep "lease"` passes | Run it | U3 Verification |
| U3.3 | **Kill drill v1 passes** — append events, `process.kill()` mid-append, resume → byte-identical state, no lost/duplicate events | `npm test -- --grep "kill-drill"` at journal level; the test establishing D1's central claim | U3 Verification; U3 Test Scenarios; A2 |
| U3.4 | Append 100 events; replay reconstructs all statuses correctly | Test output | U3 Test Scenarios |
| U3.5 | Snapshot at seq 50; replay from snapshot reconstructs state identically to full replay (K=50 cadence, R41) | Test output | U3 Test Scenarios; R71 |
| U3.6 | Lease: holder B fails to acquire while holder A heartbeats | Test output | U3 Test Scenarios; R39 |
| U3.7 | Lease: after TTL (60s) + one failed renewal attempt, holder B acquires — never by stealing a fresh-heartbeat holder | Test output | U3 Test Scenarios; R72 |
| U3.8 | Concurrent append from a non-lease-holder fails (single-writer serialization, R15) | Test output | U3 Test Scenarios; R15 |
| U3.9 | `lease.lock` survives restart; resume reads it for the current holder | Test output | U3 Test Scenarios |
| U3.10 | Journal: malformed trailing line (crash mid-write) validated and truncated on replay, restoring last complete event | Test output / code review of replay.ts | U3 Approach |
| U3.11 | Lease uses temp-write-then-rename; journal uses append-not-replace (atomicity distinction correct) | Code review | U3 Approach; KTD2 |

### U4. Substrate Probe and Paseo Adapter (depends-on: U1, U2)

Source: plan U4 section. Requirements: R4-R5, R17-R19, R21, R57, R86-R87.
`creates:` `src/adapter/paseo.ts`, `src/substrate-probe.ts`, `src/admission.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U4.1 | `npm test -- --grep "adapter"` passes | Run it | U4 Verification |
| U4.2 | `npm test -- --grep "admission"` passes | Run it | U4 Verification |
| U4.3 | `npm test -- --grep "substrate"` passes | Run it | U4 Verification |
| U4.4 | **Admission fails closed against the live daemon** with a message naming the missing `max-duration` mechanism (R4/R5, R86) | Real-probe admission test; the test that keeps R4/R5 honest | U4 Verification; U4 Test Scenarios |
| U4.5 | Probe reports `max-duration: absent` and `mcp_injection: unscopable` (with `injectIntoAgents: true`) against live daemon | Test output | U4 Test Scenarios |
| U4.6 | Admission fails closed with a message naming the MCP injection issue and the operator workaround (R87, KTD5) | Test output | U4 Test Scenarios; R87 |
| U4.7 | Adapter `launch` creates agent via `paseo run --background --provider <p> --model <m> --new-workspace worktree --worktree-mode branch-off --title <t> <prompt>` and returns agent id | Test output / code review | U4 Test Scenarios; D2-a |
| U4.8 | Adapter `status` queries `paseo inspect --json <id>` and returns lifecycle | Test output | U4 Test Scenarios; D2-a |
| U4.9 | Adapter `stop` calls `paseo agent stop <id>` | Test output | U4 Test Scenarios; D2-a |
| U4.10 | Post-termination immutability probe records its finding (present or absent) in the manifest — admission does NOT fail on immutability absence, but records a caveat (R46) | Test output / manifest inspection | U4 Test Scenarios; KTD4 |
| U4.11 | `SubstrateProbe` is behind an injectable interface so U10 can substitute the fake | Code review of substrate-probe.ts | U4 Approach; KTD9 |
| U4.12 | Probe re-verifies Paseo CLI contracts against the current live daemon version (v0.3.0-beta.2) | Probe code inspects live `paseo run --help` / `paseo agent update --help` | R86; KTD4 re-verification note |

### U5. Dispatch Pipeline (Thin) (depends-on: U3, U4)

Source: plan U5 section. Requirements: R7-R11, R13, R16, R17, R36-R37.
`creates:` `src/dispatch.ts`, `src/packet.ts`, `src/envelope.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U5.1 | `npm test -- --grep "dispatch"` passes | Run it | U5 Verification |
| U5.2 | **Kill drill v2 passes** — kill after `dispatch_intent` before `dispatch_created`; resume → adapter queried → no handle → `dispatch_failed` → rework | `npm test -- --grep "kill-drill"` at dispatch level; validates R37 reconciliation | U5 Verification; U5 Test Scenarios |
| U5.3 | Dispatch intent journaled BEFORE adapter call (assert by seq order) | Test output | U5 Test Scenarios; R17 |
| U5.4 | Adapter call fails → `dispatch_failed` journaled with reason | Test output | U5 Test Scenarios |
| U5.5 | Result envelope absent at harvest → recorded as evidence gap, not auto-failure or auto-completion (R43) | Test output | U5 Test Scenarios; R43 |
| U5.6 | Kill after `dispatch_created` before `dispatch_terminated`; resume → adapter queried → handle found → status checked → harvest if terminal, resume polling if live | Test output | U5 Test Scenarios; R36-R37 |
| U5.7 | `dispatch_created` records base commit from git, not from the packet (A6) | Test output / code review | U5 Test Scenarios; A6 |
| U5.8 | Dispatch packet: objective, plan excerpt, output schema, authority bounds, `creates:`/`inputs:` declaration, result envelope path | Code review of packet.ts | U5 Approach |
| U5.9 | `dispatch_intent` carries sender role, unit id, take number, idempotency key, packet hash, deadline, provider/model per D8-i | Code review / journal event shape | U5 Approach; D8-i |
| U5.10 | Independence: dispatch is a fresh specialist session with dedicated worktree, no builder context (R7-R11) | Adapter launch params; worktree-per-specialist | U5 Approach; R7-R11 |

### U6. Evidence Harvest, Custody, and Postflight (depends-on: U3, U5)

Source: plan U6 section. Requirements: R43-R46, R52, R53, R61, R85.
`creates:` `src/evidence.ts`, `src/custody.ts`, `src/postflight.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U6.1 | `npm test -- --grep "evidence"` passes | Run it | U6 Verification |
| U6.2 | `npm test -- --grep "custody"` passes | Run it | U6 Verification |
| U6.3 | `npm test -- --grep "postflight"` passes | Run it | U6 Verification |
| U6.4 | Harvest includes: diff file, test output file, usage delta JSON, envelope JSON | Test output / evidence dir inspection | U6 Test Scenarios; U6 Approach |
| U6.5 | Custody chain: each header's `prev_hash` equals the previous header's `content_hash`; header = `(role, agent_id, attempt, take, harvest_ts, content_hash, prev_hash)` | Test output; inspect custody records | U6 Test Scenarios; R85 |
| U6.6 | Broken custody chain (header deleted) → evidence gap recorded | Test output | U6 Test Scenarios; R45 |
| U6.7 | T2-T3 continuity: workspace hash same at harvest and integration → no gap; different → `gap_recorded: T2-T3-continuity` (dual-hash, R46) | Test output | U6 Test Scenarios; R46 |
| U6.8 | Postflight: builder declares `creates: ["src/foo.py"]` but file absent → `gap_recorded: missing-declared-output` (R61) | Test output | U6 Test Scenarios; R61 |
| U6.9 | Postflight: all `creates:` present → no gap | Test output | U6 Test Scenarios |
| U6.10 | Test code not in `creates:` harvested as evidence, stored in evidence dir, not integrated (R53) | Test output; evidence layout | U6 Test Scenarios; R53 |

### U7. Acceptance, Grading, and Gaps (depends-on: U3, U6)

Source: plan U7 section. Requirements: R28, R47-R51, R54, R74.
`creates:` `src/acceptance.ts`, `src/grading.ts`, `src/calibration.ts`, `src/gap.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U7.1 | `npm test -- --grep "acceptance"` passes | Run it | U7 Verification |
| U7.2 | `npm test -- --grep "gap"` passes | Run it | U7 Verification |
| U7.3 | `npm test -- --grep "grading"` passes | Run it | U7 Verification |
| U7.4 | `npm test -- --grep "integration"` passes | Run it | U7 Verification |
| U7.5 | All criteria pass at deterministic tier → `accept` | Test output | U7 Test Scenarios |
| U7.6 | Criterion at `calibrated-judge` with uncalibrated reviewer → verdict is ungraded → escalate (R48/R20) | Test output | U7 Test Scenarios; R48 |
| U7.7 | Criterion at `calibrated-judge` with calibrated reviewer (bar cleared) → verdict authoritative → accept if pass | Test output | U7 Test Scenarios; R74 |
| U7.8 | Calibration bar implemented per R74: ≥15-case corpus, >14/15 agreement, ≤2 false-blocks, zero false-pass floor (non-negotiable); thresholds configurable | Code review of calibration.ts; config fields | R74 |
| U7.9 | Open gap on a criterion → `not_accepted` regardless of evidence | Test output | U7 Test Scenarios |
| U7.10 | `gap_closed` for the criterion → re-evaluate acceptance | Test output | U7 Test Scenarios |
| U7.11 | `gap_recorded(unit, criterion, reason)` pairs with `gap_closed(unit, criterion, close_reason)` | Code review of gap.ts | U7 Approach |
| U7.12 | Integration self-containedness (R54): `creates: ["src/foo.py"]` imports undeclared `src/_helper.py` → verification fails → `gap_recorded: integration-smuggle` | Test output | U7 Test Scenarios; R54 |
| U7.13 | Integration check all good → pass → `accept` | Test output | U7 Test Scenarios |
| U7.14 | Human tier: `escalation_raised` → `miah resolve` | Code review / test | U7 Approach |

### U8. Run-Phase FSM and Step Function (depends-on: U2, U3, U4, U5, U6, U7)

Source: plan U8 section. Requirements: R1-R3, R12, R14, R71-R82.
`creates:` `src/step.ts`, `src/fsm.ts`, `src/driver.ts`, `src/escalation.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U8.1 | `npm test -- --grep "fsm"` passes | Run it | U8 Verification |
| U8.2 | `npm test -- --grep "step"` passes | Run it | U8 Verification |
| U8.3 | `npm test -- --grep "driver"` passes | Run it | U8 Verification |
| U8.4 | One unit through full cycle: admit → ready → implement → review → accept → awaitingApproval | Test output | U8 Test Scenarios |
| U8.5 | Two units, U2 depends on U1: U1 accepted unlocks U2; U2 dispatches after U1 (dependency gating, R14) | Test output | U8 Test Scenarios; R14 |
| U8.6 | Two independent units, cap=1: U1 runs, finishes, then U2 runs (sequential; mechanism supports N) | Test output | U8 Test Scenarios; R75 |
| U8.7 | No-progress: 3 polls with no activity change → `escalation_raised: no-progress` → Attention (R76; no claim across downtime gap) | Test output | U8 Test Scenarios; R76 |
| U8.8 | Max takes exceeded: 3rd take fails → `escalation_raised: repeatedly-fails` (R77-R79) | Test output | U8 Test Scenarios; R77 |
| U8.9 | Stop requested: `stop-requested` flag seen at step boundary → terminate in-flight → Stopping → lease released (R65) | Test output | U8 Test Scenarios; R65 |
| U8.10 | `miah run --once` advances one step and exits; next `--once` continues | Test output | U8 Test Scenarios; D6-a |
| U8.11 | Step function order: reconstruct state → reconcile intents (R37) → evaluate budget predicates (R81) → find eligible units → dispatch → poll → harvest → accept → integrate → transition phase | Code review of step.ts | U8 Approach |
| U8.12 | FSM phases implemented: Admitting, Ready, Implementing, Reviewing, AwaitingApproval, Attention, Stopping, Complete (KTD14) | Code review of fsm.ts | KTD14 |
| U8.13 | Escalation triggers include: takes exceeded, rework exceeded, no-progress, scope/requirements change needed, security/privacy/legal/data-loss risk, destructive side effect, unresolved high-severity failure, missing access/credentials/judgment, cost ceiling, no calibrated checker (R82) | Code review of escalation.ts | R82 |
| U8.14 | Rework bound: max 2 rework cycles → `escalation_raised: repeatedly-fails` (R78); budgets route to escalation or stop, never silent skip (R81) | Test output | R78, R81 |

### U9. Operator Interface (depends-on: U3, U8)

Source: plan U9 section. Requirements: R63-R70.
`creates:` `src/commands/status.ts`, `src/commands/stop.ts`, `src/commands/resolve.ts`, `src/commands/approve.ts`, `src/commands/reject.ts`, `src/commands/amend.ts`, `src/commands/list.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U9.1 | `npm test -- --grep "status"` passes | Run it | U9 Verification |
| U9.2 | `npm test -- --grep "stop"` passes | Run it | U9 Verification |
| U9.3 | `npm test -- --grep "resolve"` passes | Run it | U9 Verification |
| U9.4 | `npm test -- --grep "approve"` passes | Run it | U9 Verification |
| U9.5 | `npm test -- --grep "amend"` passes | Run it | U9 Verification |
| U9.6 | `miah status` on a multi-unit run renders: phase, per-unit state (accepted/in-flight/rework/blocked/not-started), open gaps with `(unit, criterion, reason)`, pending escalations, usage totals, lease holder/heartbeat (R64) | Run against a seeded run; inspect output | U9 Test Scenarios; R64 |
| U9.7 | `miah stop` appends `operator_decision: stop` + sets `stop-requested`; subsequent `miah run` honors it (terminates in-flight, Stopping, release lease); stop while no driver alive honored on next run (R65) | Test output | U9 Test Scenarios; R65 |
| U9.8 | `miah resolve` appends `operator_decision: resolve` + `escalation_resolved`; next `miah run` sees it and re-dispatches (R69, F14) | Test output | U9 Test Scenarios; F14 |
| U9.9 | `miah approve` on all-accepted run writes `run_terminal: complete` (R67) | Test output | U9 Test Scenarios; R67 |
| U9.10 | `miah reject --end` writes `run_terminal: rejected` | Test output | U9 Test Scenarios |
| U9.11 | `miah reject --rework <unit-ids>` marks specified units for re-dispatch without terminating the run | Test output | U9 Test Scenarios |
| U9.12 | `miah amend` with plan changing U2's `creates:` → new snapshot, `amendment_applied`, U2 marked for re-dispatch, U1 preserved; original snapshot never mutated (R68, KTD16) | Test output | U9 Test Scenarios; R68 |
| U9.13 | `miah amend` with dependency chain (U3 depends on U2, U2 changes) → U2 AND transitive-dependent U3 marked for re-dispatch | Test output | U9 Test Scenarios; R68 |
| U9.14 | `miah list` shows all runs in `~/.miah/runs/` | Run it | U9 Test Scenarios |
| U9.15 | All operator actions journaled with identity, timestamp, decision, optional note (R69) | Journal event inspection | U9 Test Scenarios; R69 |
| U9.16 | Approval package written to `~/.miah/runs/<run-id>/approval-package.json`: per-unit evidence pointers, acceptance records, gap close reasons, usage totals, snapshot hash, run duration (R67) | Inspect package after all-accepted run | R67 |

### U10. End-to-End Integration and Kill Drill (depends-on: U1-U9)

Source: plan U10 section. Requirements: R2-R3, R5, R6, R42, R57, R90, R63-R70.
`creates:` `test/e2e/kill-drill.ts`, `test/e2e/full-run.ts`, `test/e2e/deadline-refusal.ts`, `test/e2e/substrate-fail-closed.ts`, `test/fixtures/test-plan.md`, `test/fixtures/test-plan-bad.md`, `test/fixtures/fake-substrate-probe.ts`

| # | Criterion | How to verify | Plan source |
|---|---|---|---|
| U10.1 | `npm test -- --grep "e2e"` passes | Run it | U10 Verification |
| U10.2 | **Kill drill (first-class milestone) passes**: `miah start`, `miah run`, kill mid-dispatch at U2, `miah run --once` → byte-identical state, intent reconciled, continue to completion. This gives D1's "resume is the only implementation" its teeth | `npm test -- --grep "kill-drill"` | U10 Verification; U10 Test Scenarios; DOD Global |
| U10.3 | Deadline-past-death refusal passes: deadline expired during outage → resume → specialist terminated → work refused → `gap_recorded: deadline-exceeded` (R5) | `npm test -- --grep "deadline"` | U10 Test Scenarios; R5 |
| U10.4 | Substrate fail-closed passes against the live daemon (real probe): `miah start` → max-duration absent → admission refused → no journal created | `npm test -- --grep "substrate-fail-closed"`; real probe only, never the fake | U10 Test Scenarios; R57 |
| U10.5 | Full run (fake probe, empty calibration corpora): admit → implement U1 → test → accept → U2 → U2 `calibrated-judge` escalates (no calibration) → operator resolves via `miah resolve --decision approve` → `escalation_resolved` → `gap_closed` → accept → U3 → accept → awaitingApproval → approve → complete | Test output | U10 Test Scenarios |
| U10.6 | Full run asserts: all units accepted, evidence harvested, integration completed, `approval-package.json` written | Test output | U10 Approach |
| U10.7 | `miah status` renders correct phase and unit states at each checkpoint | Test output | U10 Test Scenarios |
| U10.8 | `miah stop` stops the run cleanly; `miah run` resumes | Test output | U10 Test Scenarios |
| U10.9 | `miah amend` inserts a change order mid-run and continues | Test output | U10 Test Scenarios |
| U10.10 | Test CE plan fixture: 3 units — U1 creates `src/hello.ts`, U2 depends on U1 creates `src/greeter.ts`, U3 independent creates `config/app.json`; tiers declared (deterministic + one calibrated-judge) | Inspect `test/fixtures/test-plan.md` | U10 Approach |
| U10.11 | Fake probe is test-only: used for full-run and kill-drill; the substrate-fail-closed test uses the real probe; fake reports max-duration present, MCP scoped, immutability present | Code review of fixtures | U10 Approach; KTD9 |
| U10.12 | Integration completes per R89: checkout canonical worktree at base commit, copy only accepted `creates:` paths, run verification contract commands, commit integration; test code not in `creates:` not integrated | E2E output + commit inspection | R89; U10 Approach |

---

## Kill-drill milestones (audit these as the plan's spine)

| Milestone | Where | Bar | Source |
|---|---|---|---|
| Kill drill v1 (journal/lease level) | U3 | Kill mid-append, resume, byte-identical reconstructed state, no lost/duplicate events | U3 Verification |
| Kill drill v2 (dispatch level) | U5 | Kill after intent before created → adapter queried → `dispatch_failed` → rework; kill after created → reconcile → harvest or resume poll | U5 Verification |
| Kill drill v3 (full E2E) | U10 | Kill mid-run at U2, resume, byte-identical, continue to completion — the first-class milestone | U10 Verification; DOD Global |

## Honest limits — do NOT fail a builder for these

Source: plan "Honest limits" section and Goal Capsule. These remain unverifiable until the Paseo daemon ships features; Miah's end must be implemented and tested, Paseo's enforcement cannot be.

| Item | What the builder must have done | What cannot be tested | Source |
|---|---|---|---|
| Per-agent max-duration enforcement (R4/R5) | Probe honestly reports absent; admission fails closed; full pipeline E2E-tested via injected fake probe | Real daemon enforcement (feature unshipped) | Goal Capsule; KTD9; Honest limits |
| Post-termination workspace immutability (R46) | Probe records whatever the live daemon provides; T2-T3 dual-hash is the mitigation | Immutability guarantee itself | Honest limits; KTD4 |
| MCP injection per-agent scoping (R21) | Fail-closed admission gate tested | Per-agent scoping (absent in v0.3.0-beta.2); operator workaround is documented | Honest limits; KTD5 |

The fake-probe seam (`test/fixtures/fake-substrate-probe.ts`) is a sanctioned test-only injection point on the `SubstrateProbe` interface — its existence is a PASS (U10.11), never a FAIL.

## Sequencing check (audit order enforcement)

- U4 may be built in parallel with U2 (both depend on U1 only); U4's admission gate completes after U2 lands.
- U6, U7 depend on U5 (need dispatch before harvest/accept).
- U8 depends on all of U2-U7. U9 depends on U8. U10 depends on all.
- A builder that implements a dependent unit before its dependencies are accepted is a FAIL on sequencing (plan Sequencing §4, Phase 3 rule: execute sequentially, verifying each before advancing).

## Verdict summary template (per audit run)

```
Plan snapshot hash: <hash of 003 plan>
Auditor: <role/provider> | Date: <date>
G0: <PASS/FAIL per G0.1-G0.11 with evidence pointers>
U1: <per-criterion verdicts; unit verdict>
... U10
Kill-drill milestone status: v1 <PASS/FAIL> | v2 <PASS/FAIL> | v3 <PASS/FAIL>
Blockers / escalations: <anything violating a freeze rule, a dependency, or an honest-limit boundary>
```
