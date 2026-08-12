---
lorespec: "0.1"
id: "2026081201"
date: "2026-08-12"
source: "opencode"
topic: "Shipped the independent verifier role end-to-end via delegated lfg pipeline, merge-ready loop, and merge"
tags: [miah, lfg, paseo, orchestration, verifier, merge-ready, delegation, ce-work, ce-explain]
classification:
  type: technical
  secondary_type: operational
  domains: [agent-orchestration, miah-product, verification]
  value: high
trails: [miah-independent-verifier, miah-orchestration]
---

## Session Arc

### Started
The dispatch persona was active. The operator asked to implement `docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md` via the `ce-work` skill.

### Pivots
- **ce-work fail-closed triage**: the plan carried `artifact_readiness: requirements-only` — ce-work refused to implement a product contract with no Implementation Units. The operator redirected to `/lfg` with a delegation mandate: run the full pipeline but delegate every stage to agents, never implementing myself.
- **Model routing**: the claude provider was not logged in (opus 5 dispatch failed with "Not logged in"); the same model was reachable via `opencode/openrouter/anthropic/claude-opus-5`. Mid-pipeline the operator replaced opus 5 with gpt-5.6-sol for all future planning/frontier work.
- **Planner artifact failure**: the opus 5 planner burned ~$3.66 in deep design reasoning but its final `[Write]` never landed — working tree clean, plan unchanged. Retried on gpt-5.6-sol with an explicit verify-on-disk-before-finishing instruction; it delivered a 434-line implementation-ready plan (U1-U7).
- **E2E hang**: the full `npm test` stalled; isolated to the two real-daemon e2e files (40-minute per-test timeouts) plus a Windows esbuild postinstall block. Resolution: exclude `test/e2e/**` locally, run the rest (340→419→423 tests green), never weaken assertions, let CI exercise e2e.
- **Implementer stall**: went idle mid-U4 with no result or blocker report; re-prompted with a resume instruction, then completed U1-U7 (63 files, 4444+ insertions).
- **Audit + fixes**: minimax-m3 review found 4 actionable findings (2 P1: verifier `ungraded` misrouted to rework; historical `reviewer`-role replay clobbering state) — all verified against code, fixed, suite held.
- **Merge-ready loop**: 8 rounds, 4 Copilot review rounds, 7 findings fixed-and-verified (C1-C3, D1, OBS-A, SUPPRESSED-2, SUPPRESSED-3), 3 declined with reason, 0 parks after the operator overrode the parking of three findings and extended the Copilot budget by one round.
- **Ship + explain**: PR #9 merged (squash `ea58d3f`); a non-technical-manager explainer was composed (ce-explain) and committed to main (`45a1239`); branch and worktree deleted; follow-ups filed as issues #10/#11.

### Ended
Everything landed: PR #9 merged, explainer on main, cleanup complete, wrapup running.

## ARTIFACT

### A1 — Implementation-ready plan: independent verifier role
`docs/plans/2026-08-11-001-feat-independent-verifier-role-implementation-plan.md` (434 lines). Enriched from the requirements-only product contract by ce-plan on gpt-5.6-sol. Seven implementation units (U1-U7): freeze verification contracts in the machine plan; role-aware dispatch/replay; verifier evidence package; verifier envelope v2 + packet contract; resumable verifier lifecycle + grade enforcement; verifier flags + criterion-level operator grades; E2E recovery proof + docs. Per-unit Verification Contract and Definition of Done present. Merged to main via PR #9. Source: planner agent reports; verified at the step-1 gate (U-IDs, contract section, DoD present).

### A2 — PR #9 merged: independent verifier role feature
Squash commit `ea58d3f` on main. Miah stops grading: a verifier specialist grades every non-human-tier criterion against harvested evidence; the operator grades human-warranted criteria; verification contracts frozen before builder work. 63 files changed (~4500 lines), 419 non-e2e tests passing at ship. Source: merge verified via `gh pr view` (MERGED, mergeCommit `ea58d3f`).

### A3 — Manager explainer
`docs/explainers/independent-verifier-role-manager-explainer.html` (commit `45a1239`). Self-contained single-file HTML rendered for a non-technical manager (ce-explain, recap shape): before/after diagram ("the referee is never on the team"), why it matters, how it works, timeline, honest caveats, bottom line. Source: composed and audited this session; committed post-merge per operator choice.

### A4 — Residual review findings record
`docs/residual-review-findings/feat-independent-verifier-role.md` (commit `24e6dbd` on the feature branch, carried into the squash). Durable record of 5 advisory findings (#4 verifier-attempt budget tuning, #5 tester D8-i row, #7 verifier-attempts observability, #8 escalation evidence-pointer inlining, #9 roleOf builder default) plus carried residual risks (e2e daemon tests, U7 kill-drill boundary, contractless-resume). Source: written and committed by the orchestrator at lfg step 6.

### A5 — Follow-up GitHub issues
- Issue #10: `chore(commands/resolve): drop unused runIntegrationCheck import` (left over from the D1 fix).
- Issue #11: `refactor(step): harden handle.cwd fallback in processBuilderTermination (mirror OBS-A fix)` — pre-existing pattern, out of scope for PR #9.
Source: filed via `gh issue create` this session; both open.

## DECISION

### D1 — Requirements-only plans are not implementation-ready; enrich via ce-plan first
**Decision**: A `ce-unified-plan/v1` with `artifact_readiness: requirements-only` must be enriched by `ce-plan` into an implementation-ready plan (U-IDs, per-unit Verification Contract, DoD) before any implementation dispatch.
**Issue**: The operator asked to implement a requirements-only product contract directly.
**Positions**: (a) implement anyway and let the worker resolve the four deferred contract-shape questions; (b) fail closed and require plan enrichment first.
**Arguments**: (a) faster, but the worker would silently decide contract-level questions (evidence-package shape, envelope shape, escalation payloads, contract artifact shape) that the operator owns; (b) slower but preserves authority boundaries and matches ce-work's fail-closed contract.
**Warrant**: Contract-level decisions are operator territory; a worker resolving them quietly creates drift that is expensive to unwind.
**Qualifier**: always
**Status**: settled

### D2 — lfg pipeline with full delegation to cross-family agents
**Decision**: Run the feature through the lfg pipeline, but every stage is delegated to a separate agent (planner, implementer, simplifier, auditor, fixer, shipper, babysitter); the orchestrator verifies and arbitrates but never implements.
**Issue**: The operator said "Do /lfg instead... but delegate it to other agents as needed."
**Positions**: (a) run lfg inline; (b) delegate every stage.
**Arguments**: (b) gives cross-family contrast (minimax-m3 audit vs deepseek implementation), fresh context per stage, and a verifiable boundary between doing and checking.
**Warrant**: Independent review is only meaningful when the reviewer is not the implementer's mirror.
**Qualifier**: in this case
**Status**: settled

### D3 — Model set: deepseek-v4-flash, minimax-m3, gpt-5.6-sol (opus 5 retired)
**Decision**: Implementation/simplify/fix/ship/CI on deepseek-v4-flash (max); audit on minimax-m3 (thinking); planning/escalation on gpt-5.6-sol. Opus 5 used only for the single in-flight planning session, then retired per operator instruction.
**Issue**: The operator replaced opus 5 mid-pipeline ("don't use opus 5 anymore... use gpt-5.6-sol for anything you'd have used opus 5 for").
**Positions**: (a) keep opus 5; (b) gpt-5.6-sol for frontier work.
**Arguments**: operator preference + budget management; gpt-5.6-sol then delivered the plan the opus 5 attempt failed to write.
**Warrant**: The operator owns model cost/quality trade-offs; a model that burns budget without producing artifacts is not worth its ceiling.
**Qualifier**: always (until operator changes it)
**Status**: settled

### D4 — E2E hang treated as environment limitation; excluded locally, never weakened
**Decision**: The two real-daemon e2e files (40-min timeouts) are excluded from local runs; assertions updated for the verifier lifecycle but not weakened; CI exercises them.
**Issue**: `npm test` hung on e2e in the worktree.
**Positions**: (a) skip/mock the assertions to make local runs pass; (b) exclude + document + let CI run them.
**Arguments**: (b) preserves the tests' value as evidence on daemon-equipped hosts; (a) is the "verifier that always passes" failure mode.
**Warrant**: Weakening assertions to force a pass destroys the evidence the tests exist to produce.
**Qualifier**: always
**Status**: settled

### D5 — Operator override: fix the three parked merge-loop findings
**Decision**: Before merge, the operator ordered the three parked findings (SUPPRESSED-2, SUPPRESSED-3, OBS-A) fixed, extending the Copilot-round budget by one final round.
**Issue**: The merge judge parked three real-but-bounded findings to stay within the 3-Copilot-round budget.
**Positions**: (a) merge with parked follow-ups; (b) fix now and re-validate with one more Copilot round.
**Arguments**: (b) leaves no known defects in the merge; the cost was one extra review round, which the operator accepted.
**Warrant**: Known defects should not ride along when the fixer is warm and the re-validation cost is bounded.
**Qualifier**: in this case
**Status**: settled

### D6 — Merge via squash; explainer as post-merge docs commit
**Decision**: PR #9 squash-merged (`ea58d3f`); the manager explainer landed on main as its own docs commit (`45a1239`) after merge rather than advancing the PR head.
**Issue**: The explainer is a manager-facing doc, not feature code; committing it to the branch would have invalidated the ready verdict (review must be on the current head).
**Positions**: (a) commit to branch and re-validate; (b) post-merge docs commit.
**Arguments**: (b) keeps the verified verdict intact and the doc off the feature diff; (a) costs another full Copilot round for a docs file.
**Warrant**: A hard-won merge verdict should not be invalidated by a non-code doc.
**Qualifier**: usually
**Status**: settled

## INSIGHT

### I1 — The controller that decides should not be the mechanism that judges
Miah's product principle: the supervisor runs the checks (senses) and enforces the acceptance predicate, but never grades. Grading belongs to a separate verifier specialist; human-warranted criteria go to the operator. This is the sensor/judge split (KD2/KD6) that the whole feature implements. Source: plan and VISION.md. Confidence: high (shipped product behavior).

### I2 — "A verifier that always passes is worse than no verifier"
The problem frame that motivated the feature. It also drove an implementation-level integrity gate: Miah mechanically cross-checks a verifier's deterministic certification against harvested exit codes and journals a gap-contradiction if they disagree — a mechanical check, not a Miah grade (R2 preserved). Source: plan Problem Frame + planner design. Confidence: high.

### I3 — Frontier-model planners can burn budget without producing the artifact
The opus 5 planner spent ~$3.66 and ~293 updates in design reasoning, then finished with "Writing the implementation-ready plan now" while the file never changed. The retry instruction — write the artifact, verify on disk, then finish — is what made gpt-5.6-sol succeed. Lesson: for artifact-producing agents, require disk verification before termination, not just a completion message. Source: planner run evidence. Confidence: high.

### I4 — Authority separation makes merge readiness trustworthy
In the pr-merge-ready-loop, the judge (read-only, cross-family minimax-m3) decides and writes the verdict log; the babysitter (deepseek) mutates. A fixer that also certifies its own fixes is a rubber stamp. The verdict log (rounds, findings, fixes_verified) is the audit trail the operator uses to make the merge call. Source: pr-merge-ready-loop execution. Confidence: high.

### I5 — Windows worktree e2e hangs have two distinct causes here
The full-suite hang in this environment came from (a) the two real-daemon e2e tests with 40-minute per-test timeouts, and (b) an esbuild postinstall blocked by npm's install-script approval on Windows (fixed via `npm install-scripts approve esbuild` + `npm rebuild esbuild`). Neither is a product defect; both are environment constraints to plan around. Source: implementer diagnostics. Confidence: high.

## PATTERN

### P1 — Delegated lfg pipeline with per-stage cross-family agents
Scope: universal. The full lfg flow — plan, implement (return-to-caller), simplify, review, apply fixes, residuals, browser-test-if-UI, commit/push/PR, babysit CI — executed by dispatching a separate Paseo agent per stage: planning on gpt-5.6-sol, implementation/simplify/fix/ship/CI on deepseek-v4-flash, audit on minimax-m3. The orchestrator verifies every stage's claims independently (runs the suite itself, greps the diff, queries GitHub), owns canonical commits, and only pauses for genuine divergence. Heartbeat supervision every 15 min keeps stalled agents from silently blocking. Components: goal-prompt per stage with plan path + structure pins + verification gate; independent re-verification after each handoff; temp-file cleanup check at the envelope gate; residual record commit; delete heartbeat at DONE.

### P2 — Merge-ready loop: judge decides, babysitter executes, Copilot reviews
Scope: universal. For a PR that must be verified before merge: a read-only cross-family judge (minimax-m3) issues verdict + fix-list + Copilot-round decisions and maintains a verdict log; a babysitter (deepseek-v4-flash, ce-babysit-pr) executes fixes, pushes, resolves threads, and requests Copilot reviews (`gh pr edit <N> --add-reviewer "@copilot"`, verified via GraphQL); Copilot is the primary reviewer. Ready requires: Copilot review on the CURRENT head, judge assessment concluding ready, CI green (empty rollup is not green). Cap Copilot rounds (default 3) to bound non-convergence; a caller can extend. Never merge from the loop.

### P3 — Requirement: verify on disk before an agent terminates
Scope: universal. Any agent asked to produce an artifact (plan, doc, file) must verify the artifact exists on disk with the expected content before reporting completion. Prevents the "agent says done, nothing changed" failure. Components: instruct write-then-verify; orchestrator independently checks the file + git state at the gate.

### P4 — Environment-hang handling: characterize, isolate, never weaken
Scope: universal. When a test command hangs: identify the hanging subset (run files individually), confirm it's environmental (timeout architecture, platform blockers) rather than a product finding, exclude it from local runs with the reason recorded, keep assertions intact, and let CI exercise it. Weakening/skipping/mocking assertions to force green is the "verifier that always passes" failure mode.

## SOLUTION

### S1 — Verifier `ungraded` verdict routed to rework instead of escalate (P1)
**Problem**: `src/step.ts` converted the verifier's valid D5 verdict `"ungraded"` to `null`; `gradeDeterministic`/`gradeCalibratedJudge` then routed null to `rework`, burning builder takes. KTD4/KTD6/R48 require verifier-side "ungraded" (cannot decide) to escalate.
**Fix**: Pass `entry.verdict` through unchanged; add explicit `ungraded` branches in grading.ts — deterministic → escalate ("verifier-ungraded: mechanical evidence insufficient"), calibrated-judge → escalate ("verifier-ungraded: judgment unavailable"); null stays reserved for a missing envelope. Tests added for both tiers.
**Why it works**: the D5 verdict vocabulary is now honored end-to-end; escalation, not rework, is the authority-respecting route when a verifier cannot decide.
**Caveats**: found by minimax-m3 audit, verified against code before fixing.

### S2 — Historical `reviewer`-role termination clobbers replay state (P1)
**Problem**: `replay.ts` `dispatch_terminated` branched only on `verifier`/`builder`; a historical `role: "reviewer"` event fell to the catch-all and reset an in-flight unit to `not_started`, violating R17/KTD8 (reviewer journals must stay replayable).
**Fix**: Treat `role === "reviewer"` as equivalent to `role === "verifier"` in the termination branch (return to `awaiting_verification`, preserve candidate). Tests: reviewer termination preserves the candidate, never `not_started`.
**Why it works**: state derivation now maps the historical role string to the verifier semantics it predates.

### S3 — Acceptance predicate joins grades by text instead of criterion ID (P2)
**Problem**: `acceptance.ts` matched grades to criteria by criterion text; two identical-text criteria in one unit could join a grade for A onto B. The verifier rewrite made criterion_id the authoritative key (KTD1).
**Fix**: `recordMatchesCriterion` — id is the join key when present; text fallback only for id-less criteria. Discriminating twin-text test added.
**Why it works**: the join now uses the stable unique key, matching how grades are journaled and how the v2 envelope binds.

### S4 — Test-seam synthetic verifier envelope lacks a production guard (P2)
**Problem**: `verifierEnvelopeFor` (test-only seam) wrote whatever it returned to disk; a production caller passing a non-null envelope would manufacture a verifier result — the "Miah manufactures a grade" failure mode.
**Fix**: The seam is only invoked when `process.env.NODE_ENV !== "production"`; production fails closed as a missing envelope → failed verifier attempt.
**Why it works**: the foot-gun is closed at the seam boundary; tests run under unset NODE_ENV and pass.

### S5 — Null-cwd verifier termination hashed the process CWD (P3)
**Problem**: `processVerifierTermination` used `handle.cwd ?? ""`, then path-joined reads and `workspaceHash("")` → hashed the process CWD (self-consistent but not cross-comparable).
**Fix**: null guard + explicit `verifier_attempt_failed` with reason "verifier worktree unavailable", honoring the attempt budget, before any read/hash runs.
**Why it works**: the verifier fails closed cleanly instead of recording a wrong-path continuity hash. Builder path (pre-existing, OBS-B) intentionally untouched → filed as issue #11.

### S6 — Windows esbuild postinstall blocked npm test
**Problem**: vitest hung; root cause was esbuild's postinstall blocked by npm script approval on Windows.
**Fix**: `npm install-scripts approve esbuild` + `npm rebuild esbuild`; then vitest worked and the full non-e2e suite ran.
**Why it works**: esbuild's native binary was installed; the earlier hang was not a test defect.
**Caveats**: environment fix only; `package.json` deliberately reverted to avoid an out-of-scope diff.

## OPEN_QUESTION

### OQ1 — Tester dispatch remains unimplemented
The tester role is specified in `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md` but not built. The verifier currently grades an evidence package with `tester_records: []`. The F1 sequencing dependency says requirements hold unchanged in the degraded case. Blocks: tester-output grading in production; when it lands, tester and verifier share D8-i defaults (audit/glm-5.2) — a foot-gun noted in audit finding #5.

### OQ2 — Verifier-attempt budget is not independently tunable
`verifierBudgetExhausted` uses the shared `run.max_takes` ceiling (settled KTD5). Operators cannot tune verifier retry aggressiveness separately from builder takes. Proposed follow-up: `RunConfig.max_verifier_attempts` defaulting to `run.max_takes`. Filed in residual record (#4) and surfaced by the merge audit.

### OQ3 — Escalation `escalation_raised` payload carries no criterion_id on one path
The verifier-flag escalation carries criterion_id, but `applyAcceptance`'s operator-judgment escalation still emits only criterion text (`criterion`), leaving a duplicate-text mis-targeting risk (SUPPRESSED-3 was fixed for the flag path; the acceptance-path variant remains a known bounded risk per the round-6 park analysis).

## REFERENCE

### R1 — orchestration-preferences.json (Paseo)
`~/.paseo/orchestration-preferences.json` — the operator's provider routing table: impl/research = opencode-go/deepseek-v4-flash (max), audit = opencode-go/minimax-m3, planning = opencode/openai/gpt-5.6-sol, ui = claude/claude-opus-5. The lfg delegation used this for per-stage model selection. Relevant because provider strings must be resolved from it, never hardcoded.

### R2 — pr-merge-ready-loop and request-copilot-code-review skills
`pr-merge-ready-loop` defines the judge/babysitter/Copilot three-role loop with the verdict-log contract and readiness conditions. `request-copilot-code-review` documents the `gh pr edit --add-reviewer "@copilot"` mechanism (quoted on PowerShell) and GraphQL verification. Both executed successfully this session.

## NEXT_STEP

### N1 — Resolve issues #10 and #11 (someday)
- #10: drop the unused `runIntegrationCheck` import at `src/commands/resolve.ts:30` (one-line chore).
- #11: harden the pre-existing `handle.cwd ?? ""` in `processBuilderTermination` uniformly, mirroring the OBS-A fix.
Prompted by: merge-loop findings declined as out-of-scope/cosmetic. Urgency: someday (non-blocking; no gate impact).

### N2 — Commit this session digest and compound learnings (now)
The digest (this file) and any ce-compound solutions are uncommitted on main. Commit them so the knowledge store is current for the next session. Prompted by: wrapup. Urgency: now.

## Connections
- A1 —[informed_by]→ D1 (plan enrichment required before implementation)
- A2 —[instance_of]→ P1 (delegated lfg pipeline)
- A2 —[depends_on]→ A1
- D3 —[informed_by]→ I3 (planner artifact failure drove the model change)
- A4 —[led_to]→ A5 (advisory findings filed as issues)
- A2 —[led_to]→ A3 (explainer composed for the shipped feature)
- P2 —[instance_of]→ A2's merge path
- S1/S2 —[informed_by]→ minimax-m3 audit (cross-family review)
- S5 —[led_to]→ issue #11
- I4 —[informed_by]→ P2

## Trail Updates
- **miah-independent-verifier**: extends from 2026080901 (brainstorm) and 2026081001 (plan review/fix loop) — this session shipped it: implementation-ready plan, implementation, review, merge-ready verdict, merge.
- **miah-orchestration**: extends 2026080801 (phase 3 implementation dispatch) and 2026080701 — new patterns: delegated lfg with heartbeat supervision, merge-ready loop with authority separation.
