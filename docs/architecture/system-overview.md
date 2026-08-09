---
mode: explanation
verified: 2026-08-09
---

# Miah v1 — System Overview

Miah is a **resumable plan supervisor**: a standalone CLI that supervises the execution of one immutable approved plan by coordinating independently dispatched specialist agents, while preserving operator control and a durable record of the work. Miah itself never implements, tests, or reviews — it orchestrates, journals, verifies evidence, and gates every step on a decidable predicate.

> **Mode: explanation.** This document answers *what the system is and why it is shaped this way*. For exact values — phases, event types, config fields, exit codes — see the reference docs ([state-machine-reference](./state-machine-reference.md), [data-and-security](./data-and-security.md)). For the reasoning behind individual decisions, see [design-decisions](./design-decisions.md). Vocabulary is defined in [`CONCEPTS.md`](../../CONCEPTS.md).

## What the system is

Miah is a TypeScript/Node CLI (`package.json` bin `miah`, `src/index.ts`) that operates on a **durable run directory** rather than in a process. Its central architectural claim (decision D1, from the [D1/D2 decision record](../decisions/2026-08-06-d1-d2-runtime-and-agent-invocation.md), carried forward as the plan's R2/R3) is that **resume is the only implementation**: there is no separate "resume" code path, because every invocation reconstructs supervisor state from the durable record and then performs the next safe transition.

The supervisor loop does not live in a process. It lives on disk as three mutually reinforcing primitives:

- an **immutable plan snapshot** (the approved plan, content-hashed, never mutated in place),
- an **append-only journal** (`journal.jsonl`, one typed event per line, global monotonic `seq`),
- a **single-writer lease** (`lease.lock`, heartbeat + TTL, stale-takeover).

Any process may pick the run up; the lease guarantees exactly one writer at a time.

The system is built for the operator's environment: Windows 10 + Git Bash, Node.js 18+, TypeScript, npm install, no daemon, no background service (R70, R83, R84). The only external substrate it talks to is the **Paseo daemon**, which provides the specialist agent lifecycle (launch/inspect/stop), worktree workspaces, and usage telemetry.

## The layered architecture

The modules in `src/` divide into six cooperating layers. Each layer's one-line responsibility:

| Layer | Modules | Responsibility |
|---|---|---|
| **CLI surface** | `index.ts`, `commands/*` (10 command modules) | Parse the command line, dispatch to a command body, map results to exit codes and stdout |
| **Admission** | `admission.ts`, `preflight.ts`, `parser.ts`, `snapshot.ts`, `config.ts`, `substrate-probe.ts` | Decide whether a plan may become a run: pure preflight **and** live substrate probe, both fail-closed |
| **Durable core** | `run-store.ts`, `journal.ts`, `lease.ts`, `replay.ts`, `manifest.ts` | Own the disk record: append-only journal, single-writer lease, periodic snapshots, derived-state replay |
| **Dispatch** | `dispatch.ts`, `src/adapter/paseo.ts`, `packet.ts`, `envelope.ts` | Create isolated specialist sessions through the Paseo CLI, journal intent before launching, reconcile on resume |
| **Evidence & acceptance** | `evidence.ts`, `custody.ts`, `postflight.ts`, `acceptance.ts`, `grading.ts`, `calibration.ts`, `gap.ts` | Harvest verifiable artifacts, hash-chain them, grade criteria on the D5 ladder, decide acceptance, track gaps |
| **Supervision loop** | `step.ts`, `driver.ts`, `fsm.ts`, `escalation.ts` | The step function that ties everything together, the looping driver, the run-phase FSM, and operator escalations |

Layering rule that holds structurally: each layer only talks to the layer below it and the shared types (`src/types.ts`). `src/types.ts` carries the config schema and the D8-i role→model defaults; it is the single shared vocabulary.

## The end-to-end primary flow

A run proceeds through the following stages. Each stage is described in depth by a mechanism doc; this is the one-screen view.

```
operator: miah start <plan.md>
  
   ADMISSION (fail-closed)                                      
    1. parse plan → units.json machine view (parse-once)        
    2. pure preflight: structural/referential/verifiability     
    3. substrate probe: max-duration? MCP scoping? immutability?
    4. any blocker → refuse, print findings, exit 1             
    5. write run store: plan-snapshot.v1.md + units.json +      
       manifest.json (config snapshot, probe verdicts)          
    6. acquire lease, append run_start                          
  

operator: miah run [--once]          (the looping driver)
  
   DRIVER LOOP  (each step = runStep)                           
    replay journal+snapshot → reconcile in-flight intents       
    → budget predicates (takes/rework/no-progress/cost)         
    → dispatch eligible units (dependency-gated, cap=1)         
    → poll specialists; on terminal: harvest → grade → accept   
    → integrate accepted creates: into canonical worktree       
    → rework (bounded) or escalate → journal phase_transition   
    stop conditions: all accepted → AwaitingApproval            
                     escalation → Attention (exit)              
                     stop flag → Stopping (terminate+release)   
  

operator: miah approve <run-id>  →  Complete  →  run_terminal: complete
operator: miah reject <run-id> [--rework <ids> | --end]
                                 →  rework-marked → resume at Ready
                                 →  run_terminal: rejected
operator: miah resolve <run-id> <esc-id> --decision approve|deny|rework
operator: miah amend <run-id> <new-plan>     → new snapshot version
```

Each stage is journaled as typed events, so the whole run is reconstructable from the journal alone (`src/replay.ts`). The driver acquires the lease, replays, reconciles, loops the step function, and releases the lease on every clean exit — a run nobody is driving is **paused, not lost** (D1-c).

## The core invariants

These rules must never break. Each carries its enforcement citation.

1. **Resume is the only implementation.** Every driver session reconstructs state from `journal.jsonl` + snapshots + `lease.lock` before acting, then reconciles reality. Enforced in `src/driver.ts:348` (`store.replay()`) and `src/replay.ts:471` (`replayFromSnapshot`); proved by the kill drill (`test/kill-drill-v1.test.ts`, `test/e2e/kill-drill.test.ts`).

2. **Exactly one writer per run.** Only the lease holder may append to the journal; every append is gated on a fresh-holder check. Enforced in `src/journal.ts:203` (`verifyHolder`) and `src/lease.ts:279` (`assertActiveHolder`).

3. **The plan snapshot is immutable.** The original snapshot is never mutated; amendments write a new version (`plan-snapshot.v<N>.md`). Enforced in `src/commands/amend.ts:204-206` and `src/snapshot.ts:53` (versioned write).

4. **Acceptance is decidable, not a judgment call.** A unit is accepted only when every acceptance criterion has a passing evidence record at or above its declared tier **with no open evidence gap** referencing it. Enforced in `src/acceptance.ts:80` (`evaluateAcceptance`).

5. **Problems cannot disappear silently.** An accept/override that supersedes open gaps journals a `gap_closed` per gap *before* the superseding event. Enforced in `src/commands/resolve.ts:112-119`; see the [explicit-gap-close-before-supersede pattern](../../docs/solutions/patterns/explicit-gap-close-before-supersede.md).

6. **Evidence is what Miah harvests, never agent prose.** The specialist's result envelope self-report carries no authority; hashes it reports are navigation hints. Enforced in `src/evidence.ts:342` (`harvestEvidence`) and `src/envelope.ts:7-8` (comment + schema).

7. **Admission fails closed on an unverifiable substrate.** If the probe cannot confirm a required substrate mechanism (per-agent max-duration, MCP scoping), admission refuses rather than proceeding. Enforced in `src/admission.ts:122-133`.

8. **Operator authority is explicit and journaled.** Stop, resolve, approve, reject, and amend are operator actions recorded as `operator_decision` events with identity, timestamp, and decision. Enforced in `src/commands/stop.ts:82`, `src/commands/approve.ts:62`, `src/commands/reject.ts:86`, `src/commands/resolve.ts:82`, `src/commands/amend.ts:216`.

9. **A broken evidence chain is a gap, never silent corruption.** A broken or missing custody link opens an evidence gap that blocks acceptance. Enforced in `src/evidence.ts:522` (`verifyCustodyChain`) and `src/custody.ts:95` (`verifyChain`).

## Reading onward

- [design-decisions](./design-decisions.md) — the settled decisions and their rationale
- [state-machine](./state-machine.md) — how the run-phase FSM works (explanation); [state-machine-reference](./state-machine-reference.md) — the exact table
- [journal-and-recovery](./journal-and-recovery.md) — the disk-first durable core
- [dispatch-and-isolation](./dispatch-and-isolation.md) — how specialists are created and kept independent
- [evidence-and-acceptance](./evidence-and-acceptance.md) — how work becomes trusted
- [admission-and-preflight](./admission-and-preflight.md) — the gate a plan must pass
- [data-and-security](./data-and-security.md) — the data model and security guarantees
- [maintenance-guide](./maintenance-guide.md) — how to change this system
