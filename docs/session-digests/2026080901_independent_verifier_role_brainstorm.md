---
lorespec: "0.1"
id: "2026080901"
date: "2026-08-09"
source: "opencode"
topic: "Vision change: independent verifier role for Miah — grading moves out of the supervisor; brainstorm produced requirements-only plan"
tags: [miah, verification, verifier-role, vision, brainstorm, atlas-research, calibration]
classification:
  type: strategy
  secondary_type: technical
  domains: [agent-orchestration, verification, product-vision]
  value: high
trails: [miah-verifier-role, miah-vision-evolution]
---

## Session Arc

### Started
The operator asked what roles are involved in a Miah run, then how verification is determined and who determines it. The answers walked through Miah's six-role model and its D5 grading ladder (deterministic / calibrated-judge / human).

### Pivots
- **Operator rejects Miah-as-verifier.** The operator stated Miah should not do verification and pointed to research in the ~/myrepo/atlas project. Reading the atlas agentic-loop research (feedback-control model, first-loop-program "freeze the checker", verifier-benchmark-recipe) reframed the trust model: the verifier is a distinct mechanism from the controller, the checker must not be the maker, and verifiers need their own quality evidence.
- **Settled design decisions via blocking questions.** Five decisions were settled in dialogue: verifier grades everything (deterministic + judgment); Miah senses but never grades (Approach A); reviewer merges into verifier; human grades when tiers declare it or the verifier flags it; planner drafts verification contracts at plan-prep with operator approval, fail-closed per unit.
- **Brainstorm skill invoked.** The operator invoked ce-brainstorm with "what's the recommended way to implement this verifier role?" — the run produced a scoping synthesis, a 10/10-verified claim check, and a requirements-only unified plan.

### Ended
VISION.md, STRATEGY.md, and CONCEPTS.md updated (alignment verified — verdict: aligned); requirements-only plan written to docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md; wrapup requested. The Phase 4 handoff menu was dismissed by the user — next step (ce-plan vs lfg vs review) remains open.

## DECISION

### D1. Verifier grades every acceptance criterion — deterministic and judgment
- **Decision**: A dedicated verifier specialist grades every criterion (deterministic and judgment) against harvested evidence; the operator grades anything that warrants human judgment.
- **Issue**: Miah currently grades deterministic criteria itself from verification-contract exit codes (src/grading.ts:133-141) and a separate reviewer grades judgment criteria via calibrated-judge.
- **Positions**: (a) verifier grades everything; (b) verifier replaces only the reviewer, Miah keeps mechanical grading; (c) verifier for deterministic, human for all judgment.
- **Arguments**: The operator's atlas research: the controller that decides should not be the mechanism that judges; "a verifier that always passes is worse than no verifier"; concentrating judgment in the orchestrator leaves Miah's evidence discipline with no second set of eyes.
- **Warrant**: Independence is real only when the grading party is distinct from the supervising party — role separation, not the same core, must hold the judgment.
- **Qualifier**: always
- **Status**: settled
- **Provenance**: session-settled (user-directed, via blocking question)

### D2. Miah senses, verifier judges (Approach A)
- **Decision**: Miah keeps mechanically running the frozen verification-contract commands as the observable, custody-chained sensor; the verifier grades the harvested evidence. Miah enforces the acceptance predicate but never grades.
- **Issue**: How far should "Miah doesn't do verification" go — where does the mechanical check-run (the sensor) live?
- **Positions**: (a) Miah senses, verifier judges (chosen); (b) verifier runs checks and grades everything; (c) operator-authored frozen checks + judgment-only verifier.
- **Arguments**: (a) maps cleanly to the atlas model (harness = sensor layer), keeps the sensor observable and custody-chained, least new machinery; (b) purest but concentrates sensor+verifier in one session and adds a dispatch per unit; (c) most atlas-pure but conflicts with "verifier grades everything".
- **Warrant**: Sensing (running commands) and judging (grading) are separable; observability of the sensor is worth more than removing all mechanical work from Miah.
- **Qualifier**: always
- **Status**: settled
- **Provenance**: session-settled (user-directed)

### D3. Reviewer merged into verifier
- **Decision**: The reviewer role is folded into the verifier: one checker role assesses output/evidence/conformity AND grades every criterion. Tester stays as the independent-testing role.
- **Issue**: With the verifier grading everything, what happens to the reviewer (which graded judgment criteria)?
- **Positions**: merge into verifier (chosen); keep reviewer separate for conformity; drop reviewer.
- **Arguments**: One checker role, fewer per-unit dispatches (2 checkers vs 3); conformity assessment is part of grading.
- **Warrant**: Assessment and grading are the same judgment act; splitting them across two roles multiplies dispatch cost without independence gain.
- **Qualifier**: in this case
- **Status**: settled
- **Provenance**: session-settled (user-directed)

### D4. Human grading when tiers declare it or the verifier flags it
- **Decision**: Criteria declared `human` tier are operator-graded from the start; `calibrated-judge` criteria escalate when no profile clears the calibration bar; the verifier can flag any criterion it judges warrants human judgment.
- **Issue**: When exactly does the human grade instead of the verifier?
- **Positions**: tier-declared + verifier-flagged (chosen); tier-declared only; verifier discretion only.
- **Arguments**: Up-front declaration plus runtime discretion covers both planned and discovered judgment needs; reuses the existing calibration/escalation machinery.
- **Warrant**: "If verification warrants it" is both a plan-time property (declared tiers) and a run-time property (verifier confidence), and both should route to the operator.
- **Qualifier**: always
- **Status**: settled
- **Provenance**: session-settled (user-directed)

### D5. Verification contracts drafted at plan-prep, operator-approved, fail-closed per unit
- **Decision**: The planner drafts per-unit verification contracts at plan-prep; the operator approves them with the plan; contracts ride in the immutable snapshot; a unit without one fails admission; mid-run changes are scope changes.
- **Issue**: Who owns the up-front verification contracts, and what happens when a contract can't be defined?
- **Positions**: planner drafts + operator approves with plan (chosen); planner-only; operator authors.
- **Arguments**: Operator control without the authoring burden; fail-closed consistent with Miah's admission philosophy; contracts freeze before the maker starts (atlas "freeze the checker").
- **Warrant**: Checks must exist and freeze before implementation so the work can't shape its own checks.
- **Qualifier**: always
- **Status**: settled
- **Provenance**: session-settled (user-directed)

### D6. Deterministic certification needs no calibration authority
- **Decision**: The verifier certifies deterministic criteria from the mechanical evidence (all-passed, genuine, complete) with no calibration authority; calibration gates judgment grades only.
- **Issue**: The verifier's deterministic certification is a light judgment — does it need the calibration bar?
- **Positions**: no calibration for deterministic certification (confirmed); calibration for all grades.
- **Arguments**: Miah's custody chain already proves evidence integrity; certification is a completeness/genuineness check.
- **Warrant**: The calibration bar exists to gate judgment authority, and mechanical certification over custody-verified artifacts is not judgment.
- **Qualifier**: in this case
- **Status**: settled
- **Provenance**: session-settled (user-approved — surfaced as a call-out, operator assented)

## INSIGHT

### I1. Atlas agentic-loop research: verifier is a distinct mechanism from the controller
The feedback-control model in the operator's atlas project separates sensor (measures state: test output, tool logs) from verifier (judges success: rubric grader, policy checker) from controller (LLM + orchestration logic), with the design rule "never give an agent an actuator without a corresponding sensor and verifier." The first-loop-program adds: the checker must be outside the maker's authorship and frozen; "a checker that has never said 'no' is decoration." The verifier-benchmark-recipe adds: verifier layers need their own ground-truth recall/precision evidence; the dangerous number is the stack false negative (bad work that passed everything).
- **Source**: atlas repo — feedback-control-model-for-agent-loops.md, first-loop-program.md, verifier-benchmark-recipe.md
- **Confidence**: high (operator-directed source; this session's doc cites it)

### I2. Miah's current grading was the gap
Miah's code confirmed the mismatch: it runs the verification-contract commands itself (src/evidence.ts:365-377, the sensor) and grades deterministic criteria from `all_passed` (src/grading.ts:133-141) — the controller grading its own supervised work. The reviewer's calibration bar (src/calibration.ts:108-150: corpus ≥ 15, agreement > 14/15, false-blocks ≤ 2, zero false-passes) applied only to judgment criteria, leaving the deterministic layer unbenchmarked. All 10 claims in the requirements plan were verified against the code (10/10 confirmed).
- **Source**: this session's grep/read verification
- **Confidence**: high

### I3. Contract presence is enforced, contract quality is not
Fail-closed admission ensures every unit has a verification contract, but nothing scores whether a contract can actually fail (a command that always exits 0 makes deterministic criteria trivially pass). Operator review at plan approval is the only quality gate; a ground-truth benchmark pool for the verifier layer (atlas recipe) is deferred future work.
- **Source**: confirmed during brainstorm call-outs
- **Confidence**: high

## ARTIFACT

### A1. Requirements-only unified plan: Independent Verifier Role
- **Path**: docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md
- **Contents**: Goal Capsule + Product Contract: Summary, Problem Frame, 6 Key Decisions (all session-settled annotated), 6 Actors, 14 Requirements (grouped: grading ownership, human grading, verification contracts, roles/authority), 2 Key Flows (with mermaid diagram of the verification pipeline), 6 Acceptance Examples, Scope Boundaries (benchmark pool deferred, tester redesign outside, R54 integration check stays Miah's), Dependencies/Assumptions (with verified code anchors), 3 Outstanding Questions (all deferred to planning), Sources (atlas research + vision/strategy).
- **Status**: requirements-only (ce-unified-plan/v1), ready for ce-plan enrichment
- **Evolution**: created this session from the brainstorm dialogue

### A2. Vision and strategy updates
- **VISION.md** (2026-08-09): step 2 gains per-unit verification contracts generated at plan-prep; steps 5-7 now: test independently → grade independently (verifier; operator when human judgment warranted) → accept/rework (Miah applies grades, never grades); reviewer references removed (merged into verifier); out-of-scope now "implementation, testing, or grading agent".
- **STRATEGY.md** (2026-08-09, last_updated bumped): Independent assurance track covers grading + frozen up-front contracts; Not working on includes grading; corroborated-proof metric includes verifier grades.
- **CONCEPTS.md**: new glossary entries "Verifier" and "Verification contract".
- **Alignment**: vision-strategy-align rubric run twice — verdict aligned after each update.

## REFERENCE

### R1. Atlas research trail for verification
- feedback-control-model-for-agent-loops.md (sensor/verifier/controller separation, design rule, failure modes)
- first-loop-program.md (freeze-the-checker, maker-checker at design time, weak-sensor failure ledger)
- verifier-benchmark-recipe.md (ground-truth pool, recall/precision per layer, stack false negative)
- Located in C:\Users\rmicua\myrepo\atlas (spaces/ai_lab/wiki/concepts/, docs/howto/)
- **Relevance**: the grounding for the verifier-role vision change

## OPEN_QUESTION

### OQ1. Verifier benchmark pool
Whether/when to build a ground-truth benchmark pool scoring the verifier layer's stack false-pass rate (atlas verifier-benchmark-recipe). Deferred in the plan's Scope Boundaries; the calibration bar remains the authority mechanism.
- **Blocks**: nothing in v1; informs future verifier-quality work
- **Partial progress**: recipe exists in atlas; Miah's calibration corpora (default-empty) are the judgment-grade authority today

### OQ2. Evidence-package and envelope shapes for verifier grades
Which artifacts compose the verifier's evidence package (raw tester output vs Miah's harvested record) and the per-criterion grade shape in the result envelope. Deferred to planning in the plan's Outstanding Questions.
- **Blocks**: implementation planning detail only

## NEXT_STEP

### N1. Plan or ship the verifier role
The Phase 4 handoff menu was dismissed without a selection. Open paths: (a) ce-plan to enrich the requirements-only plan into an implementation plan (recommended); (b) lfg full autonomous pipeline to PR; (c) ce-doc-review pressure test; (d) more scoping dialogue.
- **Prompted by**: brainstorm completion; **Urgency**: soon

### N2. Commit the vision/strategy/concepts changes
VISION.md, STRATEGY.md, CONCEPTS.md modified and docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md untracked — all uncommitted. Commit when the operator directs (wrapup does not commit).
- **Urgency**: soon (nothing staged)

## Connections
- D1 —[led_to]→ D2, D3, D4, D6
- D1 —[informed_by]→ I1
- D2 —[informed_by]→ I1
- D5 —[informed_by]→ I1 (freeze-the-checker rule)
- D1..D6 —[led_to]→ A1, A2
- A1 —[depends_on]→ A2 (vision governs)
- I2 —[informed_by]→ R1 (contrast: Miah's current grading vs atlas model)
- I3 —[related_to]→ OQ1
- A1 —[related_to]→ OQ1, OQ2

## Trail Updates
- **miah-verifier-role** (created): vision change D1-D6, plan artifact A1, open questions OQ1-OQ2, next step N1.
- **miah-vision-evolution** (extended): A2 — VISION/STRATEGY/CONCEPTS updates with aligned verdicts.
