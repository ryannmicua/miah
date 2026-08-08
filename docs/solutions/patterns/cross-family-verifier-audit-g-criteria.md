---
title: "Cross-family verifier pairing with a plan-audit G-criteria file"
date: 2026-08-08
category: patterns
problem_type: knowledge
component: agent-orchestration
tags: [miah, agent-orchestration, cross-family, verifier, audit, g-criteria, plan-audit, evidence, verification, cross-project]
applies_when: "Orchestrating a multi-specialist build loop (Paseo agents, Task subagents, scheduled agents) where a builder implements plan units and an independent verifier audits each unit against the plan's exit bars — and the verifier must come from a different model family than the builder to hedge shared blind spots."
---

# Cross-family verifier pairing with a plan-audit G-criteria file

> **Cross-project knowledge.** This pattern is staged in the Miah repo because the validating implementation happened here, but it applies to any orchestrated build loop that dispatches a builder and an independent checker per unit — Paseo agent loops, OpenCode/`opencode` Task subagent loops, or any harness where a builder's self-report is an input, not a fact. The operator will synthesize it into other projects.

## Context

The Miah v1 implementation plan (`docs/plans/2026-08-06-003-miah-implementation-plan.md`) split the build into ten sequential units (U1–U10) and required that every unit carry a verification bar an independent agent re-runs from disk (the disk-first supervision loop pattern, sibling `disk-first-paseo-loop.md`). The plan's Product Contract states: *"a builder's self-report is an input, not a fact"* and *"evidence is what Miah harvests from artifacts — diffs, exit codes, test outputs, usage deltas — never agent prose."*

Two structural decisions made the verification trustworthy:

1. **Cross-family contrast is enforced per unit.** The plan's D8-i role→model defaults table pins the builder to `opencode-go/deepseek-v4-flash` and the tester/reviewer to `opencode-go/glm-5.2` (different model families). Plan line 95: *"Cross-family contrast is enforced per D2-c.5 (builder ≠ checker per unit)."* The prior brainstorm (`docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md:100`, R20) is explicit that cross-family is a hedge, not authority: *"cross-family contrast is only a hedge, and a criterion escalates to operator judgment when no profile clears the bar."* Calibration is authority; cross-family is defense-in-depth.

2. **The plan's exit bars were converted into a checkable audit file.** `docs/plans/2026-08-06-003-miah-implementation-plan.audit.md` (commit `23fcfe2`) derives every unit's acceptance criteria from the plan — no criteria invented outside the plan — and presents them as a table per unit: `G-criterion | how to verify | plan source`. The verdict is binary: `PASS` (evidence shown) or `FAIL` (evidence missing or contradicts). No partials; a gap in evidence is a FAIL. A frozen-rule block forbids the builder from modifying carried-forward requirements; a sequencing-check block forbids auditing a unit whose `depends-on` unit is not yet accepted.

The implementation executed this and the pattern held. Session metadata (opencode.db, 2026-08-07 → 2026-08-08) shows paired builder/verifier sessions per unit — e.g. `ses_025a4b1e1ffe0I0THZHfei2Nx8` "Implementing U7…" followed by `ses_02594b3f2ffeYUFo6idsyTJjKN` "U7 audit: grading ladder & acceptance verification"; `ses_0258fc038ffeoiYg1cU5qhvxLv` "Implementing Miah U8…" followed by `ses_025633da9ffeYZByPfuE5p01SS` "U8 audit: FSM, step function, driver verification." Each audit session ran on `opencode-go/glm-5.2` against work the builder session (on `opencode-go/deepseek-v4-flash`) had committed. The final pre-PR code review was then run by MiniMax-M3 (yet another family) — a third layer of cross-family defense on the accumulated diff.

## Guidance

Five rules make verifier pairing trustworthy. Each is independent.

**1. Convert the plan's exit bars into a per-unit audit file before the first builder dispatch.**
The audit file is a derived artifact: every criterion cites its plan source (e.g. `U7.11 — plan U7 Approach`). It is NOT a new plan and adds nothing to the plan; if a criterion contradicts plan text, the plan wins. The auditor's job is mechanically to check evidence against criteria, not to re-design the plan. A criterion cannot pass without shown evidence — agent prose is never evidence.

**2. Pair every builder unit with a verififier from a different model family.**
The builder runs on one family (e.g. `deepseek-v4-flash`); the tester/auditor runs on another (e.g. `glm-5.2`). Cross-family contrast hedges shared-training blind spots: a failure mode one family systematically misses is more likely to be caught by a checker trained differently. The verifier is dispatched fresh (disk-first: reads git and the worktree, never the builder's chat context — see sibling `disk-first-paseo-loop.md`) and instructed to **re-run every gate itself**: `npm test -- --grep "<unit-tag>"`, `npm run build`, direct file inspection. The builder's claims are unverified inputs.

**3. Verdicts are binary and evidence-anchored.**
`PASS` (evidence shown) or `FAIL` (evidence missing or contradicts). No partials; no "mostly works." A `FAIL` names the criterion and the missing/contradicting evidence. Two consecutive `FAIL` verdicts on the same unit, or a broken dependency, stop the audit and escalate to the operator — the auditor never patches the builder's work.

**4. Audit in plan sequence; never audit a unit whose dependency is not accepted.**
The audit file carries a sequencing-check block enforcing the plan's dependency chain (U4 may run in parallel with U2; U8 depends on all of U2–U7; U10 depends on all). Auditing out of sequence hides integration defects behind a unit whose inputs were assumed, not verified.

**5. Treat cross-family as a hedge, not authority — calibration is the authority.**
The prior brainstorm's R20 is explicit: cross-family contrast is only a hedge. A checker's verdict has authority only after its profile clears the calibration bar (the Miah plan's D7-d: `≥15-case` corpus, `>14/15` agreement, `≤2` false-blocks, zero false-pass floor — sibling `feature-gated-milestone-testability-seam.md`). When no calibrated different-family reviewer is available, the plan's AE6 (2026-08-06-001 plan:152) says: record provenance and let authority come from calibration, not from cross-family corroboration. Cross-family is defense-in-depth, not a substitute for calibration.

## Why This Matters

A builder auditing its own work inherits its own blind spots; a same-family checker inherits the family's blind spots. The cross-family hedge is the cheapest way to surface a class of defect the builder's training systematically under-weights — at the cost of one extra dispatch per unit. The audit file is the mechanism that makes the hedge rigorous: without checkable criteria anchored to the plan, the "audit" becomes the checker's vibes, which is exactly the judgment call the disk-first loop refuses to let the builder make about itself.

The pattern also protects against scope drift. The audit file's freeze rule forbids the builder from modifying carried-forward requirements; the sequencing check forbids auditing a unit before its dependencies. A builder that quietly weakens a requirement or implements a dependent unit before its inputs are verified is a `FAIL` on the unit and an escalation — not a patch the auditor applies.

This is the same verification discipline Miah itself institutionalizes one level down: specialists' verdicts have authority only after calibration, evidence is harvested artifacts not prose, and the acceptance predicate is decidable. Orchestrating Miah's own build with this discipline is the principle applied to itself.

## When to Apply

- Any orchestrated build loop that dispatches a builder and an independent checker per plan unit.
- Any plan whose exit bars can be written as checkable criteria (file existence, command exit codes, test grep tags, structural rules).
- Any context where a builder's self-report is the only record of its work — the checker re-runs every gate from disk.
- Especially: implementation loops where each unit has a verification bar a fresh verifier can re-run independently.

## Examples

**Wrong way:**
- Same-family checker reading the builder's chat report and trusting the builder's exit codes.
- "Audit" as a free-form review with no criteria file — the checker's impressions, not the plan's bars.
- Auditing a dependent unit before its dependency is accepted, hiding integration defects.
- Claiming authority from cross-family contrast alone, without calibration.

**Right way (from the Miah v1 build):**
- Audit file `docs/plans/2026-08-06-003-miah-implementation-plan.audit.md` carries per-unit G-criteria (U6.1–U6.10, U7.1–U7.14, …) each citing plan source; verdicts are `PASS`/`FAIL` with evidence pointers (`file:line`, test grep tag, command output).
- Builder session `ses_025a4b1e1ffe0I0THZHfei2Nx8` on `deepseek-v4-flash` implements U7 and commits; verifier session `ses_02594b3f2ffeYUFo6idsyTJjKN` on `glm-5.2` re-runs `npm test -- --grep "acceptance"`, `npm test -- --grep "gap"`, `npm test -- --grep "grading"`, `npm test -- --grep "integration"`, inspects `src/calibration.ts` for the R74 bar, and returns verdicts.
- Final pre-PR code review on MiniMax-M3 (commit `48fc830`, `docs/reviews/2026-08-08-final-code-review.md`) — a third family reviewing the accumulated diff, report-only, severity-calibrated (Critical/Major/Minor/Nit), findings routed to atomic per-finding fix commits.
- **Lost:** nothing the operator cares about. **Preserved:** every plan bar, checked independently, on disk.