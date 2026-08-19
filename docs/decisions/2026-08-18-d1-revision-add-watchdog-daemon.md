---
title: D1 revision — rescind the no-daemon constraint; add a Miah-installed watchdog daemon
date: 2026-08-18
session: Operator brainstorm on per-agent/per-run time limits
scope: revises D1 ("Long-running Miah daemon" rejection; the "not a daemon" clause) and its
  downstream consequences (OP-1, C2) in
  docs/decisions/2026-08-06-d1-d2-runtime-and-agent-invocation.md
status: decided by the operator, 2026-08-18
supersedes: the "not a daemon" clause of D1 and the "Long-running Miah daemon" rejected
  alternative, both in docs/decisions/2026-08-06-d1-d2-runtime-and-agent-invocation.md
superseded_by: nothing yet
---

# D1 revision — add a Miah-installed watchdog daemon

## Context

Two brainstorm threads (per-unit dispatch deadlines, and run-level max-duration) converged on the
same gap: Miah can refuse late work and terminate a runaway specialist, but **only while a driver
process is alive to observe the deadline**. If Miah is not running — crashed, or simply never
invoked again — nothing stops an overdue specialist or an overdue run.

Options considered, in order:

1. **Paseo `create_schedule`** — reuses Paseo's already-installed daemon to trigger a periodic
   check. Rejected as the sole mechanism: every scheduled tick launches a full LLM agent session
   (`paseo schedule create <prompt>` has no plain-script/webhook mode — confirmed against the
   installed CLI, 2026-08-18), so a tight cadence is not cheap, and a loose cadence weakens the
   guarantee.
2. **A Miah-installed watchdog, registered as an OS-native background service** (Task Scheduler /
   systemd / launchd) — a plain, non-LLM process that polls the run store on disk and calls the
   `paseo` CLI directly to terminate overdue agents. Cheap per-tick, but is exactly the resident
   process D1 declined to build.

The operator chose option 2 and directed that the no-daemon constraint be rescinded.

## Decision

**D1's "not a daemon" clause is rescinded. Miah's installer adds a small watchdog daemon whose only
job is deadline enforcement.**

What does **not** change — D1-a through D1-g stand:

- The supervisor is still a pure step function over a durable run directory (D1-a).
- The driver/loop is still a separate, non-privileged concern; a terminal, cron, or Paseo schedule
  can still drive `miah run` (D1-b).
- A run nobody is driving is still *paused, not lost* (D1-c) — the watchdog does not drive the
  supervisor loop or make acceptance decisions. It cannot advance a unit, accept evidence, or
  resolve an escalation. Its only authority is to terminate an overdue dispatch/run and write the
  same durable stop signal the operator-invoked `miah stop` path already writes.
- Dispatch is still by durable handle (D1-d); results are still file-based (D2-b); the control store
  is still out-of-tree and owner-only (D1-g).

What changes:

- **New component: `miah-watchdog`.** Installed alongside the `miah` CLI, registered as an OS
  background service at install time (Windows Task Scheduler / a Windows service; `systemd` unit on
  Linux; `launchd` agent on macOS). Uninstalled cleanly when Miah is uninstalled.
- **Scope, mechanical only (consistent with D1-e — Miah's own decisions are mechanical, not
  judgmental):** on a short interval, read `~/.miah/runs/*/manifest.json` + in-flight dispatch
  records; for anything past its recorded `deadline` or past `run.max_duration_s`, call `paseo agent
  stop`/`kill_agent` on the recorded handle and write `stop-requested.json` / a
  `dispatch_terminated` outcome — the same durable artifacts the driver already produces when it is
  alive and catches the same condition. The watchdog never reads plan content, never grades
  evidence, never journals an acceptance or escalation decision.
- **No LLM calls.** The watchdog is a plain scheduled check, not an agent — it only calls the
  `paseo` CLI/API to terminate handles it already has recorded IDs for.
- **Revises OP-1's framing:** OP-1 (2026-08-06) settled the *supervisor's* driver as non-agent but
  did not require a background service, reasoning that "the running driver is the budget observer."
  That remains true when a driver is running; the watchdog exists specifically for when it is not.
- **Revises the C2 rejection:** C2 rejected a *mandatory persistent observer sidecar* required for
  run admission. The watchdog is not that — admission does not depend on the watchdog being
  installed or healthy (a missing/dead watchdog degrades the time-bound guarantee, it does not block
  a run from starting). Whether it should become admission-mandatory is an open item below.
- **Revises the "Long-running Miah daemon" rejected alternative:** its stated costs (install,
  autostart, lifecycle burden) are accepted as a deliberate tradeoff for a hard wall-clock guarantee
  that does not depend on Miah's process being alive. Its stated risk (drifting toward a
  general-purpose orchestration platform) is bounded by keeping the watchdog's authority to
  "terminate + write the existing stop signal" only — it gains no new decision-making power.

## Open items — SETTLED by the operator, 2026-08-19

1. **Install-time default: opt-in.** The watchdog is not installed automatically by the Miah
   installer; the operator installs/starts it via a separate command.
2. **Cadence: 5 minutes by default, operator-configurable.** No LLM cost either way, so this is a
   pure latency/resource tradeoff — a unit or run can run up to ~5 minutes past its deadline before
   being reaped under the default.
3. **Admission dependency: fail closed.** `miah start` requires a healthy watchdog, matching the
   existing `max-duration-absent` fail-closed posture.
4. **Relationship to `max-duration-absent`: the watchdog satisfies the gate.** Once it exists and
   passes a kill-drill (kill Miah mid-dispatch, confirm the watchdog still terminates the agent on
   schedule), its presence + health is what the admission gate checks — the gate is no longer keyed
   to Paseo shipping native per-agent max-duration specifically.

**Consequence of 1 + 3 together, recorded so it isn't rediscovered as a surprise later:** because
install is opt-in but admission fail-closed requires a healthy watchdog, a fresh Miah install cannot
admit *any* run until the operator explicitly installs and starts the watchdog. This is not a new
restriction in practice — admission already fails closed today on `max-duration-absent` for the same
reason (no hard external bound exists yet) — it just changes *what* satisfies the gate, from
"Paseo ships the feature" (blocked, out of Miah's control) to "operator runs the watchdog install
step" (available immediately, in Miah's control).

These answers unblock a `ce-plan` implementation pass.

## Downstream documents needing updates once implementation is planned

- `docs/decisions/2026-08-06-d1-d2-runtime-and-agent-invocation.md` — D1's "not a daemon" clause and
  the "Long-running Miah daemon" alternatives-table row are superseded by this document; left
  in place as the historical record rather than rewritten.
- `docs/architecture/design-decisions.md` §1 ("no daemon") and §26 ("No background service or
  daemon") — need a superseded-by pointer to this document.
- `docs/risks.md` — the `max-duration-absent` posture may change once open item 4 above is settled.
- `docs/solutions/patterns/paseo-per-agent-hard-bound-verification.md` — the pattern's premise
  (no external hard bound exists) is what this decision addresses.
- `OPERATOR.md` / `README.md` — installer instructions will need a watchdog section.
