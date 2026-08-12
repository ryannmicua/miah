# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary from the Miah v1 implementation phase, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Run lifecycle

**Run-phase FSM** — The eight-phase finite-state machine that drives the supervisor loop: `Admitting`, `Ready`, `Implementing`, `Reviewing`, `AwaitingApproval`, `Attention`, `Stopping`, `Complete`. Transitions are journaled as `phase_transition` events (R35, R42) so the phase is always derivable from the durable record. Transition legality is state-aware, not just static adjacency — see `docs/solutions/patterns/state-aware-fsm-transition-guards.md`.

**AwaitingApproval** — The run-phase reached when all units have been accepted. The operator drives the exit: `miah approve` → `Complete`, `miah reject --rework <units>` → marks units for re-dispatch, `miah reject --end` → `rejected`. The `R67 resume` transition (`AwaitingApproval → Ready`) fires when the operator has marked units for rework at the gate — see `docs/solutions/patterns/state-aware-fsm-transition-guards.md`.

**Approval package** — The consolidated evidence summary written to the run directory at `AwaitingApproval`: per-unit evidence pointers, acceptance records, gap close reasons, usage totals, snapshot hash, run duration (R67). Its `gap_close_reasons` list is derived from `gap_closed` journal events — implicitly-closed gaps must be journaled explicitly or the package is incomplete (see `docs/solutions/patterns/explicit-gap-close-before-supersede.md`).

**Config snapshot** — The admission-time copy of the run's config, stored in the run manifest (R80). Dispatch reads the snapshot, not the live config file, so a run in progress keeps the config it was admitted with. See `dispatch.default_workspace` for a field that is read from the snapshot at dispatch time.

## Verification

**Kill drill** — The three-level crash-recovery verification pattern that proves "resume is the only implementation": v1 (journal/lease level, U3), v2 (dispatch level, U5), v3 (full E2E, U10). Each level kills the supervisor mid-run, resumes, and asserts byte-identical derived state. See `docs/solutions/patterns/kill-drill-byte-identical-resume-verification.md`.

**G-criteria** — Per-unit audit criteria derived from the plan into a checkable audit file. Each criterion cites its plan source and is verified by evidence (command output, file existence, code inspection) — never agent prose. Verdicts are binary: `PASS` (evidence shown) or `FAIL` (evidence missing or contradicts). See `docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md`.

**Cross-family verifier** — A checker dispatched on a different model family than the builder (e.g. builder on one family's flash model, tester on another vendor's model). Cross-family contrast is a hedge against shared-training blind spots, not the authority — calibration is the authority (R20). The builder's self-report is an input, not a fact.

**Verifier** — The specialist role that grades every acceptance criterion — deterministic and judgment — against the harvested evidence. Deterministic criteria are certified from the mechanical contract results (no calibration authority needed); judgment grades carry authority only when the verifier's profile clears the calibration bar. The operator grades criteria declared `human` tier or flagged by the verifier (VISION steps 5-7; `docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md`). Merged the former reviewer role; Miah runs the checks (sensor) but never grades.

**Verifier verdict** — The verifier's per-criterion grade, one of exactly three values: `pass`, `fail`, or `ungraded` (`ungraded` means the verifier cannot decide — mechanical evidence insufficient, or judgment unavailable). `ungraded` is a first-class, authority-respecting declaration: it escalates to the operator, never starts builder rework — rework on an ungraded verdict burns a builder take on a candidate nobody graded. `ungraded` is distinct from a missing envelope entry, which is treated as a failed verifier attempt and retried. *Avoid:* reviewer verdict (the pre-merge role's name for the same grade).

**Verification contract** — The frozen per-unit checks a unit's work is graded against: drafted by the planner at plan-prep, operator-approved with the plan, riding in the immutable snapshot. A unit without one fails admission; changing one mid-run is a scope change requiring operator approval (VISION step 2).

## Gaps and evidence

**Gap** — A first-class typed journal event recording a problem on a (unit, criterion) pair. Opened by `gap_recorded(unit, criterion, reason)`; closed by `gap_closed(unit, criterion, close_reason)`. Every criterion has a pass at or above its declared tier **with no open gap** on the unit for the acceptance predicate to hold. R50: "a problem cannot disappear silently" — an accept/override that supersedes open gaps must journal `gap_closed` events with `close_reason` before the superseding event (see `docs/solutions/patterns/explicit-gap-close-before-supersede.md`).

**Custody chain** — The hash-chained evidence trail: each harvested artifact carries a SHA-256 content hash, and each custody header carries `prev_hash` linking to the previous artifact's hash. A broken or missing chain link is an evidence gap (R45).

## Dispatch

**`dispatch.default_workspace`** — An optional field on the dispatch config: an existing Paseo workspace id that dispatches attach to via `--workspace <id>` instead of creating a new worktree. Absent/undefined is the default — the new-worktree contract applies. Read from the run's config snapshot (R80) at dispatch time so a run in progress keeps its workspace policy. See `docs/solutions/patterns/adapter-default-workspace-config-field.md`.