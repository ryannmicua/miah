# Prior Art: Paseo Plan Execution Supervisor — STAGED DIGEST

> **STAGED CONTEXT — DO NOT READ DURING BRAINSTORMING.**
>
> This file contains the decisions of a direct predecessor of Miah: the heypogi
> "Paseo Plan Execution Supervisor" (planned 2026-07-28, never implemented).
> The operator deliberately staged this out of brainstorming context so that
> Miah's decisions are made on standalone research, not anchoring.
>
> **Open this file ONLY at the cross-check phase**, after brainstorm decisions
> are drafted — see `docs/planning-brief.md` → "Prior art handling".
>
> At that point: compare decision by decision. Agreement = corroboration.
> Disagreement = a conflict to resolve deliberately with the operator.

## Artifact locations

- Plan (merged to heypogi main): `heypogi/docs/plans/2026-07-28-001-feat-paseo-plan-execution-supervisor-plan.md` (598 lines, `implementation-ready`, `execution: code`, 13 Key Decisions, R/A/F + KTD/U/Verification structure)
- Open Items Register (heypogi main): `heypogi/docs/open_items_register.md` — OIR-001..004
- Unmerged designs (worktree still exists): `heypogi/.worktrees/feat-paseo-plan-exec-supervisor/docs/`
  - `specs/2026-08-02-paseo-execution-observer-sidecar.md`
  - `specs/2026-08-02-paseo-delegated-work-result-contract.md`
  - `findings/2026-07-29-plan-readiness-paseo-supervisor.md`
- Session history of the effort: opencode session probe `list` on heypogi, sessions dated ~2026-07-28..08-02 (titles like "Paseo Plan Execution Supervisor Plan Review", "Plan readiness findings review", "Improving plan with delegated work contract", "Naming supervisor/orchestrator")

## Settled decision register (from the prior plan's Key Decisions)

Each entry: decision (rationale) — plus verification status where known.

1. **Command plus reusable skill.** A prompt template cannot own durable execution state; the supervisor needs repo-owned execution authority that survives session loss.
2. **Ship setup with supervision.** Every run must validate its safety configuration before dispatch.
3. **Execute sequentially in v1.** Concurrency deferred; not needed for the first trustworthy workflow. (Contrast with VISION's progress-preserving escalation and the parallelism research — a candidate for deliberate re-examination.)
4. **Bind each run to an immutable plan snapshot.** Later edits must not silently change authorized work.
5. **Supervisor is the sole state authority.** Worker or shared status updates are unsafe; concurrent and self-reported transitions disallowed.
6. **Append-only journal with derived status.** Not a mutable checkpoint; recovery needs complete transition provenance. Paseo never leads run state.
7. **Independent audit required for completion.** Agent termination does not prove the plan step is correct.
8. **Provider-class limits.** v1 subscription-only (Codex/OpenCode Go) because metered providers need run-level controls that v1 doesn't ship.
9. **Calibrate audit before it can authorize completion.** Zero false-pass on a 15-case calibration corpus (≥14/15 agreement, ≤2 false blocks); cross-family model contrast alone is insufficient (OIR-003, open).
10. **Fail closed on uncertainty or resume conflict.** The supervisor must not guess when authority or budget is unclear.
11. **Attention-first observability.** Journal holds routine detail; operator surfaces only budgets and intervention needs.
12. **Narrow v1 worker trust boundary.** Worktree + out-of-tree owner-only control store + worker env scrubbed of secrets + hash-chain tamper evidence. Does NOT claim to survive a malicious same-OS-user delegated agent; real OS/container sandbox is v2 (OIR-001).
13. **Ship v1 subscription-only.** Metered accounting gateway deferred to v2 (OIR-002).

## Designs that went beyond the plan (staged specs)

### Observer sidecar (2026-08-02)
- Persistent per-run observer surviving loss of the supervisor session; subscribes to Paseo lifecycle/timeline events; periodically reconciles against daemon health, agent inspection, usage telemetry, result files, worktree state; writes a **separate append-only evidence stream**.
- Observation-only: never prompts, stops, retries, approves, or classifies workers as hung; reports facts (elapsed quiet, activity type, usage deltas, result-file presence); the supervisor interprets and remains sole authority.
- **No worker-authored checkpoints** — progress visibility derived from observable behavior, not self-reporting.
- Required for v1 run admission.

### Delegated work result contract (2026-08-02)
- Agent lifecycle and work result are two different things; Paseo is the control plane, not a result transport.
- Durable handoff = small versioned JSON manifest (machine surface) + dedicated files (substantive work). Implementation → run worktree is canonical output; manifest points to changed files + verification evidence.
- Logs are an observability channel, not a result API. Never fall back to parsing logs or trusting a worker's final sentence.
- Worker runtime profile: opencode / opencode-go/deepseek-v4-flash / thinking=max / mode=build.

### Verified Paseo CLI contracts (2026-07-29, vs Paseo v0.2.3 — daemon now v0.3.0-beta.1, re-verify)
- `paseo agent inspect --json <id>` → `LastUsage` PascalCase: `InputTokens`, `OutputTokens`, `CachedTokens`, `CostUsd`
- `paseo agent ls --json`; `paseo agent stop <id>` (not `agent cancel`); `paseo provider ls --json`; `paseo provider models <provider> --json`
- `paseo workspace create --isolation worktree`; `paseo run --workspace <id>` supported
- Usage accounting must use **deltas** between snapshots, not sums of cumulative snapshots
- Lifecycle JSON ≠ work-result JSON: a terminal lifecycle proves the process stopped, not that a result exists/complete/belongs to the attempt

### Supervision lifecycle (from readiness findings)
- 9 phases: Admitting, Ready, Implementing, Reviewing, AwaitingApproval, StepComplete, Attention, Stopping, Complete — explicit transitions.
- Delegations use `paseo run --workspace <id> --background`; supervisor never blocks; returns to operator after each delegation; operator resumes later.
- Re-entry protocol (fresh session): replay journal, reconcile against `paseo agent inspect --json <id>`, determine next safe transition per phase.
- Step Extraction Contract: parse `## Implementation Units` H3 headings (`U<number>. <title>`), numeric ascending, gaps accepted; required fields Goal/Files/Approach; deferred excluded by title; stored as `steps.json` at admission; never re-parsed mid-run.

## Open items the prior effort left

- **OIR-001 (monitoring):** worker sandbox for v2 — v1 trust boundary explicitly does not survive a malicious same-OS-user delegated agent.
- **OIR-002 (monitoring):** metered accounting gateway for v2 — v1 cannot execute metered runs.
- **OIR-003 (open):** audit calibration bar on glm-5.2 — if the profile can't clear the bar after corpus tuning, no run can complete; swap contingency recorded at U5.
- **OIR-004 (closed):** readiness-label mismatch fix.

## Cross-check note

This effort reached implementation-ready and stopped before building — the same ground Miah's Phase 2/3 occupies. Treat every entry above as a *candidate*, never as a settled constraint on Miah. Where our research disagrees (e.g., sequential-only execution vs VISION's progress-preserving parallelism), surface it to the operator.
