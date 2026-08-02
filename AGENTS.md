# AGENTS.md

This file is phase-aware: it tells any agent how to work in this repository right now, and it is expected to rewrite itself as the project advances. The project moves through phases — each phase has different working instructions, and when a phase completes, this file is rewritten to describe the next one.

## Current phase

**Phase 1 — Vision**

The product has a name and a one-line pitch (see `README.md`), but no written vision yet. The operator has not answered the core product questions. Nothing is planned or built.

## The phases

| Phase | Name | Output | Move to next when |
| --- | --- | --- | --- |
| 1 | Vision | `VISION.md` | Vision is written and approved |
| 2 | Planning | Implementation plan(s) | Plan is approved |
| 3 | Building | Working product | Feature ships and is verified |
| 4 | Operating | Maintained product | Continuous; no automatic advance |

## Phase 1 instructions (current)

Your job in this phase is to help the operator flesh out the product vision, then write it down.

### Step 1 — Interview the operator

Ask focused questions, one at a time, to pull out the vision. Cover at minimum:

- **What** — what is the product, concretely? What does it do?
- **Who** — who is it for? Who benefits, who operates it?
- **Why** — what problem does it solve? What does success look like?
- **How** — rough shape: CLI, service, agent, library? What's the core interaction?
- **Boundaries** — what is explicitly out of scope for now?
- **Constraints** — non-negotiables: platform, licensing, dependencies, one-agent-to-start, etc.

Use the current `README.md` description as a starting point to react to, not a fixed answer. Prefer open questions. Do not write anything to disk until the interview is complete.

### Step 2 — Write `VISION.md`

Draft a vision document from the interview. Keep it tight and durable:

- **Title** — the product name and a one-line pitch
- **Problem** — why this exists
- **Who it's for** — users and operators
- **What it does** — the core capability and the shape of the product
- **What success looks like** — measurable or observable signals
- **Out of scope** — what is deliberately not being built
- **Constraints** — non-negotiable rules for every later phase

Present the draft for operator approval before finishing.

### Step 3 — Rewrite this file

After the operator approves the vision:

1. Update the **Current phase** section to **Phase 2 — Planning** and add a one-line summary of the approved vision.
2. Replace the Phase 1 instructions with Phase 2 instructions (below).
3. Preserve the phase table, adding a note in the Vision row that it is complete.

Then report back to the operator with what changed.

## Phase 2 instructions (to be installed on advancement)

- Read `VISION.md` first; it is the source of truth for this phase.
- Work with the operator to turn the vision into an implementation-ready plan. Ask about scope and sequencing; do not invent requirements.
- Save the plan to `docs/plans/` using the unified-plan convention.
- After the plan is approved, rewrite this file: set **Current phase** to **Phase 3 — Building**, summarize the plan, and install Phase 3 instructions.

## Phase 3 instructions (to be installed on advancement)

- Execute the approved plan sequentially, one step at a time, verifying each step before moving on.
- Keep `VISION.md` and the plan in sync; surface drift to the operator rather than silently changing direction.
- After a feature ships and is verified, rewrite this file: set **Current phase** to **Phase 4 — Operating**, and install Phase 4 instructions.

## Phase 4 instructions (to be installed on advancement)

- The product is live. Treat every change as a change to a maintained system: verify, test, and document.
- Keep `VISION.md` current; anything that changes the vision should be recorded there before implementation.

## Working rules (all phases)

- Only the operator approves moving to the next phase. Rewrite this file only when a phase's exit condition is met.
- The operator is the sole authority on scope and vision. Never invent requirements or expand scope without asking.
- Use `tmp/` for throwaway scratch; never commit anything in it (it is git-ignored).
- Save durable artifacts in the repository root or in `docs/`.
- When in doubt about what the operator wants, ask — one question at a time.
