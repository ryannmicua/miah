---
mode: explanation
verified: 2026-08-09
---

# Mechanism: Isolated Dispatch Pipeline — Adapter, Packet, Envelope, Reconciliation

This is an **explanation** of how Miah creates specialist sessions, keeps them independent, and recovers them after Miah's own death: the Paseo lifecycle adapter, the dispatch packet, the result envelope contract, and replay-then-reconcile. Exact shapes live in [data-and-security](./data-and-security.md); the acceptance side of the pipeline is [evidence-and-acceptance](./evidence-and-acceptance.md). The workspace-topology discipline behind this layer is in the [attach-workspace-to-existing-project](../../docs/solutions/patterns/attach-workspace-to-existing-project.md) and [adapter-default-workspace-config-field](../../docs/solutions/patterns/adapter-default-workspace-config-field.md) patterns.

## The problem this mechanism solves

Specialists must be independent, detachable, and auditable. Independence cannot be a role label — a session called "tester" that inherits the builder's context is not independent (ADR:D2). Detachability is required by the durable-core design: a specialist Miah launched may outlive Miah, so dispatch must be by durable handle, never by in-process child (ADR:D1-d). And the record of what was dispatched must be partly *observed*, not wholly self-reported (ADR:A6) — Miah applies its own evidence discipline to itself.

## The adapter: five capabilities over the Paseo CLI

All dispatch goes through `PaseoCliAdapter`, which implements the five-capability contract — launch, status, inspect, stop, cancel (`src/adapter/paseo.ts:107-113`). Each capability is a `child_process.execFile` against the `paseo` CLI:

- `launch` → `paseo run --background --json` with provider/model/title/workspace flags (`src/adapter/paseo.ts:496-538`); returns a durable `PaseoHandle` (`agentId`, `cwd`, `workspaceId`) that outlives Miah's process.
- `status` → `paseo inspect --json <id>` → lifecycle (`src/adapter/paseo.ts:541-550`).
- `inspect` → the full inspect result including usage telemetry (`PascalCase` `LastUsage`) and `cwd` (`src/adapter/paseo.ts:553-574`).
- `stop` and `cancel` → `paseo agent stop <id>`, bounded at 25s so the driver can always reach Stopping and release the lease even when the daemon is slow to acknowledge (`src/adapter/paseo.ts:577-640`, `src/adapter/paseo.ts:158`).

The CLI resolution is Windows-aware (npm `.cmd` shims are resolved to `node <script> <args>`, still execFile, no shell, no injection surface; `src/adapter/paseo.ts:229-252`) and the JSON parsing is defensive: the CLI interleaves human text, tips, and ANSI codes with its machine JSON, so `extractJsonObject` strips ANSI and returns the first complete JSON object (`src/adapter/paseo.ts:336-422`). A missing CLI throws a typed `PaseoCliUnavailableError` rather than fabricating a result.

## The dispatch packet: the contract a specialist receives

Before any adapter call, Miah composes a **dispatch packet** from the unit's `units.json` entry plus the dispatch's role, take, deadline, and idempotency key (`src/dispatch.ts`, `src/packet.ts`). The packet carries: the objective, the immutable plan excerpt (builders/testers/verifiers get their unit's section; the planner gets the full snapshot, `PLAN:R8`), the result-envelope output schema, the authority bounds, the `creates:`/`inputs:` declarations, the declared envelope path, and the provider/model. The verifier packet additionally carries the evidence-package path and hash, the frozen candidate identity, and the criteria to grade (KTD3/KTD4).

The authority bounds are the packet's load-bearing part (`src/packet.ts`): planners and verifiers are read-only (the verifier may write only its declared result envelope), builders may write only their declared `creates:` paths, and scope/requirement/acceptance change, recursive workers, and run-store writes are all `prohibited`. These are rendered into the prompt handed to the specialist.

The packet is content-hashed (canonical JSON → SHA-256) and that hash goes into the journaled `dispatch_intent` (`src/packet.ts:135-137`, `src/dispatch.ts:341-351`), so the journal records exactly what was sent.

## Intent before launch; identity observed

The dispatch ordering is the single most important ordering in the system:

1. **Journal `dispatch_intent`** — role, unit, take, idempotency key, packet hash, deadline, provider/model (`src/dispatch.ts:341-351`). This is durable *before* the adapter call leaves.
2. **Call `adapter.launch`** with the rendered packet prompt.
3. **On success, journal `dispatch_created`** recording the *actual* agent id, workspace id, and the base commit read from git — never from the packet (`src/dispatch.ts:363-369`, `defaultGitCommitReader` at `src/dispatch.ts:206-218`).
4. **On failure, journal `dispatch_failed`** with the named reason (`src/dispatch.ts:378-385`).

The idempotency key (`dispatch-<role>-<unit>-t<take>`) makes a retry a new take (`src/dispatch.ts:193-199`), and the observed identity (A6) makes the record partly evidence rather than wholly intent.

Why intent-before-launch matters: if Miah dies between steps 1 and 3, the journal holds an intent with no created event. On resume, reconciliation (below) resolves it honestly. Without the pre-journaled intent, a launched specialist could be orphaned with no trace.

## The result envelope: file-based, read after termination

Specialists are told to write a single JSON result envelope at the packet-declared path relative to their worktree root (`src/envelope.ts:142-148`, `.miah/envelope-<role>-<unit>-t<take>.json`). Miah reads it only after the adapter reports a terminal lifecycle (`src/dispatch.ts:485-493`). The envelope is the producer's self-report: its `self_claim` never carries evidence authority and its self-reported file hashes are navigation hints only (`src/envelope.ts:6-8`, `src/evidence.ts:9-11`).

An absent envelope at harvest is deliberately **not** an auto-failure and **not** an auto-completion: it is recorded as an evidence gap (`gap_recorded: result-envelope`) and the dispatch closes with a non-success outcome (`src/dispatch.ts:403-433`). The gap then blocks acceptance until resolved — see [evidence-and-acceptance](./evidence-and-acceptance.md).

## Deadline refusal

Every dispatch carries a deadline (default now + `dispatch.max_duration`, 15m; `src/dispatch.ts:315`). Work past the recorded deadline is refused: the specialist is terminated immediately (best-effort) and the dispatch closes with a deadline-exceeded gap (`src/dispatch.ts:442-463`). The refusal is checked at poll time (`src/dispatch.ts:477-489`), at reconciliation (`src/dispatch.ts:574-595`), and in the step loop (`src/step.ts:508-516`). This is the honest posture given the substrate ships no daemon-enforced per-agent bound — see [paseo-per-agent-hard-bound-verification pattern](../../docs/solutions/patterns/paseo-per-agent-hard-bound-verification.md).

## Polling and no-progress

The step loop polls in-flight specialists at the step-boundary cadence (`src/step.ts:493-555`). Each poll checks the deadline first, then a **no-progress fingerprint** — the serialized `(lifecycle, usage)` from `inspect` (`src/step.ts:313-316`). N consecutive unchanged fingerprints (default 3) raise `no-progress` and pause the run in Attention (`src/step.ts:519-536`).

The no-progress counters live in the per-session `StepRuntime`, which is created fresh on every driver session (`src/step.ts:100-126`). This is deliberate: no-progress can only be claimed *while Miah is alive and polling*, never across a downtime gap, because the journal cannot distinguish "the agent hung for three hours" from "Miah was dead for three hours" (ADR:A1, `PLAN:D7-f`, `PLAN:KTD12`).

## Reconciliation: replay-then-reconcile, never replay alone

On resume, after replay, Miah reconciles every in-flight intent against the adapter — once per driver session (`src/step.ts:387-412`, `src/dispatch.ts:643-652`). For each `dispatch_intent` without a terminal follow-up:

- If a `dispatch_created` identity was journaled, Miah re-reads the live lifecycle from the adapter via `inspect` (which also recovers the worktree cwd for harvesting) (`src/dispatch.ts:522-528`).
- If not (intent-without-created), Miah queries the adapter through the injectable `handleResolver` seam (`src/dispatch.ts:66-70`). The default resolver honestly reports "no handle" — the U4 adapter has no idempotency-key lookup — which routes the unit to `dispatch_failed` and rework (`src/dispatch.ts:530-559`). A real resolver can be wired when the substrate supports lookup by key/title.
- Every reconciliation decision is journaled as `reconcile_record` **before** the follow-up event (`src/dispatch.ts:538-544`, `src/dispatch.ts:597-606`).
- If the reconciled handle is already terminal, Miah harvests and evaluates acceptance immediately (`src/step.ts:400-409`).

This is the kill-drill v2 property: kill after intent-before-created → resume → adapter queried → no handle → `dispatch_failed` → rework (see [kill-drill-byte-identical-resume-verification pattern](../../docs/solutions/patterns/kill-drill-byte-identical-resume-verification.md)).

## Worktree isolation and workspace attachment

Every dispatch runs in its own worktree — the substrate creates one via `--new-workspace worktree --worktree-mode branch-off` (`src/adapter/paseo.ts:508-509`) unless the run config sets `dispatch.default_workspace`, in which case dispatches attach to that existing workspace via `--workspace <id>` and skip the new-workspace flags (`src/adapter/paseo.ts:505-507`, `src/dispatch.ts:232-240`).

The workspace policy is read from the run's admission-time config snapshot (R80), not the live config file, so a run in progress keeps the policy it was admitted with (`src/dispatch.ts:237-239`). The attach path exists so dispatches from unrooted cwds never auto-derive orphan Paseo projects — the trap documented in the [attach-workspace-to-existing-project pattern](../../docs/solutions/patterns/attach-workspace-to-existing-project.md).

## Role resolution and cross-family contrast

Each role maps to a Paseo role plus a provider/model pair: D8-i defaults (`src/types.ts`) overridden by the operator's `~/.paseo/orchestration-preferences.json` when present (`src/dispatch.ts`). The defaults pin the builder to one model family and testers/verifiers to another — cross-family contrast per unit (builder ≠ checker). Cross-family is a hedge, not an authority: a checker's verdict earns authority only by clearing the calibration bar (see [evidence-and-acceptance](./evidence-and-acceptance.md) §Grading; [cross-family-verifier-audit-g-criteria pattern](../../docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md)).

## The step-level dispatch loop

The dispatch machinery is driven by the step function (`src/step.ts:372`). One step: reconstruct state → reconcile once → evaluate budget predicates (cost ceiling, takes, rework) → find dispatch-eligible units (`src/step.ts:179-202`: `not_started`/`rework`, no in-flight intent, all dependencies accepted) → dispatch within the concurrency cap (`src/step.ts:454-489`) → poll in-flight specialists → on terminal, harvest and evaluate acceptance. The phase follows the outcome (Implementing/Reviewing/AwaitingApproval/Attention) via `ensurePhase` (`src/step.ts:561-572`). Per-session observation state (live handles, pre-dispatch usage snapshots, no-progress streaks) lives in `StepRuntime`, recreated on resume (`src/step.ts:100-126`).
