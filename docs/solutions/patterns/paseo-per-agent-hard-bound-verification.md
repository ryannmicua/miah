---
title: Paseo has no per-agent hard bound; schedule-expiry precedent proves the feature ask is feasible
date: 2026-08-07
category: patterns
problem_type: knowledge
component: paseo-substrate
tags: [paseo, miah, r4, hard-bound, max-duration, fail-closed, feature-ask, verification]
applies_when: Verifying whether a crash-surviving enforcement mechanism exists on the Paseo substrate, or deciding how Miah's R4/R5 requirement can be satisfied before its planned feature ships.
---

# Paseo per-agent hard bound: verified absent, precedent-backed feature ask

## Context

Miah's D1/D2 plan required every specialist dispatch to carry a hard termination/containment bound that holds while the Miah CLI process is dead (R4/R5). Two parallel brainstorms converged on this requirement, but neither had verified the mechanism exists. This session verified it against the live Paseo surface (v0.3.0-beta.2) to decide whether the requirement could stand or needed reframing.

## Guidance

**Verify a feature-ask feasibility against the live substrate before rewriting requirements around it.** The R4 correction is only as strong as the mechanism it rests on — a feature ask grounded in an existing daemon enforcement primitive is materially stronger than one grounded in hope.

Verified facts (2026-08-06, Paseo v0.3.0-beta.2):

- `paseo agent run --help` exposes only `--wait-timeout`, which bounds the **waiter** (the CLI), not the agent's work. If Miah dies, the agent runs on.
- `paseo agent update --help` has no duration/expiry/budget flags. Persisted agent records (`~/.paseo/agents/*.json`) carry only `mode`/`model`/`thinking` — no expiry fields.
- Daemon `~/.paseo/config.json` has no per-agent bound keys.
- **The precedent exists**: the daemon already enforces `expiresAt`/`maxRuns` on schedules (`~/.paseo/schedules/*.json` shows daemon-enforced expiry on recurring jobs). Schedules and agents are the same daemon-managed object class in the same `~/.paseo/` store.
- Evidence continuity is NOT the problem: the daemon persists agent lifecycle independently of Miah, so reconstruction after a crash works today.
- Enforcement is the genuine gap: nothing stops a running agent while Miah is dead.

## Why This Matters

The feasibility verdict changes what Miah's requirements can honestly claim. The correct framing is **fail-closed acceptance, not containment**: a dead Miah cannot stop a runaway specialist (bounded **cost** exposure), but the plan's own R16 + R9/R13 (specialists never write canonical state; isolated worktrees) already prevent **correctness** exposure. So Miah guarantees: refuse to accept anything past a recorded deadline, terminate on resume, and fail admission until the daemon-enforced per-agent `max-duration` feature ships.

A daemon-enforced per-agent `max-duration` (mirroring schedules' `expiresIn`) is a small, natural, precedent-supported feature ask — not a rearchitecture. The plan records it as a first-class dependency with a fail-closed admission gate, sequences all other build work against a probe that honestly reports `absent`, and re-verifies when Paseo ships.

## When to Apply

- Any time a requirement asserts the substrate enforces something — verify against the live CLI/daemon, not against `--help` memory or research notes (the research notes were stale by one minor version).
- When deciding whether to reopen D1/D2 or proceed with a feature ask: check whether the enforcement primitive exists for a sibling object class (schedules) before concluding the ask is infeasible.
- When writing acceptance examples: never assert "cannot continue beyond the bound" unless the substrate actually enforces it; assert the fail-closed behavior Miah controls.

## Examples

**Wrong framing (containment):** "AE1: the specialist cannot continue beyond the bound." — false today; no substrate mechanism stops it.

**Correct framing (fail-closed acceptance):** "When the recorded deadline passes and the CLI resumes, Miah terminates the specialist, refuses to accept any work produced after the deadline, and reconciles durable identity and artifacts before the next transition." — true today, enforceable by Miah alone.

**Probe check list (for D8/U4 substrate probe):**
1. Query `paseo agent run --help` for a per-agent duration/expiry flag → absent in v0.3.0-beta.2.
2. Read `~/.paseo/config.json` for per-agent bound keys → none.
3. Confirm the schedule-expiry precedent exists (daemon-enforced `expiresAt`/`maxRuns`) → yes; the feature ask is grounded.
4. Record `max-duration: absent` in the run manifest; admission fails closed until the probe passes.
