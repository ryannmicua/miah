---
mode: reference
verified: 2026-08-09
---

# Run-Phase FSM — Reference

This is a **reference** document: exact values only. For the conceptual walkthrough — why these phases exist and how transitions are driven — see [state-machine](./state-machine.md). Terminology follows [`CONCEPTS.md`](../../CONCEPTS.md).

## Run phases

Source: `src/fsm.ts:37-46` (`RUN_PHASES`); meanings per `PLAN:KTD14`.

| Phase | Meaning (KTD14) | Journaled on | Reached by |
|---|---|---|---|
| `Admitting` | Preflight + substrate probe + lease acquisition | no `phase_transition` — the admission gate itself (represented by `run_start`) | admission (`src/admission.ts:203`) |
| `Ready` | Lease held, units parsed, no work dispatched yet | `phase_transition` | sentinel/`Admitting`/`Stopping` → `Ready` (`src/driver.ts:378-384`) |
| `Implementing` | Builder(s) dispatched for eligible units | `phase_transition` | first dispatch (`src/step.ts:478`); any step with in-flight work (`src/step.ts:567-568`) |
| `Reviewing` | Tester/reviewer dispatched for a frozen candidate | `phase_transition` | terminated builder poll (`src/step.ts:550`); step with a harvested candidate (`src/step.ts:569-570`) |
| `AwaitingApproval` | All units accepted, approval package written, awaiting operator | `phase_transition` | all units accepted (`src/step.ts:565-566`; `src/driver.ts:417-420`) |
| `Attention` | Escalation raised, run paused, awaiting operator resolve | `phase_transition` | any escalation (`src/step.ts:561-562`, `src/driver.ts:436-437`) |
| `Stopping` | Operator issued stop, terminating in-flight, releasing lease | `phase_transition` | stop flag honored (`src/driver.ts:226`) |
| `Complete` | Operator approved, run terminated | `phase_transition` | `miah approve` (`src/commands/approve.ts:72`) |

The pre-transition sentinel phase produced by replay before any event is `"not-started"` (`src/replay.ts:18`, re-exported as `INITIAL_PHASE_SENTINEL` at `src/fsm.ts:66`).

## Transition legality

Source: `src/fsm.ts:54-63` (`PHASE_TRANSITIONS`), `src/fsm.ts:92-110` (`isValidTransition`).

**Normal transitions (static adjacency):**

| From | To |
|---|---|
| `Admitting` | `Ready` |
| `Ready` | `Implementing` |
| `Implementing` | `Reviewing` |
| `Reviewing` | `Implementing`, `AwaitingApproval` |
| `AwaitingApproval` | `Complete` |
| `Attention` | `Ready` |
| `Stopping` | `Ready` |
| `Complete` | — (terminal) |

**Special rules (state-aware or phase-independent):**

| Transition | Condition | Source |
|---|---|---|
| any → `Attention` | always legal (escalation) | `src/fsm.ts:99` |
| any → `Stopping` | always legal (operator stop) | `src/fsm.ts:99` |
| sentinel → `Admitting` / `Ready` / `Attention` / `Stopping` | sentinel may only open the machine or pause it | `src/fsm.ts:96-98` |
| `AwaitingApproval` → `Ready` | legal **only** when `state` shows rework-marked units (`hasReworkMarkedUnits`: any unit status `rework` or `not_started`) | `src/fsm.ts:106-108`, `src/fsm.ts:76-80` |
| from === to | no-op; no event journaled | `src/fsm.ts:93-94` |

`transitionPhase` throws on an invalid transition rather than corrupting phase history (`src/fsm.ts:127-129`); `ensurePhase` uses the store's current reconstructed phase as `from` and is idempotent (`src/fsm.ts:138-141`).

## Unit statuses

Source: `src/types.ts:241` (`UnitStatus`), `src/replay.ts:297-321` (`computeBlocked`).

| Status | Meaning |
|---|---|
| `not_started` | no dispatch attempt recorded, dependencies not (yet) blocking |
| `in_flight` | a dispatch intent is open for the unit |
| `accepted` | terminal acceptance decision `accept` recorded |
| `rework` | `rework_started` recorded; unit is dispatch-eligible again |
| `blocked` | derived (not journaled): a `not_started` unit with an unaccepted dependency |

Eligibility for dispatch: status `not_started` or `rework`, no in-flight intent, every declared dependency `accepted` (`src/step.ts:179-202`).

## Journal event types

Source: `src/types.ts:198-225` (`JOURNAL_EVENT_TYPES`). Each event is `{seq, type, timestamp, ...payload}` (`src/types.ts:233-238`).

| Event type | Purpose |
|---|---|
| `run_start` | admission opened the run (run_id, plan_hash) |
| `lease_acquired` / `lease_renewed` / `lease_released` | lease audit trail (R35, R40) |
| `journal_snapshot` | reserved snapshot marker |
| `dispatch_intent` | intent journaled before adapter launch (R36-R37) |
| `dispatch_created` | observed identity: agent_id, workspace_id, base_commit (A6) |
| `dispatch_failed` | adapter launch failed (named reason) |
| `dispatch_terminated` | dispatch closed (outcome: success / envelope-missing / deadline-exceeded / stopped / amended) |
| `reconcile_record` | reconciliation decision journaled before the follow-up (R38) |
| `evidence_harvested` | harvest event with artifact refs/hashes, custody prev/last hash (R45) |
| `custody_continuity_record` | T2-T3 dual-hash record (R46) |
| `result_envelope_observed` | envelope read at harvest (R43) |
| `acceptance_decision` | unit verdict: `accept` / `not_accepted` (+ route, reason, criteria) |
| `gap_recorded` | open an evidence gap (unit, criterion, reason) |
| `gap_closed` | close a gap (unit, criterion, close_reason) |
| `rework_started` | mark a unit for re-dispatch (bounded rework) |
| `escalation_raised` | operator-attention condition (stable `esc-<seq>` id) |
| `escalation_resolved` | operator closed an escalation |
| `operator_decision` | operator action: stop / resolve / approve / reject / amend |
| `amendment_applied` | change order applied (new_hash, version, changed/affected units) |
| `phase_transition` | FSM move (from, to) |
| `run_terminal` | terminal outcome: `complete` / `rejected` |

## Escalation triggers

Source: `src/escalation.ts:23-54` (`ESCALATION_TRIGGERS`).

`repeatedly-fails`, `no-progress`, `max-takes-exceeded`, `max-rework-cycles-exceeded`, `scope-change-needed`, `security-risk`, `destructive-side-effect`, `unresolved-high-severity-failure`, `missing-access-or-judgment`, `cost-ceiling-exceeded`, `no-checker-profile-clears-calibration-bar`, `blocked-no-eligible-work`.

Raised from: `src/step.ts:346-361` (`repeatedly-fails`), `src/step.ts:419-427` (`cost-ceiling-exceeded`), `src/step.ts:527-535` (`no-progress`), `src/driver.ts:431-436` (`blocked-no-eligible-work`), `src/acceptance.ts:171-182` (calibration/operator-judgment triggers). Note: the two specific R82 triggers `max-takes-exceeded` / `max-rework-cycles-exceeded` are declared for conformance but the step function raises the umbrella `repeatedly-fails` (`src/escalation.ts:24-31`).

## Gap close reasons

Source: `src/gap.ts:19-24` (`GAP_CLOSE_REASONS`). `rework-take`, `re-verification-success`, `operator-approval`, `deadline-still-in-effect-cleared`.

## Driver result statuses and exit codes

Source: `src/driver.ts:98-112` (`DriverStatus` / `DriverResult`), `src/commands/run.ts:106-108`.

| Driver status | Meaning | `miah run` exit code |
|---|---|---|
| `complete` | all units accepted (AwaitingApproval) or approved (Complete) | 0 |
| `advanced` | `--once` step advanced | 0 |
| `stopped` | stop honored, lease released | 0 |
| `attention` | run paused in Attention (escalation) | 1 |
| `lease-held` | another driver holds a fresh lease | 1 |

All command-level error/refusal constants are 1: `ADMISSION_FAILURE_EXIT_CODE` (`src/commands/start.ts:17`), `RUN_BLOCKED_EXIT_CODE` (`src/commands/run.ts:18`), `PREFLIGHT_FAILURE_EXIT_CODE` (`src/commands/preflight.ts:19`), `STATUS_ERROR_EXIT_CODE` (`src/commands/status.ts:34`), `STOP_ERROR_EXIT_CODE` (`src/commands/stop.ts:25`), `RESOLVE_ERROR_EXIT_CODE` (`src/commands/resolve.ts:27`), `APPROVE_ERROR_EXIT_CODE` (`src/commands/approve.ts:19`), `REJECT_ERROR_EXIT_CODE` (`src/commands/reject.ts:19`), `AMEND_ERROR_EXIT_CODE` (`src/commands/amend.ts:38`). `miah list` always returns 0 (`src/commands/list.ts:35-53`). Any thrown command error becomes exit 1 via `runGuarded` (`src/commands/index.ts:37-62`).

## Terminal outcomes

| Outcome | Trigger | Event |
|---|---|---|
| `complete` | `miah approve` (guarded on all-units-accepted, `src/commands/approve.ts:56-60`) | `operator_decision: approve`, `phase_transition: Complete`, `run_terminal: complete` |
| `rejected` | `miah reject --end` | `operator_decision: reject`, `run_terminal: rejected` |
