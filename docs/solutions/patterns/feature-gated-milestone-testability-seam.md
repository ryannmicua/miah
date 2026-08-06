---
title: Feature-gated milestones become testable via an injectable probe seam with a test-only fake
date: 2026-08-07
category: patterns
problem_type: knowledge
component: test-strategy
tags: [miah, testability, seam, fake-probe, feature-gate, e2e, substrate]
applies_when: A verification milestone or E2E suite depends on an unshipped substrate/platform feature (per-agent max-duration, a scoping flag, an immutability guarantee), and the plan claims the milestone can only run once the feature ships.
---

# Injectable probe seam: test feature-gated milestones before the feature ships

## Context

Miah's U10 milestone (full-run E2E, kill drill, operator-interface E2E) was blocked: with fail-closed admission (R4/R5), `miah start` refuses every run until Paseo ships a per-agent `max-duration` that does not exist yet. The plan's "Honest limits" had understated this — it said only "actual enforcement" was untestable, but the entire first-class verification milestone could not execute at all. No testability seam existed.

## Guidance

When a milestone depends on an unshipped substrate feature, put the substrate behind an **injectable probe interface** and provide a **test-only fake** that reports the feature "present". This makes the full pipeline E2E-testable immediately against the live adapter, while real-probe tests keep asserting fail-closed behavior against the live daemon.

Concrete shape (from the Miah plan, F4 resolution):

- Define the probe behind an interface in the production module (e.g., `src/substrate-probe.ts` exports `SubstrateProbe`).
- Admission composes `preflight ∧ probe`; the probe reports per-feature presence honestly (absent/unscopable in the real world).
- A test fixture fake (e.g., `test/fixtures/fake-substrate-probe.ts`) reports all checks "present" so `miah start` proceeds in tests.
- **Real-probe tests never use the fake** — the substrate-fail-closed test runs the real probe against the live daemon and asserts the refusal.
- When the feature ships, drop the fake and re-run the E2E suite against the live daemon.

## Why This Matters

Without the seam, an unshipped feature silently blocks the entire end-to-end verification of your own pipeline — the milestone that proves "resume is the only implementation" (the kill drill) could not run, and defects in dispatch, journaling, and acceptance would go uncaught for the lifetime of the dependency. The seam separates two claims that were being conflated: **Miah's end works** (testable now, with the fake) vs **Paseo's enforcement works** (deferred, real probe). Both are asserted; only the second is gated.

The fake never weakens the real gate: it is an injection point in test code, and the fail-closed test explicitly uses the real probe.

## When to Apply

- Any milestone whose admission path refuses to start until an external feature exists.
- Plans carrying "honest limits" — check whether the limit actually blocks a whole milestone, not just a final verification step.
- Any subsystem whose contract boundary with an external service is worth testing before the service completes.

## Examples

**Before (untestable):** "U10 full-run E2E requires the Paseo per-agent max-duration feature; it is deferred until the feature ships."

**After (testable now):** "U10 full-run E2E uses an injected fake probe (reports present); the substrate-fail-closed test uses the real probe against the live daemon and asserts the refusal. When the feature ships, drop the fake and re-run U10."
