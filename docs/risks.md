# Risk Log (RAID — Risks)

Living register of risks affecting Miah operations and development. One entry
per risk. Statuses: `open` | `accepted` | `mitigated` | `closed`. All decisions
are made by the operator and recorded with date and rationale.

## R-001 — Agent-orchestration MCP toolset injected into specialists

- **Status:** `accepted` (operator decision, 2026-08-15)
- **Category:** Security / evidence integrity
- **Affects:** Any Miah run on a host where `~/.paseo/config.json` sets
  `daemon.mcp.injectIntoAgents: true` (currently `true` on this machine).

### Description

When the Paseo daemon has MCP injection enabled, every agent it launches —
including Miah's dispatched specialists — receives the agent-orchestration MCP
toolset: agent create/dispatch, workspace management, terminal capture, browser
automation, schedules/heartbeats (`@getpaseo/server` `bootstrap.js` +
`agent-manager.js`; there is no per-agent scoping flag in the installed CLI).

Miah's dispatch packet confines specialists (`src/packet.ts`): verifiers are
read-only except their result envelope, builders may write only declared
`creates:` paths inside their own worktree, and recursive workers / run-store
writes / scope changes are prohibited. Those bounds are prompt-level. With the
orchestration toolset injected, a specialist (cooperative, hallucinating, or
prompt-injected from untrusted repo content) could mechanically:

1. Run arbitrary commands via terminal tools — read/write outside its worktree,
   including the `~/.miah` run store and operator config.
2. Spawn sub-agents that are unjournaled, unbounded by Miah's takes/rework/
   deadline controls, and (absent a daemon-enforced max-duration) unbounded in
   runtime.
3. Inspect other agents' logs/dispatches — breaking verifier independence.
4. Use browser tools for exfiltration or destructive side effects.

### Likelihood / impact

- **Likelihood:** Low — requires a misbehaving or prompt-injected specialist;
  no known exploit path today.
- **Impact:** High if realized — evidence custody, verifier independence, and
  bounded autonomy are the product's core guarantees.

### Existing mitigations

- Miah admission fails closed while injection is unscopable (R21/R87;
  `src/admission.ts`) — `miah start` refuses, so today the risk cannot
  materialize inside a Miah run on this host.
- Worktree isolation; dual-hash T2–T3 evidence continuity; bounded rework/takes.
- Operator can disable injection at runtime (`paseo reload`).

### Decision

**Accepted** by the operator on 2026-08-15: deemed an acceptable risk given the
low likelihood and existing fail-closed controls.

Operational note: this acceptance is a human risk-register decision. Miah's
admission gate is unchanged and will continue to refuse admission while
injection is unscopable; running Miah with injection enabled would require a
code change (per-agent MCP scoping or an explicit override), which is out of
scope unless the operator requests it.

## R-002 — Watchdog failure (sole enforcer of deadlines)

- **Status:** `mitigated` (code-level mitigations shipped with watchdog daemon)
- **Category:** Reliability / deadline enforcement
- **Affects:** Any Miah run relying on the watchdog for max-duration enforcement.

### Description

The watchdog is the sole component that terminates overdue specialists (R2,
Revision 2 rationale). If the watchdog process crashes, is unregistered from
the scheduler, or its heartbeat goes stale, no component will enforce dispatch
deadlines. The driver no longer kills directly — it only drains receipts at
step boundaries — so a dead watchdog means overdue agents run indefinitely.

### Likelihood / impact

- **Likelihood:** Low — the watchdog is a simple single-purpose process (scan,
  kill, receipt, heartbeat). It does not hold the lease, journal, or do
  complex state management. Failure modes: scheduler deregistration, Paseo CLI
  auth failure in the scheduled context, or OS-level process kill.
- **Impact:** High if realized — unbounded agent runtime burns operator budget
  and could block the run indefinitely.

### Existing mitigations

- **Heartbeat + admission check (primary):** The watchdog writes a heartbeat
  on every tick. `miah start` checks heartbeat freshness as part of admission:
  a missing or stale heartbeat (older than 2× cadence) causes admission to
  fail closed, naming the install command. This prevents new runs from starting
  when the watchdog is unhealthy.
- **Platform scheduler restart:** Windows Task Scheduler (v1) automatically
  restarts the watchdog on its configured cadence. A missed tick is followed
  by the next scheduled invocation.
- **Paseo CLI dependency (load-bearing):** The watchdog shells out to Paseo to
  terminate agents. If Paseo CLI auth fails in the scheduled context, the
  watchdog records `adapter-failed` in the receipt. This is the highest-severity
  dependency — a broken Paseo auth means no deadline enforcement at all.
  Mitigated by U5's verification step (install-time auth check).

### Decision

**Mitigated** by the operator on 2026-08-19: the heartbeat + admission gate
provides fail-closed behavior for new runs, and the simple process design
minimizes the failure surface. The Paseo CLI auth dependency is documented and
tested (U5 verification). Follow-up work may add an in-band signal from
watchdog to driver (named in plan scope boundaries).

## R-003 — Receipt consumption lag

- **Status:** `mitigated` (design-level mitigation in receipt pattern)
- **Category:** Correctness / journal consistency
- **Affects:** Any Miah run where the watchdog terminates a specialist while the
  driver holds a fresh lease.

### Description

When the watchdog kills an overdue specialist while the driver holds a fresh
lease, it writes a reap receipt but does not touch the journal (R5). The
driver must drain the receipt at its next step boundary to journal the
`gap_recorded` + `dispatch_terminated` events. If the driver is delayed in
reaching its step boundary (e.g., long poll cycle, operator pause), the
receipt sits on disk and the journal is temporarily inconsistent — the
specialist is dead but the journal has not yet recorded it.

### Likelihood / impact

- **Likelihood:** Medium — this is the normal AE2 flow, not an error path. The
  driver will always reach its step boundary eventually (it polls on a
  cadence), but the window between kill and drain is real.
- **Impact:** Low if realized — the journal is temporarily behind, but the
  receipt is the durable record of what happened. The driver will drain it at
  the next step boundary, and the kill-drill tests verify this path (AE3).
  No data is lost; only the timing of the journal event is delayed.

### Existing mitigations

- **Driver drains at step boundary (primary):** The driver's poll loop calls
  `drainReapReceipts()` at every step boundary, which reads receipts, matches
  them to in-flight intents, appends `gap_recorded` + `dispatch_terminated`,
  and deletes the receipt file. This is the designed handoff mechanism.
- **Idempotent drain:** `drainReapReceipts()` is idempotent — re-draining a
  receipt whose intent is already terminated discards the receipt without
  double-journaling (AE5). This makes the lag window safe.
- **Kill-drill verification:** The kill-drill test suite (v3 + watchdog
  kill-drill) verifies the full lifecycle: watchdog kills → receipt written →
  driver drains → journal consistent. AE3 specifically tests the driver-side
  drain path.

### Decision

**Mitigated** by the operator on 2026-08-19: the receipt pattern is the
designed bridge between the watchdog and the driver, and the lag window is
inherent to the separation-of-concerns architecture. The idempotent drain and
kill-drill tests provide correctness guarantees. No further action needed.
