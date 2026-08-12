---
title: Verifier 'ungraded' verdict misrouted to rework instead of escalate
date: 2026-08-12
category: logic-errors
module: verifier grading pipeline (src/step.ts, src/grading.ts)
problem_type: logic_error
component: tooling
severity: medium
symptoms:
  - A verifier-declared ungraded verdict starts builder rework instead of operator escalation
  - Deterministic-tier criteria with an ungraded verifier verdict route to rework with basis no-verifier-certification
  - Calibrated-judge criteria with an ungraded verifier verdict route to rework instead of escalate (R48/R20)
  - Builder takes are consumed on candidates the verifier explicitly declined to grade, violating plan take limits
root_cause: logic_error
resolution_type: code_fix
tags:
  - verifier
  - grading
  - escalation
  - ungraded-verdict
  - authority-semantics
---

# Verifier "ungraded" verdict misrouted to rework instead of escalate

**Bug track | logic error | fixed in PR #9 (squash `ea58d3f`), merged to `main`**

Discovered by the minimax-m3 cross-family `ce-code-review` audit (run `20260812-025555`, branch `feat/independent-verifier-role`, base `db5cf62`), verified against code by the orchestrator before fixing, fixed before shipping PR #9 (interim fix commit `34597a0`), merged as squash commit `ea58d3f` (PR #9, https://github.com/ryannmicua/miah/pull/9). Durable audit trail: `docs/residual-review-findings/feat-independent-verifier-role.md` and `docs/session-digests/2026081201_independent_verifier_ship_and_merge.md` (line 27).

All line citations below are to the current tree on `main` (HEAD `45a1239`), which contains the fix (`ea58d3f` is an ancestor of HEAD and `git branch --contains ea58d3f` reports `main`).

## Problem

Miah's D5 verdict vocabulary is exactly three values — `pass | fail | ungraded` (`src/envelope.ts:34`: `D5_VERDICTS = ["pass", "fail", "ungraded"] as const`) — and `ungraded` is a first-class, meaningful verdict: the verifier specialist declares it when it *cannot decide* (mechanical evidence insufficient for a certification, or judgment unavailable). Product semantics (KTD4/KTD6/R48) treat a verifier-side `ungraded` as an authority-respecting outcome: the verifier withheld its verdict, so the run must **escalate to the operator**, never start builder rework. Rework on an `ungraded` grade is doubly wrong: it burns a builder take on a candidate the verifier explicitly declined to grade (violating the plan's take limits, R77/R78), and it routes an authority-respecting outcome through the wrong control flow — the acceptance predicate never escalates, so the operator never sees the "verifier cannot decide" signal.

During the PR #9 feature work (independent verifier role), this semantic was violated end-to-end: a verifier-declared `ungraded` verdict was converted to `null` on its way into grading and then routed to builder rework by both grading tiers (deterministic and calibrated-judge, via their missing-verdict fall-backs). The `null` path is reserved for the genuinely different condition "no envelope entry at all" (R43), and conflating the two erased the verifier's declaration. (The exact pre-fix basis strings are not recoverable from git history — the intermediate state was squashed — but the P1 finding is recorded in `docs/residual-review-findings/feat-independent-verifier-role.md` and the mechanism is corroborated by the pre-fix calibrated-judge catch-all routing ungraded to rework.)

## Symptoms

- A verifier-declared `ungraded` verdict started builder rework instead of operator escalation.
- Deterministic-tier criteria with an ungraded verifier verdict were graded `ungraded`/`route: rework` via the tier's missing-certification fall-back — as if the verifier had never spoken.
- Calibrated-judge criteria with an ungraded verifier verdict were graded `ungraded`/`route: rework` via the tier's missing-verdict fall-back — as if the envelope entry were missing (R43).
- Builder takes and rework cycles were consumed on candidates the verifier explicitly declined to grade; no `escalation_raised` event fired and the run never paused in `Attention` for the "cannot decide" case, so the operator was never consulted.
- Indirect evidence in the e2e suite: the header comment of `test/e2e/full-run.test.ts:9-15` still describes the pre-fix flow ("The implemented U7/U8 ladder grades it ungraded/route-rework, so after the unit's rework budget is exhausted the run pauses"), while the test body (lines 152-169) asserts the corrected behavior — the ungraded verdict pauses the run in `Attention` immediately with a `no-checker-profile-clears-calibration-bar` escalation. The header comment is stale relative to the fix (see Related Issues).

## What Didn't Work

1. **Silent value coercion at the boundary** — in the verifier-grading block of `src/step.ts`, the verifier's envelope `entry.verdict` was converted to `null` whenever it was not `pass`/`fail`, collapsing the declared `"ungraded"` verdict into the "missing envelope" sentinel. This erased the distinction the fix itself drew in the type: `CriterionEvidence.verifierVerdict?: "pass" | "fail" | "ungraded" | null` (`src/grading.ts:104`) — `"ungraded"` is the verifier's own declaration (KTD4), `null` means the envelope entry is missing entirely (R43). (Pre-fix, the field was the reviewer-era `reviewerVerdict?: "pass" | "fail" | null`; the `ungraded` widening landed with the fix.)
2. **Grading tiers with no `ungraded` branch** — `gradeDeterministic` fell through to its null path (`no-verifier-certification`, `route: "rework"`) and `gradeCalibratedJudge` fell through to its missing-verdict path (`no-verifier-verdict (missing envelope, R43)`, `route: "rework"`) whenever the verdict was `ungraded`. The distinction between "verifier said it cannot decide" and "verifier said nothing" did not survive to routing.
3. **Test coverage gap on the declared value** — unit and step tests covered `pass`, `fail`, and the missing-verdict `null` path, but no test fed `verdict: "ungraded"` end-to-end, so the misrouting was invisible to the suite. This was finding-level P1 from the minimax-m3 `ce-code-review` audit (run `20260812-025555`; see `docs/residual-review-findings/feat-independent-verifier-role.md:3` — findings #1 (P1), #2 (P1), #3 (P2), #6 (P2) were applied in Step 5 — and `docs/session-digests/2026081201_independent_verifier_ship_and_merge.md:27`: "minimax-m3 review found 4 actionable findings (2 P1: verifier `ungraded` misrouted to rework; historical `reviewer`-role replay clobbering state) — all verified against code, fixed, suite held").

## Solution

Fixed in PR #9 (squash commit `ea58d3f`, interim fix commit `34597a0` on the feature branch), merged to `main`. Three coordinated changes, all present in the current tree:

1. **Pass the verdict through unchanged** — `src/step.ts:1124` now reads `verifierVerdict: entry.verdict`, with an explicit comment at lines 1121-1123: the verifier's verdict passes through unchanged — including its own `ungraded` declaration, which grading routes to escalation (never converted to the null "envelope missing" path).
2. **`gradeDeterministic` gains an ungraded branch** — `src/grading.ts:167-172`: `verifierVerdict === "ungraded"` returns `{ grade: "ungraded", route: "escalate", basis: "verifier-ungraded: mechanical evidence insufficient" }` (basis at line 171). The fall-through null path (`src/grading.ts:173`, basis `no-verifier-certification`, `route: "rework"`) remains reserved for the missing-certification/missing-envelope case.
3. **`gradeCalibratedJudge` gains an ungraded branch** — `src/grading.ts:183-187`: `verdict === "ungraded"` returns `{ grade: "ungraded", route: "escalate", basis: "verifier-ungraded: judgment unavailable" }` (basis at line 186). The missing-verdict branch (`src/grading.ts:188-190`, basis `no-verifier-verdict (missing envelope, R43)`, `route: "rework"`) is untouched and remains reserved for the missing-envelope case.

Tests added (present in the current tree):

- `test/grading.test.ts:64-71` — "deterministic: a verifier-declared ungraded verdict escalates, never builder rework (KTD4/R48)": asserts `grade: "ungraded"`, `route: "escalate"`, basis `verifier-ungraded: mechanical evidence insufficient`.
- `test/grading.test.ts:139-150` — "calibrated-judge: a verifier-declared ungraded verdict escalates, never builder rework (KTD4/R48)": asserts `grade: "ungraded"`, `route: "escalate"`, basis `verifier-ungraded: judgment unavailable`.
- Null-path regression coverage retained: `test/grading.test.ts:59-62` (deterministic, no certification -> `route: "rework"`, basis `no-verifier-certification`) and `test/grading.test.ts:128-137` (calibrated-judge, missing verdict `null` -> `route: "rework"`, basis contains `no-verifier-verdict`).
- `test/step.test.ts:477-532` — "U5.AC3: a verifier-declared ungraded verdict escalates on deterministic and calibrated-judge criteria (KTD4/R48)": a step-harness unit with one deterministic criterion (`U1.AC1`) and one calibrated-judge criterion (`U1.AC2`), the verifier envelope declaring `verdict: "ungraded"` for both, drives to termination and asserts:
  - both criteria recorded as `grade: "ungraded"`, `route: "escalate"` with the respective bases (`test/step.test.ts:515-524`) — the declaration is preserved, never converted to a rework-grade null;
  - the unit is not `accepted` (`:526`) and `rework_cycles` is `0` — no rework cycle started (`:527`);
  - the run paused in phase `Attention` (`:528`);
  - an `escalation_raised` journal event exists (`:529-531`).

## Why This Works

- **The distinction is preserved end-to-end.** The envelope vocabulary names `ungraded` as a valid verdict (`src/envelope.ts:34`); `src/step.ts:1124` forwards it unchanged; and each grading tier has an explicit branch that maps it to `route: "escalate"` with a distinct audit basis. `null` now unambiguously means "no envelope entry" (R43) — the only condition that reworks.
- **Routing follows the authority model, not the string shape.** An `ungraded` verdict is the verifier's own declaration that it cannot decide (KTD4). Escalation is the only control flow that surfaces that declaration to the operator; rework would silently retry a candidate nobody graded. The basis strings make the audit trail honest: "verifier-ungraded: mechanical evidence insufficient" (deterministic), "verifier-ungraded: judgment unavailable" (calibrated-judge), and "no-verifier-certification"/"no-verifier-verdict (missing envelope, R43)" (missing) are now three distinguishable events in the journal.
- **The acceptance predicate does the rest.** An `ungraded`/`escalate` record is a non-pass that escalates (`test/acceptance.test.ts:128-144` pins `grade: "ungraded"`, `route: "escalate"` -> escalate verdict; the e2e calibrated-judge path at `test/e2e/full-run.test.ts:152-169` shows the run pausing in `Attention` with an escalation when the verdict stays ungraded). Once the route is `escalate`, no builder take or rework cycle is spent — the U5.AC3 step test pins `rework_cycles === 0` and phase `Attention`.
- **The fix is small, local, and typed.** `CriterionGradeValue` already included `"ungraded"` (`src/grading.ts:52`), and the fix widened the evidence type to carry `ungraded | null` (`src/grading.ts:104`) — the code stopped erasing the value at the boundary.

## Prevention

- **Honor declared vocabularies end-to-end (schema -> pipeline -> routing).** If a contract declares a three-valued verdict, every layer that consumes it needs an explicit branch per value; a fall-through that converts a declared value into a sentinel is a bug in disguise. The miah pattern post-fix: `D5_VERDICTS` (`src/envelope.ts:34`) -> pass-through at `src/step.ts:1124` -> per-value branches in `src/grading.ts` -> escalate/rework routing in acceptance.
- **Test the declared values, not just the sentinels.** The missing-envelope `null` path was tested; the verifier-declared `ungraded` path was not, which is exactly how the misrouting shipped. For every value legal at a boundary, add a test that feeds that value end-to-end — the U5.AC3 step test (`test/step.test.ts:477-532`) does this for both tiers in one harness.
- **Keep audit-basis strings distinct per condition.** `no-verifier-certification`, `no-verifier-verdict (missing envelope, R43)`, `verifier-ungraded: mechanical evidence insufficient`, `verifier-ungraded: judgment unavailable` — one basis per distinguishable condition. Distinct bases make a regression like this visible in the journal without re-reading the code.
- **Cross-family review as a safety net.** The bug was found by a minimax-m3 `ce-code-review` audit (run `20260812-025555`), independently verified against code by the orchestrator before fixing, and the suite held after the fix. The durable record lives in `docs/residual-review-findings/feat-independent-verifier-role.md` and `docs/session-digests/2026081201_independent_verifier_ship_and_merge.md:27`.

## Related Issues

- **PR #9** (merged, squash `ea58d3f`): "feat(verifier): move grading out of Miah into an independent verifier role" — https://github.com/ryannmicua/miah/pull/9. The `ungraded` misrouting was one of two P1 findings fixed before shipping; the other P1 (historical `reviewer`-role replay clobbering state) was fixed in the same PR.
- **Interim fix commit** `34597a0` ("feat(verifier): move grading out of Miah into an independent verifier role") — the pre-squash commit on the feature branch whose squash onto `main` is `ea58d3f` (PR #9). Current `main` HEAD is `45a1239` (manager explainer commit); `ea58d3f` is an ancestor of HEAD and is contained in the `main` branch.
- **Residual review record**: `docs/residual-review-findings/feat-independent-verifier-role.md` — source: `ce-code-review` run `20260812-025555` (minimax-m3 audit) on branch `feat/independent-verifier-role` (base `db5cf62`); findings #1 (P1), #2 (P1), #3 (P2), #6 (P2) applied in Step 5; advisories #4/#5/#7/#8/#9 deferred.
- **Session digest**: `docs/session-digests/2026081201_independent_verifier_ship_and_merge.md` — "Audit + fixes: minimax-m3 review found 4 actionable findings (2 P1: verifier `ungraded` misrouted to rework; historical `reviewer`-role replay clobbering state) — all verified against code, fixed, suite held" (line 27); "PR #9 merged (squash `ea58d3f`) ... merge verified via `gh pr view` (MERGED, mergeCommit `ea58d3f`)" (lines 29, 40).
- **Stale-comment follow-up** (minor, unfixed as of HEAD `45a1239`): `test/e2e/full-run.test.ts:9-15` still describes the pre-fix flow ("grades it ungraded/route-rework, so after the unit's rework budget is exhausted the run pauses") while the test body (lines 152-169) asserts the corrected escalate-to-Attention behavior. Worth a doc-only cleanup in a later PR.
- **Related patterns in this repo's knowledge base**: `docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md` (the audit practice that caught this bug) and `docs/solutions/patterns/simplify-before-third-party-code-review.md` (report-only review discipline: findings verified against code before applying).
