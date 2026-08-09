---
title: "Disk-first design for Paseo agent orchestration loops"
date: 2026-08-07
category: patterns
problem_type: knowledge
component: paseo-orchestration
tags: [paseo, orchestration, disk-first, recovery, session-death, loop-design, cross-project]
applies_when: "Building or running any orchestration loop that dispatches specialist agents (Paseo agent loops, Task subagent loops, scheduled agents), or designing a resume/recovery path for a dead worker session — especially implementation loops executing a plan in units where each unit carries a verification bar."
---

# Disk-first design for Paseo agent orchestration loops

> **Cross-project knowledge.** This pattern is staged in the Miah repo because the validating incident happened here, but it is explicitly cross-project: it applies to any agent-orchestration loop that dispatches workers and verifies their output — Paseo agent loops, OpenCode/`opencode` Task subagent loops, scheduled-agent loops, or any harness where a worker session's output is the only record of its work. The operator will synthesize it into other projects.

## Context

During the implementation of the Miah plan — an orchestrated, multi-specialist build loop using Paseo agents — a builder session for unit U3 died mid-run with the error `"OpenCode event stream ended before the turn reached a terminal state"`. The session was left in `error` state with no final report. The incident was **costless** because the loop had been designed disk-first: the builder had already committed its work (a `feat(U3): ...` commit, verified intact, working tree clean), and the tester was dispatched as a **fresh, independent agent** explicitly told *"the builder report doesn't exist — verify everything from scratch."* The unit passed its audit from disk state alone; only the builder's self-report (a chat summary) was lost, which the independent verifier renders irrelevant by design.

The lesson generalizes to **any loop that dispatches agents** (Paseo agents, Task subagents, codex/opencode agents): session liveness must never be coupled to work liveness.

## Guidance

Four mechanisms make a loop disk-first. Each is independent.

**1. Commit-per-step contract in every goal prompt.**
Each worker goal prompt mandates an **atomic commit after its verification passes** (e.g. a `feat(U3):` commit with a matching message). The commit is the state of record; the chat report is a courtesy. A worker that writes code without committing per step is a **loop risk**, not a style preference — its death loses the work, not just the commentary. The goal prompt must make the commit non-optional: "verify, then commit with message `feat(U<n>): ...`, then report."

**2. Idempotency on resume.**
A dead session is resumed by a **fresh agent** that reads git and the worktree first — *"check what's already committed; don't redo, don't assume"* — never by "continuing the conversation" or replaying the dead session's context. Reuse of session context after death is the non-disk-first trap: the dead session's half-formed state is a liar, and replaying it inherits every unstated assumption. Resume reads disk and reconciles, nothing else.

**3. Verifier reads disk, never the report.**
Testers and auditors are dispatched **fresh**, on a **different model family than the worker**, and instructed to **re-run every gate themselves** and treat the worker's claims as unverified inputs. When a worker dies without a report, the verifier is told it is the first and only evaluation. The worker's report, when present, is a hint about where to look — never evidence that the gate passed. This converts "the builder's final message" from load-bearing state into ignorable commentary, which is exactly what makes a missing report a non-event.

**4. Dispatcher recovery protocol.**
On any session death, the dispatcher runs a fixed protocol driven entirely by disk state:
1. `git status` → working-tree state.
2. Compare against the **expected commit boundary** for the current unit.
3. Decide from disk state alone:
   - **resume** — work committed, tree clean: dispatch a fresh verifier.
   - **redo** — nothing committed, tree dirty: dispatch a fresh worker with the unit's goal prompt.
   - **escalate** — ambiguous or contested state (partial commit, contested gate): surface to the operator.
Session death is a non-event; only **missing commits** are events. The dispatcher never reasons about what the dead session "was about to do" — it reasons about what is on disk.

## Why This Matters

Agent sessions die unpredictably — stream errors, timeouts, platform failures. A loop that treats the session's final message as the state of record **loses work and integrity on every death**; a disk-first loop loses nothing but the worker's own commentary.

This is the same principle **Miah itself institutionalizes one level down**: `dispatch_intent` is journaled to disk before the adapter call is made; result envelopes are read from disk after termination; evidence is the harvested artifacts on disk, never the agent's prose. Orchestrating Miah's own build with this design is the principle **applied to itself** — the loop that supervises specialist agents is supervised by the same disk-first invariant the specialists are told to uphold. A dead builder, a missing report, a stream that ended early: each is a status the dispatcher resolves from disk in one fixed protocol, and the loop continues without integrity loss.

## When to Apply

- Any orchestration loop that dispatches specialist agents — Paseo agent loops, Task subagent loops, scheduled agents.
- Any time a worker's chat output is the only record of its work.
- Any resume or recovery path after a session dies, times out, or is cancelled.
- Especially: implementation loops executing a plan in units, where each unit has a verification bar that a fresh verifier can re-run independently.

## Examples

**Wrong way:**
- Relying on the worker's final chat message as the record of what shipped.
- Resuming a dead session by "continuing" it, replaying its context.
- Letting the verifier read the builder's report and trust its exit codes or self-assessment.
- Treating session death as an incident requiring investigation before the loop can proceed.

**Right way (from the U3 incident):**
Builder commits U3 with all gates passing → session dies before it can report → dispatcher checks git, sees commit `9021851` (U3; on the feature branch, now shipped in PR #1, squash `d7eac30`), tree clean → tester dispatched fresh with *"no report exists, verify from scratch"* → tester re-runs every gate itself, returns PASS, unit accepted.

- **Lost:** a summary message.
- **Preserved:** everything that counts.