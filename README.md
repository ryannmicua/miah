# Miah

> Miah is a resumable plan supervisor: it directs one approved plan at a time, start to finish. It hands every step to an implementation agent, runs it past an independent reviewer, and refuses to call a step done until you sign off. Each run is locked to an immutable plan snapshot, tracked in an append-only journal, and picks up exactly where it left off if your session dies. Like the wall-builder Nehemiah, it keeps the ledger, keeps the crews honest, and stays at it until the work is done — your session can crash, and Miah won't lose a step.

## Status

Miah v1 is shipped: implemented per plan R1–R90 and merged via PR #1 (squash commit `d7eac30`). 340 unit tests plus the E2E suites (including kill drill v3) pass and CI is green; an independent MiniMax-M3 review returned APPROVE with all findings fixed.

## Getting started

Install and build with `npm ci && npm run build`, then use the `miah` CLI: `preflight | start | run | status | stop | resolve | approve | reject | amend | list`. Live-daemon E2E tests require the Paseo daemon; on hosts without it they are gated on `paseoCliAvailable()` and skip rather than fail. Run an agent from this directory and follow `AGENTS.md`.

## Layout

- `AGENTS.md` — phase-aware operating instructions; rewrites itself as the project advances
- `VISION.md` — canonical product vision (approved)
- `STRATEGY.md` — derived strategic framing and planning priorities
- `CONCEPTS.md` — shared domain vocabulary (knowledge store)
- `src/` — CLI implementation (`miah`)
- `test/` — unit + E2E suites, including the kill drill
- `docs/` — durable artifacts: plans (`docs/plans/`), decisions, research, reviews (`docs/reviews/`), compound learnings (`docs/solutions/`), and session digests (`docs/session-digests/`)
- `tmp/` — scratch space; committed empty, contents ignored
