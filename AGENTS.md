# AGENTS.md

This file is phase-aware: it tells any agent how to work in this repository right now, and it is expected to rewrite itself as the project advances. The project moves through phases — each phase has different working instructions, and when a phase completes, this file is rewritten to describe the next one.

## Current phase

**Phase 4 — Operating**

Miah v1 is shipped and verified on `main` (squash commit `d7eac30`, PR #1): a resumable plan supervisor that coordinates specialist agents to execute one immutable approved plan with independent testing, review, durable evidence, bounded autonomy, and operator approval gates. The product is live; treat every change as a change to a maintained system.

## The phases

| Phase | Name | Output | Move to next when |
| --- | --- | --- | --- |
| 1 | Vision | `VISION.md` | Complete — vision is written and approved |
| 2 | Planning | Implementation plan(s) | Plan is approved |
| 3 | Building | Working product | Feature ships and is verified |
| 4 | Operating | Maintained product | Continuous; no automatic advance |

## Phase 4 instructions (current)

- The product is live. Treat every change as a change to a maintained system: verify, test, and document.
- Keep `VISION.md` current; anything that changes the vision should be recorded there before implementation.

## Working rules (all phases)

- Only the operator approves moving to the next phase. Rewrite this file only when a phase's exit condition is met.
- The operator is the sole authority on scope and vision. Never invent requirements or expand scope without asking.
- `VISION.md` is the canonical product definition; `STRATEGY.md` is derived from it and must not conflict with it, introduce new scope, or restate product behavior. If they conflict, `VISION.md` governs — surface the drift to the operator; never silently edit either document to resolve it.
- After either `VISION.md` or `STRATEGY.md` changes, run the `vision-strategy-align` skill and report the verdict before continuing with planning or implementation work.
- When running `ce-strategy` in this repo, answer its interview from `VISION.md`'s content — do not improvise new product answers — and run `vision-strategy-align` on the result.
- Use `tmp/` for throwaway scratch; never commit anything in it (it is git-ignored).
- Save durable artifacts in the repository root or in `docs/`.
- Before substantial work, search the knowledge stores: `CONCEPTS.md` (shared vocabulary), `docs/solutions/` (compound learnings and pattern docs), and `docs/session-digests/` (prior session records). Add to them after solving something worth keeping.
- Keep `README.md` fresh and aligned with this file's **Current phase** and the repository layout: when this file is rewritten on a phase change, update the README's status, getting started, and layout sections to match.
- When in doubt about what the operator wants, ask — one question at a time.
