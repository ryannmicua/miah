# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Miah is a **resumable plan supervisor**: it directs one approved plan at a time from executable plan to verified completion, coordinating specialist agents (planner, builder, tester, reviewer) while preserving operator control and a durable record of the work. It supervises — it does not implement, test, or review itself.

There is no source code yet. The repository currently contains only documents; the project is in its planning phase. There are no build, lint, or test commands.

## Read AGENTS.md first

`AGENTS.md` is the operating contract for any agent working here, and it is phase-aware — it states the current phase and the instructions that apply *right now*, and it is rewritten when a phase's exit condition is met. Follow it over any assumption in this file about what work is appropriate.

## Document authority

- `VISION.md` — canonical product definition; governs when documents conflict.
- `STRATEGY.md` — derived from `VISION.md`. Must not conflict with it, introduce new scope, or restate product behavior.
- Never silently edit either document to resolve a conflict; surface the drift to the operator.
- After either changes, run the `vision-strategy-align` skill and report the verdict before continuing.
- The operator is the sole authority on scope. Never invent requirements. When unsure, ask one question at a time.

## Conventions

- Durable artifacts go in the repo root or `docs/` (`docs/plans/`, `docs/research/`, `docs/ideation/`).
- `tmp/` is git-ignored scratch; never commit its contents.

## Architectural invariants (from VISION.md)

These constrain any implementation and should not be traded away without operator approval:

- One active approved plan per run; each run is locked to an **immutable plan snapshot**.
- Run history is an **append-only journal**; workflow state, evidence, statuses, and handoffs are durable and filesystem-based.
- Builder, tester, and verifier roles are distinct; testing and verification are independent of implementation.
- A specialist agent's claim is an evidence input, not a fact — completion requires independent corroboration or a directly verifiable artifact.
- An escalation pauses only the affected unit and its dependents; unrelated work continues. See `VISION.md` "Escalation boundaries" for the conditions that mandate escalation.
