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
