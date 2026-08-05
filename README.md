# Miah

> Miah is a resumable plan supervisor: it directs one approved plan at a time, start to finish. It hands every step to an implementation agent, runs it past an independent reviewer, and refuses to call a step done until you sign off. Each run is locked to an immutable plan snapshot, tracked in an append-only journal, and picks up exactly where it left off if your session dies. Like the wall-builder Nehemiah, it keeps the ledger, keeps the crews honest, and stays at it until the work is done — your session can crash, and Miah won't lose a step.

## Status

The product vision is written and approved (`VISION.md`). The project is in Phase 2 — Planning: turning the vision into an implementation-ready plan.

## Getting started

Run an agent from this directory and follow `AGENTS.md`. In the current phase, work focuses on planning: read `VISION.md` and `STRATEGY.md`, then develop the implementation plan with the operator. `AGENTS.md` rewrites itself as the project advances into Building and Operating phases.

## Layout

- `AGENTS.md` — phase-aware operating instructions; rewrites itself as the project advances
- `VISION.md` — canonical product vision (approved)
- `STRATEGY.md` — derived strategic framing and planning priorities
- `docs/` — durable planning artifacts, research notes, and (future) implementation plans
- `tmp/` — scratch space; committed empty, contents ignored
