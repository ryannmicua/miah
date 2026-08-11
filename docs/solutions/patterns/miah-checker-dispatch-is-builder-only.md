---
title: "Miah's specialist dispatch is builder-only — tester/reviewer dispatch is specified but unimplemented"
date: 2026-08-10
category: patterns
module: miah-runtime
problem_type: architecture_pattern
component: agent-orchestration
severity: high
applies_when:
  - "Planning or reviewing any Miah feature that touches specialist roles, the Reviewing phase, the acceptance pipeline, or verifier/checker machinery"
  - "Citing phase or role behavior from doc comments, state-machine references, or architecture docs as if it were implemented runtime behavior"
tags: [miah, dispatch, reviewer, tester, verifier, runtime, review-loop, plan-review]
---

# Miah's specialist dispatch is builder-only — tester/reviewer dispatch is specified but unimplemented

## Context

While reviewing the independent-verifier plan (`docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md`), the plan's F1 flow asserted that "tester sequencing remains the existing `Reviewing`-phase behavior" and that the feature "replaces the subsequent reviewer dispatch" — grounding on `src/fsm.ts:16` (a comment) and `docs/architecture/state-machine-reference.md:19`. A deep review pass (round 2 of the review/fix loop) discovered this was not implemented behavior: the shipped runtime dispatches builders only. The claim survived the first full review round; it took an independent re-review with a grep of dispatch sites to surface — a P1 finding that cost two extra loop rounds and reshaped the plan's scope boundary.

## Guidance

1. **Treat phase/role behavior in doc comments and architecture references as intent, never as implemented behavior.** `src/fsm.ts:16` says "Tester/reviewer dispatched for a frozen candidate" — that phrase describes the phase's *intended* meaning. Verify the actual step-loop code before a plan cites it as "existing behavior."
2. **When a plan cites a role or dispatch mechanism, grep the runtime for the dispatch site.** In Miah: `src/step.ts` is the only dispatch driver; `src/dispatch.ts` (`dispatchUnit`) executes dispatches; `src/driver.ts` drives the loop. A role that appears only in `src/types.ts` (the `SpecialistRole` union, `D8I_ROLE_DEFAULTS`) and in authority tests (`src/packet.ts:44`) but in no dispatch call site is specified, not implemented.
3. **Miah-specific fact (as of 2026-08-10):** the `Reviewing` phase is entered on builder termination — `src/step.ts:548-554` runs `ensurePhase(store, "Reviewing")` → `harvestEnvelope("builder", ...)` → `harvestAndAccept` — and the only dispatch role is `"builder"` (`src/step.ts:625`). Tester and reviewer dispatch are specified in `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md` (R10, A5) but are not implemented. Any plan that needs tester/verifier/reviewer dispatch must either build it or record a sequencing dependency on it — never assume it exists.
4. **When a review finds this pattern, resolve it as a sequencing dependency, not a scope expansion.** The independent-verifier plan resolved it by recording tester dispatch as pre-existing scope owned by another plan, stating that this feature does not build it, and noting the degraded case (verifier grades an evidence package with no tester outputs) with requirements unchanged.

## Why This Matters

Plans grounded on intended-behavior docs acquire phantom dependencies: a planner will either assume a dispatch seam exists and find none, or silently expand scope to build it. This specific gap was the only P1 finding of the review loop and took the deepest review pass to surface — cheaper to check a grep than to discover mid-implementation.

## When to Apply

- Planning any Miah feature touching the `Reviewing` phase, specialist roles, the acceptance/harvest pipeline, or verifier/checker machinery.
- Reviewing any Miah plan (or CE plan) whose flows cite "existing" role dispatch or phase behavior.
- Before writing `Reviewing`-phase or checker-dispatch statements into a requirements document.

## Examples

Before (from the plan's first version, F1): "Tester sequencing remains the existing `Reviewing`-phase behavior (`src/fsm.ts:16`); this feature replaces the subsequent reviewer dispatch with the verifier dispatch."

After (corrected F1, final plan text): "Tester dispatch is pre-existing product scope specified in `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md` R10/A5 and is not yet implemented — `src/step.ts:548-554` currently harvests the builder envelope and runs acceptance directly, with no tester or reviewer dispatch. This feature does not build tester dispatch; the verifier dispatch occupies the position the reviewer dispatch was specified to hold in the `Reviewing` phase (`src/fsm.ts:16`)."

The verification pattern that caught it: grep `src/step.ts`, `src/dispatch.ts`, `src/driver.ts` for the role literal; confirm the only dispatch role is `"builder"`; read the termination branch of the step function to see what actually happens in `Reviewing`.

## Related

- `cross-family-verifier-audit-g-criteria.md` — the v1 delivery loop's checker pattern (tester/reviewer ran as orchestrated audit sessions there; this doc covers the shipped runtime, which has no such dispatch).
- `docs/session-digests/2026081001_independent_verifier_plan_review_fix_loop.md` — the review/fix loop that surfaced this.
- `docs/plans/2026-08-09-001-feat-independent-verifier-role-plan.md` — the plan containing the corrected wording.
