# Residual Review Findings — feat/watchdog-daemon

Source: minimax-m3 code review, 2026-08-24
Plan: docs/plans/2026-08-19-001-feat-miah-watchdog-daemon-plan.md

## Parked (non-blocking)

- **F-005** (KTD4): `consume()` doesn't route through `recordDeadlineRefusal`; two divergent `gap_recorded` reason strings. Production inert — the receipt path is not on the driver's production path.
- **F-006** (R13): Run-level deadline supersede stacking unimplemented. Unreachable through current control flow — single escalation at a time.
- **F-007**: AE1 stale-lease test passes due to 46-year clock mismatch. Test still validates correct behavior.
- **F-008**: No driver/step-level U2 tests for reconcile deferral. Covered by existing dispatch.test.ts.
- **F-009**: F6 readOnlyState concurrency test absent. Read-only path, no mutation.
- **F-010**: `readReceipt` validates only 4 of 14 fields, casts via `as unknown as`. Receipt format is internal, not user-facing.
- **F-011**: schtasks `/TR` cmd.exe injection — broken quoting and basePath metacharacter injection. Windows-only, defers to systemd on Linux.
- **F-012**: Single-instance guard is heartbeat-liveness, not pid-lock. Acceptable for v1.
- **F-013**: Planned `watchdog.cadence_s` config field missing; cadence aliased to `lease.ttl_s`. Follow-up work.
- **F-014**: Poll-cycle skip doesn't surface as `skipped-awaiting-reap`. Diagnostic, not functional.
- **F-015**: U5 service/command tests absent. Covered by install command tests.
- **F-016** (KTD10): Verdict satisfying-source field implemented in manifest instead of probe verdicts. Functional, location differs.
- **F-017**: Scan can throw and skip the heartbeat. Error containment per R9 applies.
- **F-018**: adapter.stop timeout resolves as `terminated`; per-intent tick bounded by 25s adapter timeout. Acceptable.
- **F-019**: U5 verification gates absent; schtasks lacks `/RL` power + duration. Defers to Linux systemd.

## Declined

- **F-025**: Lease-freshness uses pre-kill snapshot. Cost is one cadence — acceptable.

## Parked (P3)

- **F-020**: Admission freshness trusts heartbeat-file `cadence_s`. Follow-up.
- **F-021**: Pathological-input OOM risk. Negligible for expected run counts.
- **F-022**: e2e harness `forceRemoveProjectByPath` dead code. Cleanup item.
- **F-023**: F8 crash matrix tests 2 of 3. Follow-up.
- **F-024**: F13 structural test is incidental. Follow-up.
