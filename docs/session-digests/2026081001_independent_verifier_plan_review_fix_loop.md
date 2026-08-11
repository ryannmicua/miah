---
lorespec: "0.1"
id: "2026081001"
date: "2026-08-10"
source: "opencode"
topic: "Independent verifier role plan — cross-model review/fix loop (dispatcher-operated) to GREEN"
tags: [dispatch, ce-code-review, plan-review, independent-verifier, paseo, review-loop]
classification:
  type: technical
  secondary_type: operational
  domains: [miah, agent-orchestration, plan-quality]
  value: high
trails: [miah-independent-verifier, miah-dispatch]
---

## Session Arc

### Started
Dispatcher persona active. Operator asked: dispatch a Claude Opus 5 reviewer to run `ce-code-review` on `docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md` (requirements-only CE unified plan, untracked new artifact); if findings warrant fixes, dispatch a GPT-5.6-Sol (medium reasoning) fixer.

### Pivots
- **Untracked artifact scoping** — the plan is not in git, so ce-code-review's diff machinery has nothing to review; the document itself became the reviewed artifact, with the reviewer additionally fact-checking every code anchor the plan cites.
- **Depth escalation** — round-2 review found the plan's F1 flow cites tester dispatch as "existing behavior" when the runtime has none (`src/step.ts:548-554` harvests the builder envelope and runs acceptance directly). This reframed the plan from "feature refactor" to "feature with a sequencing dependency on unimplemented tester dispatch from another plan."
- **Verdict convergence** — 12 findings (round 1) → 6 findings (round 2, mostly fix-induced collisions) → GREEN with 2 discretionary P3s (round 3). Operator aborted the P3 close-out question and requested wrapup.

### Ended
Loop closed GREEN. Plan is requirements-ready for the planning step. Wrapup requested; P3s and `vision-strategy-align` verification left open.

## ARTIFACT

### A1 — Independent Verifier Role plan (final state)
- **Status**: requirements-only CE unified plan (`docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md`), reviewed GREEN after 3 review passes and 2 fix passes. Untracked, uncommitted.
- **Evolution**: round-1 review (Opus 5) → 12 findings → GPT-5.6-Sol fixes → round-2 review → 6 new findings (N1-N6) → round-2 fixes → round-3 review → GREEN.
- **Final requirement set**: R1-R17. New: R15 (sensor sources commands from frozen snapshot contract via existing `verificationCommandsFor` seam), R16 (human-tier criteria satisfied only by operator grade; at-or-above-tier substitution disabled for them), R17 (verifier replaces reviewer identifier; old journals/snapshots replayable; `Reviewing` phase name unchanged; rename updates `src/types.ts:306,316-324`, `src/packet.ts:44`, and prose in `docs/architecture/design-decisions.md` §14 + `state-machine-reference.md:19`).
- **Key structural changes from reviews**: R1 scoped to non-human-tier criteria; R7 adds third operator-grade source (calibration-ungraded); R10 fail-closes on absent OR empty contracts; R4 presents calibration bar as operator-configurable defaults + unconditional zero-false-pass floor; F1 + mermaid sequence tester before harvest; mermaid adds direct deterministic-certification path to the predicate; AE7/AE8 added; Scope Boundaries permit evidence-package composition from already-harvested per-role artifacts.
- **Trace**: informed_by `2026080901_independent_verifier_role_brainstorm` digest.

## DECISION

### D1 — Verifier grades every non-human-tier criterion; human-tier goes to the operator from the start
- **Issue**: R1's literal "every criterion" contradicted R5/R16 (operator-only human-tier grading) — N2.
- **Positions**: (a) scope R1 to non-human criteria; (b) keep universal grading with an unstated advisory grade for human-tier.
- **Arguments**: (b) required inventing an advisory-grade mechanism with no requirement behind it; (a) matches the existing three-tier vocabulary (`deterministic`, `calibrated-judge`, `human` in `src/grading.ts:123-130`) and VISION step 6's carve-out.
- **Warrant**: the plan should describe one grading path per tier; the operator-grade path for human criteria is the settled product direction.
- **Qualifier**: always (as recorded in plan).
- **Status**: settled (plan text).

### D2 — F1's tester dispatch recorded as a non-blocking sequencing dependency, not an open blocker
- **Issue**: F1 asserted "existing Reviewing-phase behavior" for tester dispatch that does not exist in the runtime (N1, P1).
- **Positions**: (a) mark tester dispatch an open blocker in Goal Capsule; (b) record it as independent pre-existing scope (`miah-runtime-specialist-invocation-plan` R10/A5) with a degraded-case note (verifier grades a package with no tester outputs; requirements hold unchanged).
- **Arguments**: (b) keeps the feature shippable without tester dispatch, which is out of this plan's scope; reviewer confirmed "Open blockers: None" is then correct.
- **Warrant**: this feature's exit bar does not include building tester dispatch; the plan's requirements are robust to its absence.
- **Qualifier**: in this case.
- **Status**: settled (plan text).

### D3 — Evidence-package composition from already-harvested artifacts is in scope
- **Issue**: F1's harvested package gained "tester outputs" while Scope Boundaries declared harvest changes Outside (N3, P2).
- **Positions**: (a) keep all harvest changes out of scope, forcing the package decision into a contradiction; (b) split the boundary — custody-chaining primitives/hash-chain mechanics Outside; composing the verifier's package from already-harvested per-role artifacts In scope.
- **Arguments**: (b) resolves the collision and lets the Outstanding-Questions deferral on package contents remain a real planning decision.
- **Warrant**: custody integrity is the frozen surface; package assembly is a presentation decision.
- **Qualifier**: always.
- **Status**: settled (plan text).

### D4 — Deterministic certification bypasses the calibration gate in the flow diagram
- **Issue**: mermaid routed all verifier output through the calibration gate, contradicting R3/KD6 (N4, P3).
- **Positions**: add a direct `V -->|deterministic certification| P` edge and relabel the gate edge to "judgment grade needs authority".
- **Arguments**: matches the prose and the settled KD6 scope default; diagram now illustrates what the text says.
- **Qualifier**: always.
- **Status**: settled (plan text).

### D5 — R17 records implementation-time doc-drift updates instead of deferring them
- **Issue**: the reviewer→verifier rename invalidates prose in `design-decisions.md` §14 and `state-machine-reference.md:19`; the plan didn't say whether updating them is in scope (N5, P3).
- **Positions**: (a) record the doc updates as in-scope implementation work; (b) defer and track separately.
- **Arguments**: (a) leaves no ambiguity for the planner; the docs are small and the rename is one PR.
- **Qualifier**: usually.
- **Status**: settled (plan text).

### D6 — Operator close-out of P3s pending (question aborted)
- **Issue**: round-3 GREEN left two discretionary P3 items — a mermaid edge for tier-declared human criteria (`H -->|human-tier criteria| O`) and two stale phrasings (Dependencies "tester's role is unchanged" bullet vs sequencing bullet; R13 "as today's checkers"). Fixer wording supplied by reviewer.
- **Positions**: apply both then close; close as-is; apply + also verify vision-strategy-align.
- **Status**: provisional — operator aborted the question; decide at next session.

## INSIGHT

### I1 — Miah's runtime has no tester or reviewer dispatch; `Reviewing` harvests the builder envelope directly
`src/step.ts:548-554`: builder terminates → `ensurePhase(store, "Reviewing")` → `harvestEnvelope("builder", ...)` → `harvestAndAccept`. Dispatch sites are builder-only (`src/step.ts:625`); grep of `src/` finds no tester/reviewer dispatch path (checked `src/step.ts`, `src/dispatch.ts`, `src/driver.ts`). Tester/reviewer dispatch is *specified* in `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md` (R10, A5) but unimplemented. Source: round-2 reviewer finding N1 + dispatcher's independent grep. Confidence: high.

### I2 — R17's replayability claim is sound: journal roles are free strings
`src/replay.ts:115` reads roles as `role: asString(p.role) ?? "unknown"` with no enum validation, so historical `role: "reviewer"` records replay unchanged. The `reviewer` literal lives at `src/types.ts:306` (SpecialistRole union), `src/types.ts:323` (D8I_ROLE_DEFAULTS), `src/packet.ts:44` (read-only authority test), and `test/packet.test.ts:116`. Confidence: high (reviewer-verified).

### I3 — The calibration bar is operator-configurable; only the zero-false-pass floor is unconditional
R4 originally hardcoded "corpus ≥ 15, agreement > 14/15, false-blocks ≤ 2" as a requirement; those are config defaults (`calibration.min_corpus`, `min_agreement`, `max_false_blocks` in operator config, `src/calibration.ts:108-150`). Requirement now describes defaults + unconditional `falsePasses === 0` floor. Confidence: high.

### I4 — The plan's product authority is verified: VISION/STRATEGY grounding is accurate and improved by the R1 scope fix
VISION steps 2, 5-7 and STRATEGY "Independent assurance" match the plan across all three review rounds; the narrowed R1 is a faithful reading of VISION step 6's carve-out. Confidence: high.

## PATTERN

### P1 — Cross-model review/fix loop for planning artifacts (dispatcher-operated)
- **Scope**: local (Miah dispatch workflow; generalizable to other agent-orchestrated repos).
- **Components**: (1) reviewer on a different model family than the fixer (Claude Opus 5 reviews, GPT-5.6-Sol fixes); (2) reviewer given an exit bar: VERDICT GREEN/RED plus fix-ready findings (severity, section, concrete suggested fix) so a separate agent can apply them without re-reviewing; (3) same reviewer re-verifies its own prior findings across rounds (fresh review of worker's changes, not a mirror of the worker); (4) dispatcher supervises by reading the file and independently spot-checking critical claims (e.g., grep-verifying the N1 tester-dispatch absence); (5) escalation rule: two consecutive RED review passes → stop and bring to operator.
- **Outcome**: 12 → 6 → GREEN in three rounds; convergence visible (round-2 findings mostly caused by round-1 fixes colliding).
- **Why it works**: verifier independence from the worker, exact fix text, and the supervisor's claim-spot-check each catch different error classes.

## OPEN_QUESTION

### Q1 — Apply the two P3s or close as-is?
Round-3 GREEN with 2 discretionary P3s (mermaid human-tier edge; two stale phrasings in Dependencies/R13). Reviewer supplied exact fix text. Blocks: final plan text decision. Status: pending operator.

### Q2 — Was `vision-strategy-align` run after the VISION/STRATEGY changes?
VISION.md, STRATEGY.md, CONCEPTS.md are uncommitted working-tree modifications; CLAUDE.md requires `vision-strategy-align` after either changes, and no reviewer could confirm it ran (out of scope for report-only review). Reviewers found no drift between the three rounds, so risk is low, but the required run is unverified. Status: unverified.

## NEXT_STEP

### N1 — Operator decides P3 close-out for the plan (now)
Prompts: Q1. Options: apply the two P3 fixes (fixer dispatch + supervision), close as-is, or additionally run `vision-strategy-align`. Urgency: now.

### N2 — Commit the plan (and pending docs) once closed (soon)
The plan, the brainstorm digest `2026080901`, and the VISION/STRATEGY/CONCEPTS edits are all uncommitted. Plan review is GREEN; the plan can move to planning (ce-plan) or operator approval, then commit. Urgency: soon.

### N3 — Run `vision-strategy-align` per AGENTS.md (soon)
Prompts: Q2. Required after VISION/STRATEGY changes; unverified this session. Urgency: soon.

## Connections
- A1 —[informed_by]→ 2026080901 digest (trail: miah-independent-verifier)
- D1 —[led_to]→ A1 (R1 text)
- D2 —[informed_by]→ I1; —[led_to]→ A1 (F1 + Dependencies)
- D3 —[led_to]→ A1 (Scope Boundaries)
- D4 —[led_to]→ A1 (mermaid)
- D5 —[led_to]→ A1 (R17)
- I1 —[informed_by]→ P1 (dispatcher spot-check); I1 —[led_to]→ D2
- I2 —[supports]→ D5 (R17 soundness)
- I3 —[led_to]→ A1 (R4 wording)
- I4 —[related_to]→ Q2
- Q1 —[depends_on]→ A1 (final text)
- P1 —[instance_of]→ dispatcher loop (heypogi dispatch-setup persona)

## Trail Updates
- **miah-independent-verifier**: extended — plan went from brainstorm (20260809) to GREEN-reviewed requirements-only artifact with R15-R17.
- **miah-dispatch**: extended — first full dispatcher-operated review/fix loop recorded; P1 pattern reusable.
