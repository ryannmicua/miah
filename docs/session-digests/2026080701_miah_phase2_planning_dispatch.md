---
lorespec: "0.1"
id: "2026080701"
date: "2026-08-07"
source: "opencode"
topic: "Miah Phase 2 planning: R4 verification, Brainstorm 2 dispatch, unified implementation plan, and orchestration lessons"
tags: [miah, planning, paseo, ce-plan, brainstorming, orchestration, r4, glm-5.2]
classification:
  type: strategy
  secondary_type: technical
  domains: [agent-orchestration, durable-execution, planning]
  value: high
trails: [miah-planning, paseo-orchestration]
---

## Session Arc

### Started
Continued the Miah Brainstorm 1 orchestrator session (agent `be0f5e9f`, Claude Opus) which had died at its session limit. Task: read the parallel Opus brainstorm agent's session (`1a53b45d`), read the D1/D2 plan artifact, and continue the brainstorm.

### Pivots
- **R4 blocker verification (critical)**: The orchestrator had verified against the live Paseo surface that no crash-surviving hard bound exists for agents (`--wait-timeout` bounds the waiter only; `expiresIn`/`maxRuns` exist only on schedules). This session re-verified against Paseo v0.3.0-beta.2: agent records carry no expiry fields; daemon config has no per-agent bound keys; BUT schedule expiry enforcement (`~/.paseo/schedules/*.json`) proves the daemon has the enforcement primitive for the same object class — making the per-agent `max-duration` feature ask feasible and precedent-backed, not blue-sky.
- **Opus did NOT independently find the R4 gap**: Its C2 mitigation ("adapter-level per-dispatch deadlines") was assumed, never verified — the orchestrator's live verification was the only evidence.
- **Operator chose verify-first**: When offered the decision point, the operator confirmed leaning toward verifying the Paseo feature ask before rewriting artifacts.
- **ce-plan not actually run**: The Planning session agent produced the unified plan (003) by imitation — it never loaded the ce-plan skill. Discovered via activity-log audit. User declined to remediate; chose wrapup instead.

### Ended
Phase 2 is at its exit condition: unified implementation plan `docs/plans/2026-08-06-003-miah-implementation-plan.md` (003) written but uncommitted and unapproved, with 5 operator questions (OQ1-OQ5) pending. Worktree/branch cleanup completed. Session wrapped up with the 003 plan awaiting operator review. (Resolved after this session: plan committed `2a75c2c` and deepened `6e53fc8`; OQ1-OQ5 settled 2026-08-07 — see digest `2026080702`.)

## ARTIFACT

### A1. Revised D1/D2 plan (001)
- **Path**: `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md` (committed `6614d0d`)
- **Contents**: R1-R21. Reframed R4/R5 from "containment of runaway work" to **fail-closed acceptance** — a dead Miah cannot stop a runaway specialist (bounded cost exposure), but R16 + R9/R13 prevent correctness exposure. AE1's false "cannot continue beyond the bound" claim dropped. R16 tightened to file-based result envelopes. R20 adds calibration-bar authority with operator escalation. R21 requires MCP injection scoping (R12 recommends concurrency default 1). Recorded the daemon-enforced per-agent `max-duration` feature ask with live-verification source.
- **Evolution**: Codex agent (393f3dd5) wrote the original; this session dispatched a revision folding in Opus's sharper findings (file results, calibration tier, concurrency default, MCP injection) and the verified R4 framing.

### A2. Opus D1/D2 decision record
- **Path**: `docs/decisions/2026-08-06-d1-d2-runtime-and-agent-invocation.md` (committed `e2ff814` via fast-forward from branch `brainstorm-1-opus`)
- **Contents**: D1 (stateless interpreter over snapshot+journal+lease), D2 (six-property independence predicate at the acceptance gate), adversarial findings A1-A10. Sharper than 001 in: file-based results (D2-b), checker authority from calibration not family (D2-d), concurrency default 1 (C1), builder context reuse (D2-k), MCP injection flag (D2-g). Flagged anti-sycophancy skill absent in its environment (in-thread pass = not independent corroboration).

### A3. Brainstorm 2 plan — D3/D4/D5/D9 (002)
- **Path**: `docs/plans/2026-08-06-002-feat-miah-artifacts-plan.md` (committed `c0349f6`, NOT pushed)
- **Contents**: R22-R62. D3: CE plan format + admission discipline (`creates:`/`inputs:`/`tier:`/`depends-on`, parse-once-into-`units.json`). D4: single append-only `journal.jsonl`, `lease.lock` authority, paired `gap_recorded`/`gap_closed`, kill drill. D5: Miah-harvested evidence, hash-chained custody, T2-T3 dual-hash, `calibrated-judge` reframed as **operator-assisted** not mechanical, integration self-containedness check (smuggle vector). D9: pure `miah preflight` (structural/referential/verifiability), admission = `preflight ∧ substrate-readiness`.
- **Quality**: adversarial pass ran on a FRESH independent thinker subagent (deepseek-v4-pro) — the anti-sycophancy skill was installed by then, unlike Brainstorm 1's environment.

### A4. Unified implementation plan (003)
- **Path**: `docs/plans/2026-08-06-003-miah-implementation-plan.md` (UNCOMMITTED, UNREVIEWED as of this session; later committed `2a75c2c`, deepened `6e53fc8`)
- **Contents**: 645 lines, R1-R90 (R63-R90 new for D6/D7/D8), 18 KTDs, 10 implementation units (U1-U10), verification contract, definition of done. TS/Node CLI; Windows 10 + Git Bash portability; substrate probe honestly reports absent; MCP injection fails closed (operator disables global injection as workaround); env secret-scrubbing documented residual risk; kill drill as first-class milestone (U3→U5→U10).
- **Caveat**: produced WITHOUT the ce-plan skill (see DECISION D5). Content coherent and requirements-complete per this session's verification read, but the ce-plan workflow's confidence check, ce-doc-review, and handoff menu were never run.

## DECISION

### D1. R4/R5 reframed to fail-closed acceptance
- **Decision**: Rewrite R4/R5 from "containment" to fail-closed acceptance; admission fails until the Paseo per-agent `max-duration` feature exists.
- **Issue**: Miah's plan claimed it could hard-bind runaway specialists while dead; live verification proved nothing can stop a running Paseo agent when Miah is gone.
- **Positions**: (a) keep containment claim (false today), (b) fail-closed acceptance + feature ask, (c) reopen D1/D2.
- **Arguments**: Evidence continuity is satisfied (Paseo daemon persists agents independent of Miah); only enforcement is missing. R16+R9/R13 already prevent correctness corruption — exposure is bounded cost only. Schedule `expiresIn` enforcement proves the daemon can do it for the same object class.
- **Warrant**: A plan must not assert guarantees the substrate cannot deliver; honesty about the guarantee class (execution vs acceptance) preserves the plan's fail-closed character.
- **Qualifier**: usually
- **Status**: settled (by operator)

### D2. Verify the Paseo feature ask before rewriting artifacts
- **Decision**: Verify feasibility of daemon-enforced per-agent `max-duration` against the live surface before correcting R4-R6.
- **Issue**: Should artifacts be rewritten around a feature that might not be buildable?
- **Positions**: (a) verify first (operator leaning), (b) send correction immediately, (c) reconcile both artifacts first.
- **Arguments**: The correction is only as strong as the mechanism it rests on. Verification showed the enforcement primitive exists (schedule expiry) for the same daemon-managed object class — feasible but unshipped.
- **Warrant**: A feature ask grounded in an existing daemon enforcement mechanism is materially stronger than one grounded in hope.
- **Qualifier**: always
- **Status**: settled

### D3. Model choice for Brainstorm 2 and Planning: glm-5.2
- **Decision**: Dispatched Brainstorm 2 and the Planning session on `opencode-go/glm-5.2` at max thinking.
- **Issue**: Which model runs the remaining Phase 2 sessions.
- **Positions**: glm-5.2 (operator-requested for B2, continued for Planning), gpt-5.6-sol, claude-opus-5.
- **Arguments**: Operator explicitly requested glm-5.2; continuity across D3-D9 artifacts; 1M context; thinking high/max available.
- **Warrant**: Model continuity reduces context loss across dependent planning artifacts.
- **Qualifier**: in this case
- **Status**: settled

### D4. Clean up the brainstorm-1-opus worktree via kill of idle agent
- **Decision**: Terminated the idle Opus agent (`1a53b45d`) to release the file handle blocking `git worktree remove`, then deleted the worktree and merged branch.
- **Issue**: `git worktree remove` failed with Permission denied — the claude.exe runtime process of the idle agent held cwd in the worktree.
- **Positions**: (a) kill the agent (its work was merged), (b) leave the worktree stranded.
- **Arguments**: Agent was idle, its artifact merged, branch fully merged into main. `git worktree prune` cleaned metadata; the empty dir needed the process handle released.
- **Warrant**: A finished, merged agent's idle runtime process is safe to terminate to reclaim its worktree.
- **Qualifier**: always (when merged and idle)
- **Status**: settled

### D5. (Unplanned) The Planning session did not actually run ce-plan
- **Decision**: Not a decision but a discovery: the planning agent (f666db04) never loaded the ce-plan skill; it imitated the artifact structure from the two prior plans.
- **Issue**: User asked "Did we run ce-plan here?" — audit of the activity log showed no skill load (tools used: Shell/Write/Edit/Search only).
- **Positions**: (a) remediate — run confidence check + ce-doc-review + handoff menu, (b) accept as-is, (c) re-dispatch with explicit skill load.
- **Arguments**: Content is coherent and requirements-complete; process contract (confidence check, doc review, handoff) incomplete. User declined remediation.
- **Warrant**: Skill invocation must be verified by evidence (activity log), not by prompt instruction.
- **Qualifier**: tentatively
- **Status**: revisited (open: operator may still choose remediation)

## INSIGHT

### I1. Paseo's daemon-enforced schedule expiry is the precedent for per-agent max-duration
- **Source**: Live verification 2026-08-06 against `~/.paseo/schedules/10fca15e.json` and `~/.paseo/config.json`
- **Content**: Paseo v0.3.0-beta.2 enforces `expiresAt`/`maxRuns` on schedules — a daemon timer + terminate primitive. Schedules and agents are the same daemon-managed object class in the same `~/.paseo/` store. Agent records carry only mode/model/thinking (no expiry fields); `agent run`/`agent update` expose no bound flags; daemon config has no per-agent bound keys. The mechanism Miah's R4 needs is therefore a small, precedent-backed feature ask, not a rearchitecture.
- **Confidence**: high (verified live)

### I2. Opus's parallel brainstorm did not independently find the R4 gap
- **Source**: Opus decision doc C2 — "adapter-level per-dispatch deadlines" stated as mitigation, never verified
- **Content**: Two brainstorms converged on D1/D2 shape but diverged on verification depth: the Codex/orchestrator side ran live-surface verification of R4; Opus asserted a mitigation without testing it. The parallel-run comparison was still valuable (earned corroboration on D1/D2 core, sharper Opus findings merged in), but "independently found the same gap" must not be assumed from convergence.
- **Confidence**: high

### I3. Convergence in a parallel brainstorm is earned only when both sides verified the same claim
- **Source**: This session's comparison of 001 vs Opus decision doc
- **Content**: Both artifacts converge on CLI + journal + lease + independent dispatch. Convergence on the shared context (VISION, research docs) is cheap; convergence on verified substrate facts is expensive and was one-sided for R4. When using parallel brainstorms, explicitly inventory which claims each side VERIFIED vs ASSUMED.
- **Confidence**: high

### I4. Worktree cleanup on Windows can be blocked by the agent runtime process, not git
- **Source**: `git worktree remove` Permission denied; holder was claude.exe (agent runtime), released by `paseo kill_agent`
- **Content**: On Windows, an idle Paseo agent's runtime process holds cwd in its worktree, blocking removal. `git worktree prune` clears metadata; the physical dir needs the process terminated. Check agent status (idle + work merged) before killing.
- **Confidence**: high

## OPEN_QUESTION

### OQ1. Is the per-agent max-duration feature actually shippable upstream?
- **Progress**: Feasibility verified (schedule expiry precedent); Paseo is at v0.3.0-beta.2, no agent-side feature. Admission fails closed until it ships.
- **Blocks**: U4 (substrate probe) and U10 (full E2E admission) of the 003 plan; the R4/R5 blocker closure.

### OQ2. Does v1 supervise `execution: knowledge-work` plans? (resolved 2026-08-07 — v1 is `execution: code` only)
- **Progress**: Recorded assumption (D1/D2 A10): v1 is `execution: code` only. Machinery is code-shaped (diffs, worktrees, commits).
- **Blocks**: Scope of 003 plan's R22.

### OQ3. Operator questions OQ1-OQ5 of the 003 plan (language, knowledge-work, MCP injection, budget defaults, notifications) (resolved 2026-08-07 — all settled with recommended answers)
- **Progress**: All five have recommended answers in the plan (TS/Node; code-only; fail-closed + disable global injection; 15m/3/2/1/3polls; CLI-first no push).
- **Blocks**: Plan approval → AGENTS.md Phase 3 rewrite. (Resolved — plan approved; AGENTS.md advanced to Phase 3, now Phase 4 — Operating.)

## NEXT_STEP

### N1. Operator reviews 003 plan and answers OQ1-OQ5 (done 2026-08-07 — OQ1-OQ5 settled with recommended answers; plan approved, Phase 3 advanced)
- Prompted by: Planning session completion; Phase 2 exit condition reached.
- Decision on: language, knowledge-work scope, MCP injection strategy, budget defaults, notifications.

### N2. Decide ce-plan remediation for 003 (done 2026-08-07 — ce-plan confidence check run in the deepening pass; see digest `2026080702`)
- Prompted by: D5 discovery that ce-plan never ran. Options remain: confidence check + ce-doc-review + handoff, or accept-as-is, or re-dispatch with explicit skill loading.

### N3. Commit 003 plan and push local commits (done — plan committed `2a75c2c`/`6e53fc8`; history superseded by the PR #1 squash `d7eac30`)
- State: local main `c0349f6` (002) ahead of origin/main by 1; origin/main at `6614d0d` (001 + decision doc pushed externally). 003 untracked.

### N4. On plan approval: rewrite AGENTS.md to Phase 3 and update README (done — AGENTS.md advanced to Phase 3 for implementation, now Phase 4 — Operating; README aligned)
- Prompted by: AGENTS.md working rules — rewrite only when the operator approves the phase advance.

## CONNECTIONS
- D1 —[led_to]→ A1 (revised R4/R5 framing)
- I1 —[informed_by]→ D2 —[led_to]→ D1
- A2 —[informed_by]→ A1 (Opus findings merged into 001)
- A3 —[depends_on]→ A1, A2
- A4 —[depends_on]→ A3 (R22-R62 carried forward)
- A4 —[contradicts]→ D5 (plan claims ce-plan structure; skill never ran)
- I2 —[related_to]→ I3
- I4 —[led_to]→ D4
- OQ1 —[depends_on]→ D1 (feature ask closure)
- N1 —[blocks]→ N4

## Trail Updates
- **miah-planning**: Phase 2 complete through unified plan (unapproved). Next: operator review, OQ1-OQ5, approval → Phase 3.
- **paseo-orchestration**: new pattern — verify feature-ask feasibility against live daemon surface before rewriting artifacts; skill-invocation must be evidence-verified via activity logs; worktree cleanup on Windows requires killing the idle agent runtime process.
