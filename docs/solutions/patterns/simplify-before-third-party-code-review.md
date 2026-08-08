---
title: "Simplify pass (behavior-preserving) before a third-party-model code review, then atomic per-finding fix commits"
date: 2026-08-08
category: patterns
problem_type: knowledge
component: review-discipline
tags: [miah, code-review, simplify, behavior-preserving, third-party-model, minimax, report-only, severity, atomic-commits, cross-project]
applies_when: "Finishing a multi-unit implementation before opening the PR — you want to reduce review noise by consolidating the diff first, then hand a clean diff to a model that was not involved in the build for an independent code review, and route the findings back to a fix agent that commits one atomic change per finding."
---

# Simplify pass before a third-party-model code review, then atomic per-finding fix commits

> **Cross-project knowledge.** This pattern is staged in the Miah repo because the validating implementation happened here, but it applies to any multi-unit build that ends with a code review gate — the simplify-then-review-then-fix discipline is substrate-agnostic. The operator will synthesize it into other projects.

## Context

The Miah v1 implementation landed ten sequential units (U1–U10) plus a post-completion hardening pass (R67 fix, lease handoff, adapter workspace binding, scratch hygiene) on the `feat/miah-implementation` branch. By 2026-08-08 the diff was 23,592 insertions across 102 files. Before the PR, the operator ran a three-phase review discipline:

1. **Simplify pass** (commit `0f4086b`, session `ses_01ee24b0dffeewyK1acKFnkUzC`, "Final simplify pass on Miah v1") — behavior-preserving consolidation: 14 files, +128/-192. Deduplicated helpers (`refFromIntent`, `summaryFromEvent`, `parseCases`), removed dead parameters (`writeApprovalPackage`'s unused `config`), removed dead methods (`Journal.repair()`), replaced hand-rolled `sleep` with `timers/promises`, cached `verification.all_passed`. One change was a *small bug fix* (amend.ts `previousHash` null handling), not a behavior change — and the review caught and called this out. The pass verified: `tsc` with `noUnusedLocals` clean, test suite count unchanged, every consolidation traced against per-command test files.

2. **Third-party-model code review** (commit `48fc830`, session `ses_01ed1e40effenjSowv2O3OyIom`, "Miah v1 final code review", `docs/reviews/2026-08-08-final-code-review.md`) — MiniMax-M3 reviewed the full diff vs `main`, report-only (no source modified, no commits, no pushes). The review dispatched three parallel sub-agents (commands/CLI surface, crash-safety/durability, plan-conformance + test-quality) on the riskiest surface, cross-verified by direct file reads. Findings were severity-calibrated: Critical / Major / Minor / Nit. Verdict: `APPROVE — recommend merging the PR`. 10 findings: 0 Critical, 0 Major, 6 Minor-tagged (M1, L1–L5; L3 is CI-process, not a code defect, so the review counts 5 code-defect Minors), 4 Nit (N1–N4).

3. **Fix agent with atomic per-finding commits** (commits `f727b0c`, `420f23b`, `4996089`, `82cd8d0`, `89202fa`, `7cfa855`, `dbdeae2`, `583dcea`, `0f44f21`; session `ses_01e57d6f7ffe7SnkCprtsVrC9P`, "Miah v1 final code review fixes") — one commit per finding (or per cohesive finding group), each with a `fix(<id>):` / `test(<id>):` / `chore(<id>):` prefix tagging the review finding. The fix agent also added test coverage for two gaps the review surfaced (`test(resolve): cover --decision deny path`, `test(run): assert RUN_BLOCKED_EXIT_CODE`).

The order mattered: the simplify pass ran **before** the review, so the reviewer saw a consolidated diff — reviewer attention went to the design and risk surface, not to "why are there three copies of `refFromIntent`." Running the review on an un-simplified diff would have burned review attention on noise the build team could have removed for free.

## Guidance

Five rules make the simplify-then-review-then-fix discipline trustworthy. Each is independent.

**1. Run a behavior-preserving simplify pass before the review.**
Consolidate helpers, remove dead parameters and dead methods, replace hand-rolled utilities with stdlib equivalents, rename for clarity. Every consolidation must be traced against the test suite — `tsc` with `noUnusedLocals` clean, suite count unchanged, every per-command test file checked for the specific behavior the consolidation touched. A simplify pass that is not behavior-preserving is a refactor dressed as cleanup, and the review will catch it. If a consolidation incidentally fixes a bug (e.g. the amend.ts null-hash fix), the review must call it out as a bonus fix, not fold it silently.

**2. Hand the review to a model that was not involved in the build.**
The reviewer's value is independence: it has no investment in the build's choices, no memory of why the code is shaped this way, and no blind spot the builder's training shares. MiniMax-M3 reviewing a `deepseek-v4-flash`/`glm-5.2` build is cross-family defense at the review gate (sibling `cross-family-verifier-audit-g-criteria.md`). The reviewer runs `ce-code-review` (or equivalent) in report-only mode: no source files modified, no commits, no pushes. The report is the deliverable.

**3. Calibrate findings by severity, not by vibes.**
The review's §6 ("Methodology & scope") states the calibration explicitly: a finding is rated *minor* (not medium) when the journal is honest and only a derived list is incomplete (M1); a finding is rated *nit* when the plan's default makes it unreachable in v1 (latent custody-chain race at concurrency > 1). The severity is the operator's triage input — it tells the fix agent which findings to land before the PR and which to defer to follow-ups.

**4. Route findings to a fix agent with one commit per finding.**
One commit per finding (or per cohesive finding group) makes the review→fix trail auditable: each `fix(L1): gate live-daemon E2E on paseoCliAvailable` commit maps to one review finding, with the finding ID in the commit prefix. The fix agent also adds test coverage for gaps the review surfaced — the review is not just a fix-list, it is a test-coverage input.

**5. The reviewer verifies the simplify pass explicitly.**
The review's §3 ("Simplify-pass verification") walks every consolidation: `src/commands/index.ts runGuarded routing`, `src/run-store.ts readUnitsJson dedup`, `src/snapshot.ts filename parameter`, `src/journal.ts deleted Journal.repair()`, etc. — each with a verdict (`safe`) and evidence (`grep -r "journal.repair" across src/ and test/ returns zero hits`). The verdict is: `Simplify pass overall: SAFE. No behavior regressions. One small bug fix was incidentally folded in.` The operator can call this out in the commit message.

## Why This Matters

A review on an un-simplified diff wastes the reviewer's attention on noise the build team could have removed. A review that edits source is no longer independent — the reviewer is now a co-author, and the fix trail is lost. Findings without severity force the operator to re-triage every finding. Findings without a tagged commit per finding make the review→fix trail unauditable: a `chore: address review feedback` commit hides which findings were addressed and which were deferred.

The discipline is: **consolidate → independent review → severity-calibrated findings → one commit per finding → verification.** Each phase has a single deliverable: the simplify pass produces a smaller diff; the review produces a report; the fix agent produces a trail of atomic commits. The operator's PR description can then cite the review and the fix commits, and the reviewer's severity calibration tells the reader which findings matter.

This is the same review discipline Miah itself institutionalizes one level down: a specialist's verdict has authority only after calibration, evidence is harvested artifacts not prose, and the acceptance predicate is decidable. The review gate is the acceptance predicate applied to the build's own diff.

## When to Apply

- Any multi-unit build that ends with a code review gate before the PR.
- Any diff large enough that consolidation would meaningfully reduce review noise.
- Any context where the reviewer's independence is the value — use a model that was not involved in the build.
- Any review whose findings must be triaged by the operator — severity-calibrate the findings.

## Examples

**Wrong way:**
- Run the review on the un-simplified diff → reviewer spends attention on duplicate helpers and dead parameters instead of the design surface.
- Reviewer edits source files → the review is no longer report-only; the fix trail is lost.
- One `chore: address review feedback` commit → which findings were addressed? Which deferred? The reader cannot tell.
- Findings with no severity → the operator re-triages every finding by reading the report again.

**Right way (from the Miah v1 build):**
- `0f4086b refactor(U-all): final simplify pass before review` — 14 files, +128/-192, `tsc` clean, suite count unchanged.
- `48fc830 docs(review): add final code review` — MiniMax-M3, report-only, severity-calibrated: 0 Critical, 0 Major, 5 Minor (M1, L1–L5), 4 Nit (N1–N4). Verdict: `APPROVE`.
- `docs/reviews/2026-08-08-final-code-review.md` §3 — simplify-pass verification table: one row per consolidation, verdict `safe`, evidence pointer.
- Fix commits: `f727b0c fix(M1):`, `420f23b fix(L1):`, `4996089 fix(L2):`, `82cd8d0 test(L3):`, `89202fa test(L4):`, `7cfa855 test(L5):`, `dbdeae2 test(resolve):`, `583dcea test(run):`, `0f44f21 chore(N1-N4):` — one commit per finding (or cohesive group), finding ID in the prefix.
- Review §5: "The simplify pass is genuinely safe — feel free to call it out as behavior-preserving in the commit message (and note the amend.ts null-hash cleanup as a small bonus fix)."