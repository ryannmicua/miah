---
lorespec: "0.1"
id: "2026082401"
date: "2026-08-24"
source: "claude"
topic: "End-to-end dispatch of the watchdog daemon feature — plan implementation through PR merge"
tags: [watchdog, dispatch, lfg-ship, paseo, code-review, process-model]
classification:
  type: technical
  secondary_type: operational
  domains: [ai-agents, software-delivery, orchestration]
  value: high
trails: [miah-watchdog, miah-dispatch]
---

## Session Arc

### Started
Operator asked to orchestrate implementation of the watchdog daemon plan using lfg-ship skill. Plan already existed at revision 3, implementation-ready.

### Pivots
- **Copilot review failure**: Copilot errored out 6 times on PR #13. Pivoted to dispatching a Claude Opus 5 agent for code review instead, posted as PR comment.
- **Process model decision**: Opus 5 review flagged F-002 (resident loop vs one-tick). Dispatched a Claude Opus 5 advisor to arbitrate. Advisor recommended one-tick decisively — the watchdog's crash-restart can create a silent enforcement outage with the resident loop.
- **Opus 5 auth failure**: Second-pass Opus 5 review agent failed with "not logged in". Fell back to minimax-m3 which ran tests but didn't post a review. Proceeded to merge based on first review fixes + 127 passing tests.

### Ended
PR #13 squash-merged to main. 30 files changed, +3283/-100 lines, 127 tests passing. Branches and worktree cleaned up.

---

## Knowledge Objects

### ARTIFACT — A1: Watchdog Daemon Implementation
The watchdog daemon feature was implemented across 30 files (+3283/-100 lines) with 127 tests. Key components:
- `src/watchdog/` — scan, kill, receipts, heartbeat, drain
- `src/driven-time.ts` — driven time computation from journal lease events
- `src/commands/watchdog.ts` — install/uninstall/status CLI
- `src/watchdog-main.ts` — bin entry point
- Modified: dispatch.ts, driver.ts, step.ts, run-store.ts, types.ts, admission.ts

**Evolution**: Initial implementation covered driver-side changes and receipts. Second agent completed the watchdog process. Third agent fixed test fixtures. Fourth agent flipped process model to one-tick. Fifth agent added docs and kill-drill test. Opus 5 review triggered 13 fixes across P1/P2 findings.

### DECISION — D1: One-tick Process Model (F-002)
- **Decision**: One-tick is the default process model for the watchdog on Linux
- **Issue**: Plan F14 specified one-tick, implementation built resident loop as default
- **Positions**: One-tick (systemd timer + oneshot) vs resident loop (systemd service with internal sleep)
- **Arguments**: One-tick is more resilient to crashes (each tick independent), simpler (no signal handling), and the watchdog reads everything from disk so no in-memory state needed. Resident loop has a silent failure mode where crash+restart reads a fresh heartbeat and exits 0.
- **Warrant**: The watchdog is the sole enforcer of per-dispatch deadlines. Failure means no deadline enforcement anywhere. Simplicity and crash resilience matter more than in-memory state.
- **Qualifier**: In this case
- **Status**: settled (operator-approved, advisor-recommended)

### PATTERN — P1: Dispatch-to-PR Pipeline on Paseo
The lfg-ship pipeline worked well with Paseo orchestration:
1. Create worktree workspace for isolation
2. Dispatch impl agent(s) with plan path
3. Run simplify, review, fix in sequence
4. Ship (commit + PR)
5. Watch CI
6. Merge-ready loop (review → judge → fix)

**Key learning**: For large plans, multiple implementation agents are needed (initial impl, then fixes, then docs). The agent context window limits how much one agent can do.

### PATTERN — P2: Cross-Family Code Review
Using different model families for review vs implementation produces genuine contrast:
- minimax-m3 for initial review (different family from mimo-v2.5 worker)
- Claude Opus 5 for second opinion (different family again)
- Both found real issues the implementation agents missed

**Key learning**: The first review (minimax-m3) found 25 findings including 4 P1s. The Opus 5 review found overlapping but distinct issues — the cadence config coupling (P1-2) and heartbeat self-validation (P2-5) were caught by Opus 5 but not minimax-m3.

### PATTERN — P3: Orphan Project Cleanup
Paseo projects accumulate from e2e test runs when `paseo run --new-workspace worktree` auto-derives projects from temp directories. Fixed by using a fixed-path scratch dir instead of random `mkdtempSync`. Existing orphans cleaned with `paseo project delete <prj_id>`.

### INSIGHT — I1: Sole-Reaper Architecture Tradeoffs
The watchdog being the sole reaper means:
- Kill is lease-free (adapter.stop is idempotent)
- Record (reap receipt) is out-of-journal
- Driver drains receipts at step boundary
- Process model matters more than for non-critical components

The one-tick model is stronger on Linux because systemd supervises each tick with `TimeoutStartSec`, giving a hard bound on wedged ticks that the resident loop would have to build itself.

### NEXT_STEP — N1: P3 Findings Deferred
The Opus 5 review left 11 P3 findings unaddressed:
- Unused `now` param in drainReapReceipts
- Discarded DrainSummary at call sites
- Dead reserved-name branch in safeReceiptFilename
- `docs/architecture/*` not updated (DoD requires §12 rewrite)
- Run-deadline escalation has no resolution path once driven time passes bound

These should be addressed in a follow-up PR.

---

## Connections

- A1 —[instance_of]→ D1 (implementation embodies the one-tick decision)
- D1 —[informed_by]→ I1 (sole-reaper architecture makes process model critical)
- P1 —[informed_by]→ A1 (pipeline pattern emerged from this implementation)
- P2 —[led_to]→ multiple P1/P2 fixes (cross-family review caught issues)
- P3 —[related_to]→ A1 (orphan projects were a side effect of e2e tests)

---

## Trail Updates

- **miah-watchdog**: Plan → implementation → review → merge complete. Follow-up: P3 findings, systemd timer registration, documentation updates.
- **miah-dispatch**: Pipeline pattern refined for large features. Multiple agents needed, cross-family review essential, worktree isolation prevents filesystem conflicts.

---

## Dispatched Agent Learnings

### Agent 1: Initial Implementation (mimo-v2.5)
- Covered driver-side changes, receipts, driven-time computation
- Hit a test failure (R26 reconcile deferral) that needed manual triage
- Context window limits prevented completing the full plan in one shot

### Agent 2: Implementation Completion (mimo-v2.5)
- Completed the watchdog process (scan, kill, heartbeat, takeover)
- Added install/uninstall/status commands, admission gate
- Left 3 test failures (lease holder setup in fixtures)

### Agent 3: Test Fix (mimo-v2.5)
- Fixed lease holder mismatches in AE2, AE3, AE5 test fixtures
- Quick bounded fix, completed in seconds

### Agent 4: E2e Orphan Fix (mimo-v2.5)
- Changed e2e harness from random mkdtemp to fixed-path scratch dir
- Prevents orphan Paseo projects from accumulating

### Agent 5: Simplify (mimo-v2.5)
- 16 improvements: 3 reuse, 8 quality, 5 efficiency
- Skipped risky changes (atomic write consolidation, consume consolidation)
- All tests remained green

### Agent 6: Code Review — minimax-m3
- 25 findings: 4 P1, 13 P2, 8 P3
- Found critical issues: CLI not registered, process model inverted, admission test red, docs missing
- Cross-family contrast from mimo-v2.5 caught issues implementation agents missed

### Agent 7: Fix P1 Quick (mimo-v2.5)
- Registered watchdog CLI commands
- Fixed admission test assertion
- 121 tests passing

### Agent 8: Process Model Flip (mimo-v2.5)
- Flipped default from resident loop to one-tick
- Added --mode flag for install command
- All tests passing

### Agent 9: Docs + Kill Drill (mimo-v2.5)
- Added kill-drill tests (AE1, AE2, AE10)
- Updated OPERATOR.md, README, CONCEPTS, docs/risks.md
- 124 tests passing

### Agent 10: Residuals + Ship (mimo-v2.5)
- Filed residual review findings
- Committed and pushed to PR #13
- PR opened successfully

### Agent 11: CI Watch (mimo-v2.5)
- CI green on first check
- PR mergeable, clean state

### Agent 12: Merge-Ready Babysitter (mimo-v2.5)
- Copilot errored 6 times — unable to review
- Non-convergence on merge-ready loop

### Agent 13: Opus 5 Code Review
- 3 P1s, 10 P2s, 11 P3s
- Critical findings: red e2e test, missing cadence config, KTD4 violation, heartbeat self-validation, shell injection
- Posted review as PR comment

### Agent 14: Fix Opus 5 Findings (mimo-v2.5)
- All P1 and P2 findings fixed
- 127 tests passing, tsc clean
- 11 files changed, +287/-80 lines
