---
title: "Dispatch-to-PR pipeline for large features: multi-agent implementation, cross-family review, and Copilot fallback"
date: 2026-08-24
category: patterns
module: miah
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - "Delivering an implementation-ready plan too large for one agent's context window"
  - "When Copilot PR review is unavailable or repeatedly errors"
  - "When a component's failure mode is silent (daemon, scheduler-driven) and its process model is a safety decision"
  - "When the repo has opencode + Paseo, CE plugin skills, and gh CLI with a GitHub remote"
tags:
  - dispatch-to-pr
  - multi-agent
  - lfg-ship
  - paseo
  - worktree-isolation
  - cross-family-review
  - one-tick
  - copilot-fallback
related_components:
  - tooling
  - documentation
---

# Dispatch-to-PR pipeline for large features: multi-agent implementation, cross-family review, and Copilot fallback

> **Cross-project knowledge.** This pattern was validated in the Miah repo (feature "watchdog daemon", PR #13) but applies to any repo with opencode + Paseo, the Compound Engineering (CE) plugin skills, and a GitHub remote: delivering a large implementation-ready plan end-to-end by sequencing bounded implementation agents, reviewing cross-family, and surviving a failing review bot.

## Context

The Miah watchdog daemon feature was delivered end-to-end with lfg-ship + Paseo orchestration: an implementation-ready plan (`docs/plans/2026-08-19-001-feat-miah-watchdog-daemon-plan.md`, revision 3 — 27 requirements R1–R27, 12 key technical decisions KTD1–KTD12, 14 plan-review fixes F1–F14) was implemented across 31 files (+4282/−100 lines per the merge commit), reached 127 passing tests, and merged as **PR #13** (squash `a221bf5`, 2026-08-24).

The session validated the dispatch-to-PR pipeline at large-feature scale and produced four reusable patterns:

1. **Dispatch-to-PR with multiple sequential implementation agents** — one agent could not hold the whole plan in context; the pipeline sequenced narrow, bounded agents instead.
2. **Cross-family code review** — minimax-m3 and Claude Opus 5 reviewed mimo-v2.5 implementation work; each found real issues the implementation agents missed, with distinct catches.
3. **Process model selection for sole-reaper components** — one-tick beats resident loop when the OS scheduler supervises each invocation; arbitrated via an advisor agent.
4. **Copilot fallback** — Copilot review errored 6 times; a frontier-model (Opus 5) review posted as a PR comment replaced it, preserving the review gate and the audit trail.

## Guidance

### 1. Dispatch-to-PR with multiple sequential implementation agents

For plans that exceed one agent's context window, sequence narrow, bounded implementation agents instead of expecting one agent to finish. The validating run used 14 dispatches in this order: worktree isolation → initial implementation (driver-side changes) → implementation completion (watchdog process) → test-fixture fixes → e2e orphan fix → simplify (16 improvements; risky consolidations declined) → minimax-m3 review (25 findings) → P1 quick fixes → process-model flip → docs + kill-drill tests → residuals + ship (PR) → CI watch → merge-ready loop (Copilot failed) → Opus 5 review → Opus-5-fix pass.

Each agent gets the plan path plus a narrow slice ("complete the watchdog process", "fix the lease-holder test fixtures", "flip the process model"). The orchestrator verifies the full suite and `tsc` itself between agents — never the agent's numbers — so every agent boundary is a verification gate.

### 2. Cross-family code review

Dispatch reviewers from a different model family than the implementer, and expect distinct catches. minimax-m3 (25 findings: 4 P1, 13 P2, 8 P3) caught CLI-not-registered, the inverted process model, a red admission test, and missing docs. Claude Opus 5 (3 P1, 10 P2, 11 P3) caught the cadence-config coupling (P1-2: watchdog borrowed `lease.ttl_s` instead of having its own cadence), heartbeat self-validation (P2-5: the file under validation supplied its own validity window), a KTD4 violation, shell injection via `schtasks` string concatenation, and a red e2e test asserting the exact behavior the PR removed.

The Opus 5 review was posted as a PR comment and included a **plan-compliance table** — per-requirement R1–R27 status, AE coverage, and unmet Verification Contract items — which makes every finding auditable against the plan rather than an opinion. All P1/P2 findings were fixed in one pass (11 files, +287/−80; 127 tests, `tsc` clean).

### 3. Process model selection for sole-reaper components

For a component whose failure means no deadline enforcement anywhere (the watchdog is the sole reaper), the process model is a safety decision, not a style choice. **One-tick** (the OS scheduler invokes one scan-act-heartbeat-exit per cadence) is stronger than a **resident loop** when the scheduler supervises each invocation: each tick is crash-independent, there is no signal handling, there is no in-memory state (everything is read from disk), and a wedged tick is bounded by the scheduler's own timeout.

The resident loop's silent failure mode: crash + restart reads its own fresh heartbeat and exits "healthy" while nothing is running — and admission still reads healthy for another cadence. A silent enforcement outage triggered by the recovery path itself. The plan (F14) specified one-tick; the implementation had defaulted to resident loop; an advisor agent arbitrated (finding F-002) and recommended one-tick decisively. Final shape: one-tick default in the bin entry (`--once`), with `--resident` / `--mode service` retained as the verified fallback (`src/watchdog-main.ts`, `src/commands/watchdog.ts`).

### 4. Copilot fallback: frontier-model review posted as a PR comment

When Copilot review errors repeatedly (6 times here), dispatch a frontier model (Claude Opus 5) to review the branch and post the review as a PR comment — the audit trail lives on the PR. When the second-pass Opus 5 agent hit an auth failure, the pipeline fell back to minimax-m3 (ran tests, did not post) and merged on the first review's fixes + 127 passing tests + CI green. Record the fallback decision: a review bot is infrastructure, not a gate with only one path.

### Cautionary note: orphan Paseo projects

E2e runs that create random temp dirs accumulate orphan Paseo projects (Paseo auto-derives projects from temp paths). Fix: use a fixed-path scratch dir instead of random `mkdtemp`; clean existing orphans with `paseo project delete`.

## Why This Matters

- **Sole-reaper components make the process model safety-critical.** The resident loop's crash-restart failure mode is silent, and admission's health signal would lie through it — the watchdog is the only enforcement of per-dispatch deadlines, so its process model determines whether enforcement can silently disappear.
- **Cross-family review genuinely surfaces distinct defects at scale.** Two families found disjoint sets of real issues; one review pass — even a strong one — is not enough for a 30-file change.
- **Context windows bound agent scope.** "One agent per feature" is a fallback, not a plan. Every agent boundary must be a verification gate with the suite run by the orchestrator; the pipeline must be resumable between agents.
- **The merge-ready loop must survive a failing review bot.** A frontier model posting a review as a PR comment preserves the gate and the audit trail without the bot.

## When to Apply

- An implementation-ready plan too large for one agent's context window (~30 files, 500+ plan lines) — sequence bounded agents with verification gates between them.
- A component with silent failure modes (daemon, watchdog, scheduler-driven) — arbitrate the process model with an advisor before shipping.
- Any PR where Copilot review fails repeatedly — swap in a frontier-model review posted as a PR comment.
- Same prerequisites as the sibling dispatcher doc: opencode + Paseo, CE plugin skills, and `gh` CLI with a GitHub remote.

## Examples

**Agent sequence and counts from the validating session** (full record: `docs/session-digests/2026082401_watchdog_daemon_dispatch_implementation.md`): impl agents 1–4 (driver-side, watchdog completion, test fixtures, e2e orphan fix) → simplify (16 improvements, risky changes declined, tests green) → minimax-m3 review (25 findings: 4 P1 / 13 P2 / 8 P3) → P1 fixes (121 tests) → process-model flip (one-tick default, `--mode` flag added) → docs + kill-drill (124 tests) → ship PR #13 → CI green on first check → Copilot failed 6 times → Opus 5 review (3 P1 / 10 P2 / 11 P3, PR comment with R1–R27 compliance table) → all P1/P2 fixed (11 files, +287/−80; 127 tests, `tsc` clean) → merged (squash `a221bf5`).

**Process-model flip before/after:**
- Before: resident loop default — the bin entry ran `runLoop()` (in-memory sleep, heartbeat-guard single-instance check).
- After: one-tick default (`--once`) — `tick()` scans, kills, writes receipts, drains, writes the heartbeat, and exits; the scheduler re-invokes per cadence. `--resident` / `--mode service` retained as the verified fallback.

**Plan-compliance review table:** the Opus 5 review's R1–R27 table turned "was this planned behavior shipped?" into a per-requirement checkbox (e.g., R20 "healthy ≤ 2× configured cadence" flagged ❌ because the heartbeat judged itself). Reviewing against the plan's requirement table is what made the P1/P2 fix list mechanical.

## Related

- **Sibling pipeline doc:** `docs/solutions/patterns/dispatcher-delegated-feature-delivery-pipeline.md` — the 14-stage delegated pipeline validated on PR #9; this doc is the large-plan variant with sequential implementation agents and the Copilot fallback.
- `docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md` — per-unit cross-family verification; this doc extends the principle to PR-level code review.
- `docs/solutions/patterns/simplify-before-third-party-code-review.md`, `docs/solutions/patterns/disk-first-paseo-loop.md` — simplify ordering and verify-on-disk supervision.
- **Full-depth runbook:** `docs/runbooks/feature-delivery-delegated-lfg-runbook.md`.
- **This feature's record:** PR #13 (watchdog daemon, squash `a221bf5`); `docs/plans/2026-08-19-001-feat-miah-watchdog-daemon-plan.md`; `docs/session-digests/2026082401_watchdog_daemon_dispatch_implementation.md`; `docs/residual-review-findings/feat-watchdog-daemon.md` (P3 findings deferred to follow-up).
- **Vocabulary:** `CONCEPTS.md` — Watchdog daemon section (watchdog, reap receipt, driven time, sole reaper, one-tick process model).