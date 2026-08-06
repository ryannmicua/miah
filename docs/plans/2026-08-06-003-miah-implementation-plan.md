---
title: Miah Implementation Plan - Plan
type: feat
date: 2026-08-06
topic: miah-implementation
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
deepened: 2026-08-07
---

# Miah Implementation Plan - Plan

## Goal Capsule

- **Objective:** Build Miah v1 — a standalone CLI that supervises one immutable approved-plan snapshot through isolated specialist agents (planner, builder, tester, reviewer) with durable evidence, bounded autonomy, crash recovery, and operator approval gates.
- **Authority hierarchy:** `VISION.md` governs product behavior; `STRATEGY.md` supplies priorities; this plan governs implementation. The two approved brainstorm artifacts (D1/D2 and D3/D4/D5/D9) supply settled requirements R1-R62 and are `superseded_by` this plan — their content is carried forward without modification or re-litigation.
- **Stop conditions:** (a) every requirement R1-R90 is implemented and verified; (b) the kill drill passes (kill mid-run, resume, byte-identical state); (c) admission fails closed when the Paseo per-agent `max-duration` mechanism is absent; (d) `miah preflight`, `miah status`, `miah stop`, and the final approval package work end-to-end against a test CE plan.
- **Execution profile:** A single TypeScript/Node.js CLI executable, no background service, installed via npm, running operator-side on Windows 10 + Git Bash.
- **Open blocker:** The daemon-enforced per-agent `max-duration` (R4/R5) is a Paseo feature ask — feasible (schedule `expiresIn` precedent) but UNSHIPPED in v0.3.0-beta.2. Admission fails closed until it exists. Everything except the substrate probe is built and tested against a probe that honestly reports absent.
- **Tail ownership:** The Phase 3 builder executes these units sequentially, verifying each before advancing. The kill drill (U10) is the first-class verification milestone — it is not decorative.

---

## Product Contract

### Summary

Miah v1 is a standalone CLI whose reconstructable core is the sole runtime authority: an immutable plan snapshot + append-only journal + single-writer lease. The supervisor loop is a pure step function; every invocation replays the journal, reconciles reality, performs the next safe transition, and appends. Specialists (planner, builder, tester, reviewer) are independently dispatched isolated Paseo sessions; results are file-based envelopes Miah harvests after termination. Independence is a dispatch invariant enforced at the acceptance gate, not a role label. Checker authority comes from calibration (operator-assisted), not model family. Evidence is what Miah harvests from artifacts — diffs, exit codes, test outputs, usage deltas — never agent prose. Acceptance is a decidable predicate: each criterion has a pass at or above its declared tier with no open evidence gap. Preflight is a pure function over plan plus workspace; admission is `preflight ∧ substrate-readiness`, fail closed. The operator drives via a CLI-first interface: status, stop (journaled), escalation resolution, final approval, and change orders.

**Supersession:** This plan supersedes-reconciles both brainstorm artifacts:
- `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md` — `superseded_by: this plan` (D1/D2 requirements R1-R21 carried forward verbatim).
- `docs/plans/2026-08-06-002-feat-miah-artifacts-plan.md` — `superseded_by: this plan` (D3/D4/D5/D9 requirements R22-R62 carried forward verbatim).

No R1-R62 requirement is modified, weakened, or amended. R63 onwards are new, added by this plan for D6/D7/D8. If a new requirement interacts with a prior one, the prior remains authoritative for its scope.

### Problem Frame

Miah must recover from the death of any individual agent session or its own process without losing workflow state, repeating an unsafe action, or confusing a specialist's claim with proof. A session-bound agent cannot own that promise because its conversation dies with its session; a resident process cannot own it because memory disappears on failure. The solution is a pure step function over a durable run directory — the loop lives on disk, not in a process.

Independence is the matching structural problem. Calling a session a tester does not make it independent if it inherits the builder's context. The invocation mechanism must create separation that can be inspected after the fact: fresh sessions, distinct worktrees, redacted maker narrative, and a calibration-gated verdict authority.

Evidence and acceptance close the trust question. A builder's self-report is an input, not a fact. Miah harvests what it can verify itself — diffs, exit codes, test outputs, usage deltas — and hashes each artifact into a custody chain. Acceptance is a decidable predicate, not a judgment call: does every criterion have a qualifying pass at or above its declared tier with no open evidence gap? If not, the unit stays unaccepted.

The operator must see where the run stands, stop it cleanly, resolve escalations, and approve the final result — all through a CLI surface that makes problems visible rather than hiding them in a context window. Arun that nobody is driving is paused, not lost.

### Key Decisions

**D6 — Operator interface (CLI-first, minimal)**

- D6-a. The CLI surface is: `miah preflight <plan>`, `miah start <plan>` (admission + lease + first step), `miah run [run-id]` (loop driver; `--once` advances one step and exits), `miah status [run-id]`, `miah stop <run-id>`, `miah resolve <run-id> <escalation-id> --decision <approve|deny|rework> [--note <text>]`, `miah approve <run-id>`, `miah reject <run-id> [--rework <unit-ids>|--end]`, `miah amend <run-id> <new-plan>`.
- D6-b. `miah status` renders the run-phase FSM (reconstructed from `phase_transition` journal events), per-unit state (accepted / rework / in-flight / blocked), open evidence gaps, pending escalations, and cumulative usage deltas.
- D6-c. `miah stop` writes an `operator_decision: stop` journal event. The lease-holding driver reads the journal at each step boundary, sees the stop decision, and gracefully terminates in-flight specialists (via adapter stop) before releasing the lease. Stop is journaled, not a bare signal, so it survives restart.
- D6-d. Escalations reach the operator through the looping driver: when no executable work remains or a run-wide issue blocks, the driver transitions to `Attention` phase, prints the escalation details to stdout, appends `escalation_raised`, and **exits** (the run is paused, not lost). The operator later polls via `miah status` and resolves via `miah resolve`. No push notifications in v1; an operator who wants them wraps `miah run` output in a notification script.
- D6-e. The final approval package: when all units are accepted, Miah transitions to `AwaitingApproval`, writes a consolidated evidence summary (per-unit evidence pointers, acceptance records, usage totals, gap history) to the run store, prints it, and exits. The operator runs `miah approve <run-id>` (terminal → `run_terminal: complete`) or `miah reject <run-id> [--rework <unit-ids>|--end]`.
- D6-f. Change orders: `miah amend <run-id> <new-plan>` creates a new snapshot version in the run store, runs preflight scoped to affected units (those whose `creates:` or `inputs:` changed, plus dependents), appends `amendment_applied` with the new snapshot hash, and resumes only affected units. If any affected unit is in-flight, Miah pauses it first. The original snapshot is never mutated.

Governs R63-R70.

**D7 — Thresholds and limits (mechanism fixed, defaults set)**

- D7-a. Journal snapshot cadence: `K = 50` events. Snapshots store derived state only (statuses, IDs, hashes, evidence-file references), never raw contexts or prose. Operator-configurable via `~/.miah/config.json`.
- D7-b. Lease heartbeat: rewrite `lease.lock` heartbeat field every `30s`; TTL `60s` (two heartbeat intervals). A resumer takes the lease only after the recorded heartbeat is stale past TTL plus one renewal attempt that fails. No POSIX-only primitives.
- D7-c. Per-agent `max-duration`: default `15m` per specialist dispatch. **Blocked** — admission fails closed until the Paseo daemon enforces it. Operator-configurable per dispatch and via config.
- D7-d. Calibration bar: `≥15-case` corpus, `>14/15` agreement, `≤2` false-blocks, `zero` false-pass floor. The zero-false-pass floor is non-negotiable falsification-floor discipline; the agreement and false-block thresholds are operator-configurable. v1 ships with default-empty calibration corpora — profiles admit at no verdict authority until the operator supplies calibration.
- D7-e. Concurrency cap: default `1`. The mechanism is exercised (the dispatch primitive supports N) while early runs stay simple. Operator-configurable.
- D7-f. No-progress detection: `3` consecutive adapter polls (at step-boundary poll cadence) with no lifecycle or activity change **while Miah is alive** → `escalation_raised: no-progress`. Miah **cannot** claim no-progress across a downtime gap (D1/D2 A1: the journal cannot distinguish "agent hung for three hours" from "Miah was dead for three hours"). After a restart, Miah reconciles by querying the adapter; if the agent is still active, it resumes polling; if terminal, it harvests. It does not retroactively attribute downtime to agent hang.
- D7-g. Retry/rework bounds: max `3` takes per unit (a take is one builder dispatch attempt); max `2` rework cycles per unit (a rework cycle is one builder rebuild after a failed acceptance). Exhausting either → `escalation_raised: repeatedly-fails`.
- D7-h. "Repeatedly fails" = max takes exceeded OR max rework cycles exceeded OR no-progress threshold exceeded. Each triggers an operator escalation, never auto-termination.
- D7-i. All thresholds are operator-configurable via `~/.miah/config.json` or run-manifest overrides; defaults are documented in `miah --help` and the config file.
- D7-j. Budget predicates are evaluated synchronously before each dispatch and before each poll cycle: per-agent duration remaining, takes remaining, rework cycles remaining, no-progress count, cost ceiling (if set). A failing predicate routes to escalation, not silent skip.

Governs R71-R82.

**D8 — Tech stack and delivery**

- D8-a. Language: TypeScript + Node.js. Matches the operator's ecosystem (Paseo, OpenCode, Codex are npm-based), JSON is native (the journal is JSONL), cross-platform via Node `fs`, and npm install gives a single CLI command. Go was considered and rejected as adding a new toolchain to the operator's ecosystem without a compensating benefit at the one-active-plan scale.
- D8-b. Packaging: npm package with a `miah` bin entry. Installed globally (`npm install -g @miah/cli` or repo-local `npm link`). No background service, no daemon installation, no system-level setup. `miah` runs where the repo is.
- D8-c. Windows 10 + Git Bash portability: all file operations via Node's `fs` module (which handles Windows path semantics, atomic rename-as-atomic-replace is available on Windows via `fs.renameSync` on the same volume). The lease uses temp-write-then-rename (atomic on NTFS same-volume). No POSIX-only primitives (`flock`, `mkfifo`, signals) are load-bearing. Git Bash compatibility: the CLI invokes `git` via `child_process`; Git Bash provides git on PATH.
- D8-d. Paseo substrate probe contract: the probe queries the live daemon for (a) per-agent `max-duration` readiness and (b) post-termination workspace immutability. Both must be **re-verified against the current Paseo v0.3.0-beta.2** during Phase 3 implementation (confirmed live version). The probe honestly reports "absent" when the feature does not exist; admission fails closed. The probe contract and exact CLI commands are specified in KTD4.
- D8-e. MCP injection scoping: the operator's daemon runs `daemon.mcp.injectIntoAgents: true`. Paseo v0.3.0-beta.2 has **no per-agent MCP injection scoping flag** (verified live: `paseo run --help` has no MCP-related option; `paseo agent update --help` has no MCP toggle; `paseo agent inspect --json` exposes `Capabilities.McpServers: true` but no per-agent disable). The substrate probe checks whether MCP injection is disabled for specialist dispatches. If global injection is on and no per-agent scoping exists, admission fails closed per R21/AE8. The v1 operator workaround is to disable `daemon.mcp.injectIntoAgents` globally during Miah runs.
- D8-f. Worker env secret-scrubbing: `paseo run --env <key=value>` adds env vars but does not remove inherited ones (the agent process inherits the daemon's env, which may contain secrets like `OPENAI_API_KEY`). v1 mitigates by flagging this as a documented residual risk; the primary defense is worktree isolation (specialists write only to their worktrees) and Miah-harvested evidence (Miah controls what counts). Full env scrubbing is deferred to v2 pending a Paseo `--clean-env` or `--scrub-env` feature.
- D8-g. Hash-chained custody: SHA-256 content hash per harvested artifact; each custody header carries `(role, agent_id, attempt, take, harvest_ts, content_hash, prev_hash)`, forming a chain ordered by harvest time. A broken or missing chain link is an evidence gap (R45).
- D8-h. Integration step: when a unit is accepted, Miah copies only the accepted `creates:` paths from the unit's worktree commit into a checkout of the canonical worktree, runs the unit's verification contract commands in the integrated checkout (R54), and commits the integration. Test code the plan did not declare in `creates:` is harvested as evidence but not integrated (R53).
- D8-i. Role→model defaults: Miah reads the operator's `~/.paseo/orchestration-preferences.json` for per-role provider/model defaults (verified live 2026-08-06):

  | Miah role | Paseo role | Provider/Model |
  |---|---|---|
  | Planner | planning | codex/gpt-5.6-sol |
  | Builder | impl | opencode-go/deepseek-v4-flash |
  | Tester | audit | opencode-go/glm-5.2 |
  | Reviewer | audit | opencode-go/glm-5.2 |

  Cross-family contrast is enforced per D2-c.5 (builder ≠ checker per unit). The operator may override per dispatch.

- D8-j. Test approach: the kill drill (kill supervisor mid-run, assert byte-identical state on resume) is the central verification property. Unit tests cover journal replay, lease semantics, preflight logic, acceptance predicate, gap mechanism, and custody chain. Integration tests use a test CE plan against the live Paseo daemon. The kill drill is extended at U3 (journal-level), U5 (dispatch-level), and U10 (full E2E).

Governs R83-R90.

### Requirements

**R1-R21: carried forward verbatim from `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md`.**

These requirements govern runtime authority, recovery, specialist creation, isolation, parallel dispatch, and monitoring. They are not restated here; the artifact is in-repo and authoritative. Key load-bearing items for Phase 3 sequencing: R4/R5 (per-agent `max-duration` — unshipped, admission fails closed), R7-R11 (specialist dispatch and independence), R12-R16 (parallel dispatch and single-writer journal serialization), R21 (MCP injection scoping).

**R22-R62: carried forward verbatim from `docs/plans/2026-08-06-002-feat-miah-artifacts-plan.md`.**

These requirements govern plan input format, journal and state schema, evidence contract, and plan preflight. Key load-bearing items for Phase 3 sequencing: R22-R30 (plan admission and `units.json`), R31-R42 (journal, lease, kill drill acceptance), R43-R54 (evidence, custody, grading, gaps, integration check), R55-R62 (preflight, substrate probe, postflight).

---

**D6 — Operator interface (R63-R70)**

- R63. The CLI command surface must be exactly: `miah preflight <plan>`, `miah start <plan>`, `miah run [run-id] [--once]`, `miah status [run-id]`, `miah stop <run-id>`, `miah resolve <run-id> <escalation-id> --decision <approve|deny|rework> [--note <text>]`, `miah approve <run-id>`, `miah reject <run-id> [--rework <unit-ids>|--end]`, `miah amend <run-id> <new-plan>`, and `miah list`. No GUI, no web server, no TUI.
- R64. `miah status` must render: run id, plan title and snapshot hash, current run phase (from the latest `phase_transition` event), per-unit state (accepted / in-flight / rework / blocked / not-started), open evidence gaps with `(unit, criterion, reason)`, pending escalations with escalation id and reason, cumulative usage deltas (input tokens, output tokens, cost), and lease holder/heartbeat status.
- R65. `miah stop` must append an `operator_decision: stop` event to the journal and set a run-store `stop-requested` flag; the lease-holding driver must read this at the next step boundary, terminate in-flight specialists via the adapter, append `phase_transition: Stopping`, and release the lease. A stop decision recorded while no driver is alive must be honored on the next `miah run` or `miah run --once`.
- R66. When the step function finds no executable work remains or a run-wide blocking condition occurs, the driver must append `escalation_raised`, transition to `Attention` phase, print the escalation details (unit, reason, evidence summary) to stdout, and exit; the run is paused (per D1-c, liveness is degradable), not lost. The operator resolves via `miah resolve` and resumes via `miah run`.
- R67. When all units are accepted, the step function must transition to `AwaitingApproval`, write a consolidated approval package to `~/.miah/runs/<run-id>/approval-package.json` (per-unit evidence-file pointers, acceptance records, gap close reasons, usage totals, snapshot hash, run duration), print a summary to stdout, and exit. The operator approves (`miah approve <run-id>` → `run_terminal: complete`) or rejects (`miah reject <run-id> [--rework| --end]` → rework or terminal).
- R68. `miah amend <run-id> <new-plan>` must: run preflight on the new plan, create a new snapshot version (`plan-snapshot.<version>.md`), diff the new `units.json` against the previous version, identify affected units (those whose `creates:`/`inputs:`/`depends-on` changed, plus transitive dependents), append `amendment_applied` with the new hash and affected-unit list, and mark only affected units for re-dispatch. In-flight affected units must be paused (terminated via adapter) first. The original snapshot must never be mutated.
- R69. All operator actions (`stop`, `resolve`, `approve`, `reject`, `amend`) must be journaled as `operator_decision` events with operator identity, timestamp, decision, and optional note. An operator action recorded while no driver is alive must be honored on the next `miah run`.
- R70. The CLI must require no network access, no daemon installation, and no system-level setup beyond `npm install`; it must run from any directory containing or referencing a target repo worktree and must write all durable state to `~/.miah/`.

**D7 — Thresholds and limits (R71-R82)**

- R71. Miah must write a periodic state snapshot (`snapshots/state-<seq>.json`) every `K = 50` journaled events (R41). K must be configurable via `~/.miah/config.json` (`journal.snapshot_cadence`). Snapshots store derived state only.
- R72. The lease heartbeat interval must be `30s` and the TTL must be `60s`; both configurable via `~/.miah/config.json` (`lease.heartbeat_interval_s`, `lease.ttl_s`). A resumer takes the lease only after the heartbeat is stale past TTL plus one failed renewal attempt, never by stealing a fresh-heartbeat holder (R39).
- R73. The per-agent `max-duration` default must be `15m` per specialist dispatch, configurable via `~/.miah/config.json` (`dispatch.max_duration`) and overridable per dispatch. **This value is not enforceable until the Paseo daemon ships the feature; admission must fail closed until then (R4/R5, R57).**
- R74. The calibration bar for the `calibrated-judge` tier must require: a calibration corpus of `≥15` pre-labeled cases, `>14/15` agreement, `≤2` false-blocks, and `zero` false-pass. The zero-false-pass floor is mandatory; agreement and false-block thresholds are configurable via `~/.miah/config.json` (`calibration.min_corpus`, `calibration.min_agreement`, `calibration.max_false_blocks`). v1 ships with default-empty corpora — no profile has verdict authority until the operator supplies calibration (R48).
- R75. The concurrency cap default must be `1`, configurable via `~/.miah/config.json` (`run.concurrency_cap`). The mechanism supports N; the default keeps early runs simple (R12).
- R76. No-progress detection must trigger an `escalation_raised: no-progress` after `3` consecutive adapter polls (at step-boundary cadence) with no lifecycle or activity change **while Miah is alive and polling**. Miah must not claim no-progress across a downtime gap — after a restart, it reconciles by querying the adapter and resumes or harvests, without retroactively attributing downtime to agent hang (D1/D2 A1). The threshold is configurable via `~/.miah/config.json` (`dispatch.no_progress_polls`).
- R77. Max takes per unit must be `3`; after the third failed take without acceptance, Miah must append `escalation_raised: repeatedly-fails` and route the unit to operator escalation. Configurable via `~/.miah/config.json` (`run.max_takes`).
- R78. Max rework cycles per unit must be `2`; after the second rework cycle still not accepted, Miah must append `escalation_raised: repeatedly-fails`. Configurable via `~/.miah/config.json` (`run.max_rework_cycles`).
- R79. "Repeatedly fails" must mean: max takes exceeded (R77) OR max rework cycles exceeded (R78) OR no-progress threshold exceeded (R76). Each triggers an operator escalation, never auto-termination.
- R80. All D7 thresholds must be operator-configurable via `~/.miah/config.json` with documented defaults; the config file must be read on every `miah` invocation, and a run in progress must use the config that was read at admission time (snapshotted into the manifest).
- R81. Budget predicates must be evaluated synchronously before each dispatch and before each poll cycle: per-agent duration remaining, takes remaining for the unit, rework cycles remaining for the unit, no-progress poll count, and cost ceiling (if set in config). A failing predicate must route to either escalation (for take/rework/no-progress limits) or stop (for run-level cost ceilings), never silent skip.
- R82. Escalation triggers must include: max takes exceeded (R77), max rework cycles exceeded (R78), no-progress threshold exceeded (R76), approved scope/requirements/acceptance criteria change needed (per VISION), security/privacy/legal/data-loss risk (per VISION), destructive/irreversible/unauthorized side effect (per VISION), unresolved high-severity test/review failure (per VISION), missing access/credentials/info/operator judgment (per VISION), cost ceiling exceeded (per VISION), no checker profile clears calibration bar for a criterion (R48/R20).

**D8 — Tech stack and delivery (R83-R90)**

- R83. Miah v1 must ship as a TypeScript/Node.js npm package with a `miah` bin entry, installable via `npm install -g` or `npm link` from a repo checkout; it must require no background service, no daemon installation, and no system-level setup beyond Node.js and git on PATH.
- R84. All file operations must use Node's `fs` module; the lease must use temp-write-then-rename (atomic on NTFS same-volume); no POSIX-only primitives (`flock`, `mkfifo`, Unix signals) may be load-bearing. The CLI must work on Windows 10 with Git Bash as the primary environment.
- R85. The hash-chained custody layer must use SHA-256 content hashes for every harvested artifact; each custody header must carry `(role, agent_id, attempt, take, harvest_ts, content_hash, prev_hash)`; the chain must be ordered by harvest and a broken or missing link must be an evidence gap (R45).
- R86. The substrate readiness probe must: (a) check for the Paseo daemon-enforced per-agent `max-duration` feature by querying daemon capabilities (exact API in KTD4); (b) check for post-termination workspace immutability by testing whether a terminated agent's worktree changes when written to after terminal status; both must be **re-verified against Paseo v0.3.0-beta.2** during Phase 3 implementation; if either is absent, admission must fail closed (R57).
- R87. The substrate probe must verify that specialist dispatches cannot access agent-orchestration MCP tools: check whether `daemon.mcp.injectIntoAgents` is disabled OR whether per-agent MCP scoping exists (verified absent in v0.3.0-beta.2 — see KTD5); if global injection is enabled and no per-agent scoping exists, admission must fail closed per R21/AE8.
- R88. Worker env secret-scrubbing: Miah must flag the residual risk that specialist agent processes inherit the daemon's full environment (including secrets like API keys); v1 mitigation is worktree isolation (specialists write only to their worktrees) and Miah-controlled evidence harvesting. The plan must document this as a known v1 limitation; full env scrubbing is deferred to v2 pending a Paseo `--clean-env` feature.
- R89. The integration step must: checkout the canonical worktree at the run base commit, copy only the accepted unit's `creates:` paths from the unit's worktree commit into the canonical checkout, run the unit's verification contract commands in the integrated checkout (R54), and commit the integration if verification passes. Test code not in `creates:` must not be integrated (R53).
- R90. The test approach must center on the kill drill (kill supervisor mid-run, assert byte-identical supervisor-derived state on resume, including intent-without-created and dead-past-deadline cases per R42) and the crash-recovery property (any crash point resumes correctly). Unit tests must cover journal replay, lease acquisition/stale-takeover, preflight, acceptance predicate, gap mechanism, custody chain, and FSM transitions. Integration tests must use a test CE plan against the live Paseo daemon with real specialist dispatches.

### Actors

- A1. **Operator:** approves the plan, resolves escalations, supplies calibration corpora, approves/rejects final completion, issues change orders. Sole authority on scope.
- A2. **Miah CLI:** owns the lease, dispatch, evidence harvest, acceptance predicate, journal, and phase transitions. Never implements, tests, or reviews.
- A3. **Planner:** fresh read-only session on plan snapshot; derives bounded unit packets. No scope authority.
- A4. **Builder:** fresh session, dedicated worktree, authorized unit slice. Writes result envelope + work changes to its worktree only.
- A5. **Tester:** fresh session, pinned worktree at completion commit, frozen candidate. No builder context.
- A6. **Reviewer:** fresh session, read-only, evidence-pack consumer. Verdict authority only by calibration.
- A7. **Paseo:** durable dispatch handle, agent lifecycle, worktree workspaces, usage telemetry. Never leads run state.
- A8. **Run store:** `~/.miah/runs/<run-id>/` — manifest, snapshots, journal, lease, evidence. Owner-only, out-of-tree.

### Key Flows

F1-F12 are carried forward from the two brainstorm artifacts (F1-F5 from 001, F6-F12 from 002). New flows:

- F13. **Stop a run** *(D6)* — Trigger: operator runs `miah stop`. Steps: Miah appends `operator_decision: stop`, sets `stop-requested` flag. Driver reads it at next step boundary, terminates in-flight specialists, appends `phase_transition: Stopping`, releases lease. Covered by R65.
- F14. **Resolve an escalation** *(D6)* — Trigger: operator runs `miah resolve`. Steps: Miah appends `operator_decision: resolve` with the decision, appends `escalation_resolved` with close reason, and marks the affected unit for re-dispatch (if `rework`) or acceptance (if `approve`). Covered by R66, R69.
- F15. **Final approval** *(D6)* — Trigger: all units accepted. Steps: Miah transitions to `AwaitingApproval`, writes `approval-package.json`, prints summary, exits. Operator runs `miah approve` (terminal: complete) or `miah reject` (rework or end). Covered by R67.
- F16. **Apply a change order** *(D6)* — Trigger: operator runs `miah amend`. Steps: Miah preflights the new plan, creates new snapshot version, diffs `units.json`, identifies affected units + dependents, pauses in-flight affected units, appends `amendment_applied`, marks affected units for re-dispatch. Covered by R68.

### Acceptance Examples

AE1-AE20 are carried forward from the two brainstorm artifacts. New examples:

- AE21. **Covers R63-R64.** Given an admitted run in `Implementing` phase with unit U1 in-flight and U2 blocked on U1, an open evidence gap on U1, and one pending escalation, when the operator runs `miah status <run-id>`, then the command prints the phase, U1 as in-flight, U2 as blocked, the gap, the escalation, and cumulative usage — all read from the journal without launching a driver.
- AE22. **Covers R65.** Given a run with an in-flight builder and the operator runs `miah stop <run-id>`, when the driver reaches the next step boundary, then it terminates the builder via the adapter, appends `phase_transition: Stopping`, releases the lease, and a subsequent `miah run` resumes with the stop decision honored (the builder is not re-dispatched).
- AE23. **Covers R66.** Given a unit whose max takes are exhausted and no independent work remains, when the step function runs, then the driver appends `escalation_raised: repeatedly-fails`, transitions to `Attention`, prints the escalation, and exits. The run is paused; `miah status` shows the escalation; `miah resolve` closes it.
- AE24. **Covers R67.** Given all units are accepted, when the step function runs, then Miah writes `approval-package.json`, prints the summary, transitions to `AwaitingApproval`, and exits. The operator runs `miah approve` and the run terminates with `run_terminal: complete`.
- AE25. **Covers R68.** Given a running run where U1 is accepted and U2 is in-flight, when the operator runs `miah amend <run-id> <new-plan>` that changes U2's `creates:`, then Miah creates a new snapshot, preflights, identifies U2 as affected (plus any U2 dependents), terminates U2's in-flight specialist, appends `amendment_applied`, and marks U2 for re-dispatch without touching U1's accepted state.
- AE26. **Covers R86-R87.** Given the Paseo daemon has `daemon.mcp.injectIntoAgents: true` and no per-agent MCP scoping, when the operator runs `miah start <plan>`, then the substrate probe reports MCP injection as unscopable and admission fails with a message naming the missing mechanism and the operator workaround (disable global injection).
- AE27. **Covers R88.** Given a specialist agent inherits the daemon's env including `OPENAI_API_KEY`, when the builder runs, then it can read the key from its env, but its writes are confined to its worktree and Miah harvests only worktree diffs; the env exposure is recorded in the run manifest as a known v1 limitation.
- AE28. **Covers R89.** Given a builder declares `creates: ["src/foo.py"]` and produces `src/foo.py` plus a test file `test/foo_test.py` not in `creates:`, when the unit is accepted, then `src/foo.py` is integrated into the canonical worktree and `test/foo_test.py` is harvested as evidence (cited in the acceptance record) but not integrated.
- AE29. **Covers R90.** Given a run is mid-dispatch at unit U2, when the supervisor process is killed and `miah run --once` resumes, then the state reconstructed from the journal and `lease.lock` is byte-identical to the pre-kill state, the `dispatch_intent` without `dispatch_created` is reconciled by querying the adapter, and any work past the deadline is refused. (This is the kill drill.)

### Alternatives Considered

**D8 language alternatives**

- **Go (compiled binary):** rejected. While Go produces a cleaner single binary, it adds a new toolchain (Go compiler, Go module system, Go test framework) to the operator's npm/Node.js ecosystem. The entire support stack — Paseo, OpenCode, Codex — is npm/Node.js. The "single executable" constraint is satisfied by an npm bin entry. No benefit compensates for the toolchain mismatch at the one-active-plan scale.
- **Rust:** rejected. Same toolchain-mismatch argument, plus higher compile/edit-cycle overhead and steeper contributor curve for a v1 with zero existing code.
- **Python:** rejected. Packaging (pip, venv, pyinstaller) is more fragile than npm for CLI tool distribution, and the operator's ecosystem is Node-based, not Python-based.

**D6 notification alternatives**

- **Watched file + OS notification:** rejected for v1. Adds platform-specific notification machinery (Windows toast, terminal bell) for marginal gain. The operator can wrap `miah run` output in their own notification script.
- **Built-in Paseo heartbeat/schedule as notification channel:** rejected. A Paseo heartbeat continues an agent's own conversation (per `paseo-capabilities.md`); it is not a notification channel for Miah's CLI output.

**D7 threshold alternatives**

- **No-progress via agent activity hash:** considered. Hash the adapter's reported activity log and detect no-change. Rejected in favor of lifecycle/activity polling because it adds complexity and the adapter may not report activity hashes.
- **Max takes = 2 / max rework = 1 (aggressive):** considered. Tighter retry bounds save cost but risk premature escalations on transient failures. Default of 3/2 is a balance; operator can tighten.
- **K = 100 (sparser snapshots):** considered. Redes journal writes but increases worst-case replay time. K=50 balances replay cost and snapshot frequency for v1's run sizes.

### Scope Boundaries

**In scope (this plan)**

- Full implementation of R1-R90: runtime, dispatch, journal, evidence, preflight, admission, operator interface, thresholds, and tech stack.
- The Paseo substrate probe contract (honest absent reporting for unshipped features).
- The kill drill as first-class verification.
- Role→model defaults from the operator's orchestration preferences.

**Deferred for v2**

- Full worker env secret-scrubbing (R88 — pending Paseo `--clean-env`).
- Sub-journals and continue-as-new for long run histories (per 002 plan).
- Pre-dispatch preflight recurrence (per R62).
- A Paseo skill wrapper around the CLI (per D1/D2 plan — deferred, not rejected).
- Knowledge-work plan supervision (per A10 — operator scope decision).
- OS-level sandboxing of specialists (per prior-art OIR-001).

**Outside this product's identity**

- Miah as an implementation, testing, or review agent.
- A general-purpose multi-project, multi-run, or recursive agent-orchestration platform.
- Authoring or exploring the source plan.
- Push notifications, web UI, or a TUI.

### Dependencies and Assumptions

1. D1/D2/D3/D4/D5/D9 are settled (R1-R62); this plan implements them.
2. Paseo v0.3.0-beta.2 provides: persistent agent lifecycle, worktree workspaces, usage telemetry (PascalCase deltas), `paseo run --background`, `paseo inspect --json`, `paseo agent stop`. **Re-verify CLI contracts during Phase 3 implementation** (stale by one minor version per ecosystem-grounding §5; confirmed live version v0.3.0-beta.2).
3. Paseo v0.3.0-beta.2 does **NOT** provide: per-agent `max-duration`, per-agent MCP injection scoping, worker env scrubbing, post-termination workspace immutability guarantee. All must be probed at admission; admission fails closed if absent (R57, R86-R87).
4. The operator's daemon runs `daemon.mcp.injectIntoAgents: true` — the v1 workaround is for the operator to disable it globally during Miah runs.
5. Node.js 18+ and git are available on PATH in the operator's Git Bash environment.
6. v1 supervises `execution: code` plans only (D1/D2 A10 — recorded assumption, not a settled scope decision; operator may widen).

### Outstanding Questions

**Operator questions — surfaced with recommended answers. The operator may adjust before approving this plan.**

- OQ1. **Language choice.** Recommended: TypeScript/Node.js (D8-a). Rejected: Go, Rust, Python. *Operator decision: confirm or override.*
- OQ2. **Whether v1 also supervises `execution: knowledge-work` plans.** Recommended: No. The independence, custody, integration, and verification machinery is code-shaped (diffs, worktrees, commits, test exit codes). Widening is a product-scope decision the operator owns (D1/D2 A10). *Operator decision: confirm v1 is `execution: code` only.*
- OQ3. **MCP injection scoping strategy (R87).** Recommended: fail admission closed when `daemon.mcp.injectIntoAgents` is true and no per-agent scoping exists; the operator disables global injection during Miah runs as the v1 workaround. Rejected: silently proceeding with injection enabled. *Operator decision: confirm the fail-closed-with-workaround approach or choose an alternative.*
- OQ4. **Hard budget preferences (D7 defaults).** Recommended defaults: per-agent max-duration 15m, max 3 takes, max 2 rework cycles, concurrency cap 1, no-progress after 3 polls. *Operator decision: confirm or adjust.*
- OQ5. **Operator notification mechanism (D6-d).** Recommended: CLI-first — driver prints and exits when blocked; operator polls or wraps. No push notifications in v1. *Operator decision: confirm or request a specific notification mechanism for v2.*

These are the only open items; all others are resolved by this plan's decisions and KTDs.

### Sources and Research

- `VISION.md` — canonical product definition.
- `STRATEGY.md` — derived priorities.
- `docs/planning-brief.md` — D1-D9 questions and staged prior-art protocol.
- `docs/plans/2026-08-06-001-feat-miah-runtime-specialist-invocation-plan.md` — approved D1/D2 plan (R1-R21).
- `docs/plans/2026-08-06-002-feat-miah-artifacts-plan.md` — approved D3/D4/D5/D9 plan (R22-R62).
- `docs/decisions/2026-08-06-d1-d2-runtime-and-agent-invocation.md` — D1/D2 decision record (D1-a..g, D2-a..k, adversarial A1-A10).
- `docs/research/agent-orchestration-research.md` — durable execution, grader triage, failure modes, budget discipline.
- `docs/research/paseo-capabilities.md` — Paseo lifecycle, worktree, output-schema, MCP injection capabilities and gaps.
- `docs/research/ecosystem-grounding.md` — CE unified-plan convention, operator's Paseo environment, role→model preferences, re-verification caveat.
- `docs/research/prior-art-paseo-supervisor.md` — staged prior-art digest (cross-checked in both brainstorm sessions; all adoptions recorded in the respective artifacts).
- `docs/ideation/2026-08-06-preflight-shaping.md` — preflight shaping discussion (input to D9).
- Live Paseo verification — 2026-08-06: confirmed daemon v0.3.0-beta.2; `paseo run --help` (no `--max-duration`; `--env` adds but does not scrub; `--output-schema` | `--background` incompatible); `paseo agent update --help` (no MCP toggle); `paseo agent inspect --json` exposes `Capabilities.McpServers: true` with no per-agent disable; operator's `~/.paseo/orchestration-preferences.json` read live for role→model defaults.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Language and packaging: TypeScript/Node.js, npm-installed CLI.** *(session-settled: user-grounded — chosen over Go: Go adds a new toolchain to the operator's npm/Node ecosystem without compensating benefit at one-active-plan scale.)* Governs R83. The `miah` bin entry is the single CLI surface; no daemon, no server, no system-level setup.

- KTD2. **Windows 10 portability: all file ops via Node `fs`; lease via temp-write-then-rename; no POSIX-only primitives load-bearing.** *(session-settled: user-grounded — mandated by the operator's environment: Windows 10 + Git Bash.)* Governs R84, R40. `fs.renameSync` from a temp path to the final path is atomic on NTFS same-volume; this is the lease-acquisition primitive.

- KTD3. **Hash-chained custody: SHA-256 content hash per artifact, hash-chained by harvest order.** Governs R85, R45. Each custody header is `(role, agent_id, attempt, take, harvest_ts, content_hash, prev_hash)`. A broken link is an evidence gap, not silent corruption.

- KTD4. **Substrate probe contract: query daemon capabilities, honestly report absent, fail closed.** Governs R86, R57. The probe runs at admission and checks three things:

  | Check | Probe mechanism | v0.3.0-beta.2 status |
  |---|---|---|
  | Per-agent max-duration | Query whether `paseo run` or `paseo agent create` accepts a per-agent duration/expiry field. Check for `--max-duration`, `--expires-at`, or `--budget` flags. Query daemon API for per-agent expiry config. | **ABSENT** — confirmed via `paseo run --help` (only `--wait-timeout`, which bounds the waiter, not the agent). Admission fails closed. |
  | Post-termination immutability | Dispatch a throwaway agent to a worktree, terminate it, attempt to write to the worktree path, check if the write succeeds or is blocked. Record the result honestly. | **UNKNOWN** — must be tested during Phase 3 (U4). The probe records whatever it finds; admission does not fail on immutability absence (unlike max-duration) but records a caveat in the manifest (per R46). |
  | MCP injection scoping | Check `daemon.mcp.injectIntoAgents` config value; check whether `paseo run` / `paseo agent update` has a per-agent MCP disable flag; inspect a test agent's `Capabilities.McpServers` to confirm tool injection. | **ABSENT** — confirmed via `paseo run --help` and `paseo agent update --help` (no MCP flags). `Capabilities.McpServers: true` on inspect. Admission fails closed if global injection is on (R87). |

  **Re-verification note:** All three checks must be re-verified against the current Paseo version during Phase 3 implementation. The live version is confirmed v0.3.0-beta.2.

- KTD5. **MCP injection scoping: fail-closed admission if global injection is on and no per-agent scoping exists; operator workaround is to disable `daemon.mcp.injectIntoAgents`.** *(session-settled: user-grounded — chosen over silently proceeding: R21/AE8 require that specialists cannot spawn specialists; observation without enforcement does not close the delegation-depth gap.)* Governs R87, R21. The probe checks the daemon config; if injection is globally enabled, the probe checks for per-agent scoping (none exists); if both fail, admission refuses. The operator disables global injection before running Miah.

- KTD6. **Worker env secret-scrubbing: flag as documented residual risk; v1 mitigation is worktree isolation + Miah-controlled evidence.** Governs R88. `paseo run --env <key=value>` adds vars but cannot remove inherited env. The daemon process env (including `OPENAI_API_KEY`) is inherited. v1 accepts this risk because: (a) specialists write only to their worktrees (isolation), (b) Miah harvests evidence (Miah controls what counts), (c) the operator is the sole agent-dispatcher and can audit which env vars exist. Full scrubbing deferred to v2 pending a Paseo `--clean-env` feature.

- KTD7. **Journal snapshot cadence K=50 (configurable).** Governs R71, R41. K=50 balances replay cost (at most 50 events to replay after a crash) and snapshot write frequency. For v1 run sizes (tens of units, hundreds of events), this is adequate. Operator can increase for quieter runs or decrease for faster recovery.

- KTD8. **Lease heartbeat 30s / TTL 60s (configurable).** Governs R72, R39-R40. The heartbeat interval is shorter than the TTL to tolerate one missed heartbeat. A resumer waits TTL + one failed renewal attempt before taking a stale lease. On Windows 10, the heartbeat rewrite uses `fs.writeFileSync` to a temp file + `fs.renameSync` to the lease path (atomic on NTFS).

- KTD9. **Per-agent max-duration default 15m (blocked until Paseo ships).** Governs R73, R4/R5. The value is set in config but is not enforceable until the Paseo daemon ships per-agent duration enforcement. The substrate probe checks for the feature; admission fails closed if absent. The plan sequences all other work (U1-U3, U6-U9) so they can be built and tested without the feature. U4's probe and fail-closed admission are built now (the probe honestly reports 'absent'). U10's full E2E is exercised against an injected fake probe (`test/fixtures/fake-substrate-probe.ts`, reports 'present') so Miah's pipeline is testable now; only validation against a live daemon that actually has the real feature is deferred until it ships.

- KTD10. **Calibration bar: ≥15-case corpus, >14/15 agreement, ≤2 false-blocks, zero false-pass.** Governs R74, R48. Carried from prior-art adoption in the 002 plan. The zero-false-pass floor is mandatory (falsification-floor discipline). v1 ships with empty corpora — no profile has authority until the operator supplies calibration files at `~/.miah/calibration/<provider>-<model>.json`.

- KTD11. **Concurrency cap default 1.** Governs R75, R12. The mechanism (one async session per unit attempt, worktree-isolated, serialized journal) supports N. The default of 1 exercises the mechanism while keeping early runs simple. Operator can raise to allow parallel independent units.

- KTD12. **No-progress: 3 polls, no claim across downtime gap.** Governs R76. Miah can only observe no-progress while it is alive and polling. After a crash, it reconciles from adapter state and cannot attribute downtime to agent hang. This is the honest response to D1/D2 A1's downtime ambiguity. The journal records which polls Miah made and their results; no gap in polling can be attributed to the agent.

- KTD13. **Retry/rework: 3 takes, 2 rework cycles, then escalate.** Governs R77-R79. A take is one builder dispatch attempt. A rework cycle is one rebuild after a failed acceptance. Exhausting either triggers an operator escalation, never auto-termination. An escalation means the run pauses (Attention phase) and the operator decides.

- KTD14. **Run-phase FSM: Admitting → Ready → Implementing → Reviewing → AwaitingApproval → Complete; plus: Attention, Stopping.** Governs R64, R35 (`phase_transition` events). Transitions are journaled as `phase_transition` events. The FSM is derived from prior-art adoption (002 plan R35) and `VISION.md`'s run steps. Phase meanings:

  | Phase | Meaning |
  |---|---|
  | Admitting | Preflight + substrate probe + lease acquisition |
  | Ready | Lease held, units parsed, no work dispatched yet |
  | Implementing | Builder(s) dispatched for eligible units |
  | Reviewing | Tester/reviewer dispatched for a frozen candidate |
  | AwaitingApproval | All units accepted, approval package written, awaiting operator |
  | Attention | Escalation raised, run paused, awaiting operator resolve |
  | Stopping | Operator issued stop, terminating in-flight, releasing lease |
  | Complete | Operator approved, run terminated |

- KTD15. **CLI command surface: preflight, start, run, status, stop, resolve, approve, reject, amend, list.** Governs R63. CLI-first, no push notifications. `start` = admission + lease + first step. `run` = looping driver (`--once` = one step and exit). `list` = list all runs in `~/.miah/runs/`.

- KTD16. **Change orders: miah amend creates new snapshot, re-preflight scoped to affected units, amendment_applied event.** Governs R68. The amendment mechanism preserves immutability: the original snapshot is never touched; a new snapshot version is created. Preflight runs on the new plan; only units whose `creates:`/`inputs:`/`depends-on` changed (plus transitive dependents) are re-dispatched. Already-accepted units are preserved unless an amendment directly affects them.

- KTD17. **Operator notification: driver prints and exits when blocked; no push in v1.** Governs R66, D6-d. The looping driver owns the terminal when running interactively. When it cannot proceed (escalation, approval needed, all work blocked), it exits with escalation details on stdout. The operator polls via `miah status` or wraps `miah run` in a notification script. This is the honest limit of a CLI-first, no-daemon design.

- KTD18. **Test approach: kill drill is the central verification property; unit tests per module; integration test against live Paseo with a test CE plan.** Governs R90. The kill drill is extended across three units: U3 (journal+lease level: kill, resume, byte-identical state), U5 (dispatch level: kill mid-dispatch, reconcile intent-without-created), U10 (full E2E: kill mid-run with a real specialist, resume, continue to completion). The kill drill at U10 is the first-class verification milestone.

### High-Level Technical Design

```
┌─────────────────────────────────────────────────────────────┐
│                   Miah CLI (TypeScript)                      │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ preflight │  │  start   │  │   run    │  │  status  │     │
│  │  (pure)  │  │ (admit)  │  │ (driver) │  │ (read)   │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│       │              │             │              │           │
│       │         ┌────┴────────────┴──┐          │           │
│       │         │  Admission Gate    │          │           │
│       │         │  preflight ∧ probe │          │           │
│       │         └────┬───────────────┘          │           │
│       │              │ lease                    │           │
│       v              v                          │           │
│  ┌──────────────────────────────────────────────┐│           │
│  │              Step Function                   ││           │
│  │  replay → reconcile → dispatch → poll →       ││           │
│  │  harvest → accept → transition → append      ││           │
│  └──┬───────┬───────────┬──────────┬───────────┘│           │
│     │       │           │          │            │           │
│  ┌──┴──┐ ┌─┴───┐ ┌─────┴──┐ ┌─────┴──┐ ┌───────┴──────┐    │
│  │parser│ │run  │ │dispatch│ │evidence│ │  acceptance  │    │
│  │preflt│ │store│ │ adapter│ │custody │ │  grading     │    │
│  └──────┘ │jrnal│ │  paseo │ │gaps    │ │  integration │    │
│           │lease│ └───┬────┘ └────────┘ └──────────────┘    │
│           └─────┘      │                                    │
└────────────────────────┼───────────────────────────────────┘
                         │
                    ┌────┴────┐
                    │  Paseo  │ (daemon v0.3.0-beta.2)
                    │ agents  │
                    │worktrees│
                    └─────────┘

Run store: ~/.miah/runs/<run-id>/
  manifest.json          — run id, snapshot hash, config snapshot, probe verdicts
  plan-snapshot.v1.md    — immutable plan copy (content-hashed)
  units.json             — parsed-once machine view
  journal.jsonl          — append-only, typed events, global seq, one writer
  lease.lock             — holder, heartbeat, TTL
  snapshots/             — periodic state snapshots (every K=50 events)
  evidence/              — harvested evidence keyed by (unit, take, role)
  approval-package.json  — final evidence summary (on completion)
  calibration/           — operator-supplied calibration corpora

Config: ~/.miah/config.json
  Thresholds (D7): K, heartbeat, TTL, max-duration, takes, rework,
                    concurrency, calibration bar, no-progress
```

### Assumptions

1. Paseo v0.3.0-beta.2 is the live daemon during Phase 3. If the daemon upgrades mid-build, CLI contracts are re-verified.
2. The operator disables `daemon.mcp.injectIntoAgents` before running Miah (per OQ3).
3. Node.js 18+ and git are on PATH in Git Bash.
4. The test CE plan (for U10 integration tests) has 3 units: U1 (creates a source file), U2 (depends on U1, creates a consumer), U3 (independent, creates a config file). This exercises dependency gating, parallel dispatch (if cap > 1), and integration.
5. All Paseo CLI commands (`run`, `inspect`, `stop`, `ls`, `wait`, `workspace`, `provider ls`, `provider models`) are available and accept `--json` for machine parsing. Re-verified in U4.

### Sequencing

The implementation units are ordered so that:
1. The core (journal, lease, parser, preflight) is built and tested before any dispatch.
2. The substrate probe and adapter are built, honestly reporting absent for max-duration.
3. A thin dispatch pipeline provides an early E2E before evidence/acceptance thicken it.
4. The full FSM and operator interface are built last.
5. The kill drill is extended across U3 → U5 → U10 and is the first-class verification milestone.

U4's adapter and substrate probe can be built in parallel with U2 (both depend on U1 only); U4's admission gate (which composes preflight ∧ probe) is completed after U2 lands. Units U6 and U7 depend on U5 (need dispatch to have something to harvest and accept). Unit U8 depends on everything before it. U9 depends on U8 (needs the FSM for stop/escalate). U10 depends on all.

---

## Implementation Units

### Unit Index

| U-ID | Title | Key files | depends-on |
|---|---|---|---|
| U1 | CLI skeleton and configuration | `package.json`, `src/index.ts`, `src/config.ts` | — |
| U2 | Plan parser and preflight | `src/parser.ts`, `src/preflight.ts`, `src/snapshot.ts` | U1 |
| U3 | Run store, journal, and lease | `src/run-store.ts`, `src/journal.ts`, `src/lease.ts`, `src/replay.ts` | U1, U2 |
| U4 | Substrate probe and Paseo adapter | `src/adapter/paseo.ts`, `src/substrate-probe.ts`, `src/admission.ts` | U1, U2 |
| U5 | Dispatch pipeline (thin) | `src/dispatch.ts`, `src/packet.ts`, `src/envelope.ts` | U3, U4 |
| U6 | Evidence harvest, custody, and postflight | `src/evidence.ts`, `src/custody.ts`, `src/postflight.ts` | U3, U5 |
| U7 | Acceptance, grading, and gaps | `src/acceptance.ts`, `src/grading.ts`, `src/calibration.ts`, `src/gap.ts` | U3, U6 |
| U8 | Run-phase FSM and step function | `src/step.ts`, `src/fsm.ts`, `src/driver.ts`, `src/escalation.ts` | U2, U3, U4, U5, U6, U7 |
| U9 | Operator interface | `src/commands/status.ts`, `src/commands/stop.ts`, `src/commands/resolve.ts`, `src/commands/approve.ts`, `src/commands/amend.ts` | U3, U8 |
| U10 | End-to-end integration and kill drill | `test/e2e/kill-drill.ts`, `test/e2e/full-run.ts`, `test/fixtures/test-plan.md` | U1-U9 |

### U1. CLI Skeleton and Configuration

- **Goal:** Stand up the TypeScript project, CLI entry point, command dispatch, and config defaults (D7 thresholds).
- **Requirements:** R1 (standalone CLI), R63 (command surface), R80 (configurable thresholds), R83 (TS/Node), R84 (Windows portable), R70 (no network/daemon needed).
- **Files:** `package.json`, `tsconfig.json`, `src/index.ts`, `src/config.ts`, `src/commands/index.ts`, `src/types.ts`, `test/portability/no-posix-only.test.ts`
- **Approach:** Use `commander` for CLI parsing. Define a `Config` interface with all D7 threshold fields and defaults (K=50, heartbeat=30s, TTL=60s, max-duration=15m, max-takes=3, max-rework=2, concurrency=1, no-progress=3, calibration bar). Read `~/.miah/config.json` on startup; create with defaults if absent. Set up `npm test` with `vitest` or `jest`. The `miah` bin entry points to `dist/index.js`.
- **Test Scenarios:**
  - `miah --version` prints the version.
  - `miah --help` lists all commands (preflight, start, run, status, stop, resolve, approve, reject, amend, list).
  - `miah preflight --help` shows the preflight usage.
  - Config file created with defaults on first run if absent.
  - Config overrides from `~/.miah/config.json` are applied.
  - All file paths use `path.join` (cross-platform), not hardcoded separators.
  - A portability scan (`test/portability/no-posix-only.test.ts`) asserts no load-bearing `src/**` code uses `flock`, `mkfifo`, Unix signals (`SIGTERM`/`SIGKILL`), or `kill(` with a PID.
- **Verification:** `npm run build` compiles without errors; `npm test -- --grep "cli"` passes; `miah --help` renders the command surface.

### U2. Plan Parser and Preflight

- **Goal:** Parse CE `ce-unified-plan/v1` documents into `units.json`, compute content-hash snapshots, and implement the pure preflight function.
- **Requirements:** R22-R30, R55-R60 (preflight pure function, structural/referential/verifiability checks, block-only severity, failed admission = new snapshot).
- **Files:** `src/parser.ts`, `src/preflight.ts`, `src/snapshot.ts`, `src/commands/preflight.ts`
- **creates:** `src/parser.ts`, `src/preflight.ts`, `src/snapshot.ts`
- **inputs:** none (standalone module)
- **depends-on:** U1
- **Approach:** Parse YAML frontmatter (`gray-matter` or `yaml` package) → extract `artifact_contract`, `execution`, `title`. Parse `## Implementation Units` H3 headings matching `U<number>. <title>` → extract `Goal`, `Requirements`, `creates:`, `inputs:`, `depends-on`, `Acceptance` block. Build `units.json` keyed by U-ID. Implement preflight as three pure functions: structural (R56(a): U-ID validation, acyclic dependency graph, required fields), referential (R56(b): `inputs:` resolve to workspace paths or transitive-ancestor `creates:`; no cross-unit `creates:` conflicts per R30), verifiability (R56(c): every criterion declares a tier). Return a structured verdict with failures by class and offending unit ID. Snapshot: canonicalize content, write to out-of-tree path, compute SHA-256 hash.
- **Test Scenarios:**
  - Valid plan with 3 units, correct dependencies → preflight returns no failures.
  - Plan with missing `creates:` on U2 → structural failure naming U2.
  - Plan with cyclic `depends-on` (U1→U2→U1) → structural failure naming both.
  - Plan with `inputs: ["src/foo.py"]` on U2 but is not created by a transitive ancestor → referential failure.
  - Plan where U1 and U3 both declare `creates: ["src/shared.ts"]` → referential failure (R30).
  - Plan with acceptance criterion missing `tier:` → verifiability failure.
  - Plan with `execution: knowledge-work` → preflight returns a verdict (admission is a separate gate — but R22 says admission rejects; preflight itself can flag this).
  - Preflight requires no lease, no journal, no run state — it is a pure function callable standalone.
- **Verification:** `npm test -- --grep "preflight"` passes; `npm test -- --grep "parser"` passes; `miah preflight test/fixtures/valid-plan.md` returns a green verdict; `miah preflight test/fixtures/bad-plan.md` returns structured failures.

### U3. Run Store, Journal, and Lease

- **Goal:** Implement the append-only journal, lease.lock, replay-from-snapshot-plus-tail, and periodic state snapshots. The kill drill v1 (journal-level) is first tested here.
- **Requirements:** R15 (single-writer journal serialization — carried from 001), R31-R42 (run store layout, journal, lease, replay, snapshot cadence K=50, kill drill property).
- **Files:** `src/run-store.ts`, `src/journal.ts`, `src/lease.ts`, `src/replay.ts`, `src/manifest.ts`
- **creates:** `src/run-store.ts`, `src/journal.ts`, `src/lease.ts`, `src/replay.ts`, `src/manifest.ts`
- **inputs:** `src/types.ts` (U1), `src/parser.ts` (U2 for units.json), `src/snapshot.ts` (U2)
- **depends-on:** U1, U2
- **Approach:** Journal append: serialize event as JSON line, append via `fs.appendFileSync` (single write per event). A crash mid-write may produce a partial trailing line; replay validates each JSON line and truncates a malformed tail, restoring the last complete event. The atomic temp-write-then-rename primitive (D8-c, KTD2) is used for `lease.lock` only (it replaces the prior file — correct for the lease, but for an append-only journal it would discard prior events, so the journal uses append-not-replace). Event schema: `{seq, type, timestamp, ...payload}` per R35. Lease: `lease.lock` = `{holder_id, acquired_at, last_heartbeat_at, ttl_s}`. Acquire: temp-write-then-rename (fail if target exists with fresh heartbeat). Heartbeat: rewrite heartbeat field every 30s while holding. Release: append `lease_released`, mark `lease.lock` terminal. Replay: read latest `snapshots/state-<seq>.json`, scan journal from seq+1 to tail, reconstruct derived state (per-unit acceptance, in-flight intents, open gaps, phase). Kill drill v1: write 50+ journal events, kill the process, resume, assert byte-identical reconstructed state.
- **Test Scenarios:**
  - Append 100 events; replay reconstructs all statuses correctly.
  - Snapshot at seq 50; replay from snapshot reconstructs state identically to full replay.
  - Lease acquired by holder A; holder B fails to acquire while A heartbeats.
  - Holder A stops heartbeating; after TTL + grace, holder B acquires.
  - **Kill drill v1:** append events, `process.kill()` mid-append, resume → byte-identical state (no lost or duplicate events; temp file cleaned or absorbed).
  - Concurrent append attempt from a non-lease-holder fails.
  - `lease.lock` survives restart; resume reads it for the current holder.
- **Verification:** `npm test -- --grep "journal"` passes; `npm test -- --grep "lease"` passes; kill drill v1 passes (the test that establishes D1's central claim per A2).

### U4. Substrate Probe and Paseo Adapter

- **Goal:** Implement the Paseo lifecycle adapter, the substrate readiness probe (honestly reporting absent for max-duration and MCP scoping), and the fail-closed admission gate.
- **Requirements:** R4-R5 (max-duration — absent, fail closed), R17-R19 (dispatch intent), R21 (MCP scoping), R57 (substrate probe), R86-R87 (probe contracts).
- **Files:** `src/adapter/paseo.ts`, `src/substrate-probe.ts`, `src/admission.ts`
- **creates:** `src/adapter/paseo.ts`, `src/substrate-probe.ts`, `src/admission.ts`
- **inputs:** `src/config.ts` (U1), `src/preflight.ts` (U2)
- **depends-on:** U1, U2
- **Approach:** Adapter implements the 5-capability contract (D2-a): `launch(prompt, opts) → handle`, `status(handle) → lifecycle`, `inspect(handle) → {provider, model, usage, mode, capabilities}`, `stop(handle)`, `cancel(handle)`. Each uses `paseo run --background --json`, `paseo inspect --json`, `paseo agent stop`, etc. via `child_process.execFile`. The substrate probe: (1) check max-duration — query `paseo run --help` for a `--max-duration`/`--expires-at` flag (none found → report `absent`); (2) check MCP injection scoping — read `~/.paseo/config.json` for `daemon.mcp.injectIntoAgents`; if true, check for per-agent scoping flags (none found → report `unscopable`); (3) check post-termination immutability — dispatch a throwaway agent to a temp worktree, terminate it, try to write to the worktree path, record whether the write succeeds (immutability absent) or fails (present). Admission gate: `preflight(plan, workspace) ∧ substrateProbe()`; if preflight fails → return structured failures; if probe reports max-duration absent → refuse; if probe reports MCP unscopable → refuse; both pass → snapshot the admission-time config into the manifest (R80), acquire lease, write plan snapshot, open journal. The `SubstrateProbe` is behind an injectable interface defined in `src/substrate-probe.ts` so U10 can substitute `test/fixtures/fake-substrate-probe.ts` (reports all checks present) — this lets the full pipeline be E2E-tested against the live adapter now, while the real-probe tests (U10 substrate-fail-closed) use the real probe and stay gated.
- **Test Scenarios:**
  - Substrate probe against live daemon reports `max-duration: absent` and `mcp_injection: unscopable` (with `injectIntoAgents: true`).
  - Admission against a valid plan fails closed with a message naming the missing `max-duration` mechanism (R4/R5, R86).
  - Admission fails closed with a message naming the MCP injection issue and the operator workaround (R87).
  - Adapter `launch` creates an agent via `paseo run --background --provider <p> --model <m> --new-workspace worktree --worktree-mode branch-off --title <t> <prompt>` and returns agent id.
  - Adapter `status` queries `paseo inspect --json <id>` and returns lifecycle status.
  - Adapter `stop` calls `paseo agent stop <id>`.
  - Post-termination immutability probe records its finding (present or absent) in the manifest.
- **Verification:** `npm test -- --grep "adapter"` passes; `npm test -- --grep "admission"` passes; `npm test -- --grep "substrate"` passes; admission fails closed against the live daemon (the test that keeps R4/R5 honest).

### U5. Dispatch Pipeline (Thin)

- **Goal:** Implement dispatch_intent → adapter create → poll → terminate → read envelope for one specialist, sequentially (concurrency=1). This provides the first thin E2E. Kill drill v2 (dispatch-level) is tested here.
- **Requirements:** R7-R11 (fresh specialist sessions and dispatch independence — R7-R9, R10, R11 carried from 001), R13 (dispatch primitive), R16 (file envelopes), R17 (dispatch intent before adapter call), R36-R37 (dispatch intent/created/failed/terminated reconciliation).
- **Files:** `src/dispatch.ts`, `src/packet.ts`, `src/envelope.ts`
- **creates:** `src/dispatch.ts`, `src/packet.ts`, `src/envelope.ts`
- **inputs:** `src/journal.ts` (U3), `src/adapter/paseo.ts` (U4), `src/types.ts` (U1)
- **depends-on:** U3, U4
- **Approach:** Compose dispatch packet from the unit's `units.json` entry: objective, plan excerpt, output schema (for result envelope), authority bounds, `creates:`/`inputs:` declaration, result envelope path. Journal `dispatch_intent` (with sender role, unit id, take number, idempotency key, packet hash, deadline, provider/model per D8-i) BEFORE the adapter call. Call adapter `launch`; on success, journal `dispatch_created` (with actual agent id, workspace id, base commit read from git — per A6). On failure, journal `dispatch_failed`. Poll `status(handle)` at step-boundary cadence. When terminal, read the result envelope from the declared path; journal `dispatch_terminated`. Reconciliation on restart: for each `dispatch_intent` without `dispatch_created`/`dispatch_failed`/`dispatch_terminated`, query the adapter by idempotency key; append the matching event. Kill drill v2: kill Miah mid-dispatch (after intent, before created), resume → adapter queried → no handle found → `dispatch_failed` appended → unit routed to rework.
- **Test Scenarios:**
  - Dispatch a planner: packet contains plan snapshot only (no code-writing authority), result envelope written to declared path, Miah reads it after termination.
  - Dispatch intent journaled BEFORE adapter call (assert by seq order).
  - Adapter call fails → `dispatch_failed` journaled with reason.
  - Result envelope absent at harvest → recorded as evidence gap (not auto-failure, not auto-completion per R43).
  - **Kill drill v2:** kill after `dispatch_intent` but before `dispatch_created`; resume → adapter queried → no handle → `dispatch_failed` → rework.
  - Kill after `dispatch_created` but before `dispatch_terminated`; resume → adapter queried → handle found, status checked → if terminal, harvest; if live, resume polling.
  - `dispatch_created` records base commit from git, not from the packet (A6).
- **Verification:** `npm test -- --grep "dispatch"` passes; kill drill v2 passes (the test that validates R37 reconciliation).

### U6. Evidence Harvest, Custody, and Postflight

- **Goal:** Harvest diffs, exit codes, test outputs, and usage deltas; build the hash-chained custody chain; implement the dual-hash T2-T3 continuity check and the postflight assertion.
- **Requirements:** R43-R46 (evidence harvest, custody, T2-T3), R52 (evidence gaps), R53 (test code as evidence), R61 (postflight assertion), R85 (SHA-256 custody).
- **Files:** `src/evidence.ts`, `src/custody.ts`, `src/postflight.ts`
- **creates:** `src/evidence.ts`, `src/custody.ts`, `src/postflight.ts`
- **inputs:** `src/journal.ts` (U3), `src/dispatch.ts` (U5), `src/adapter/paseo.ts` (U4)
- **depends-on:** U3, U5
- **Approach:** After specialist termination: (1) read result envelope (or record absence as gap per R43); (2) `git diff` the specialist's worktree against its base commit → diff file; (3) run the unit's verification contract commands (from the plan) via `child_process.exec` and capture exit code + stdout/stderr → test output; (4) take adapter usage snapshot, compute delta from pre-dispatch snapshot → usage delta; (5) compute SHA-256 content hash of each harvested artifact; (6) build custody header `(role, agent_id, attempt, take, harvest_ts, content_hash, prev_hash)` where `prev_hash` is the last custody header's hash; (7) write evidence to `~/.miah/runs/<run-id>/evidence/<unit>/<take>/<role>/`; (8) dual-hash T2-T3: take workspace hash after harvest, take again just before integration, record both in `custody_continuity_record` (R46); if divergent → `gap_recorded: T2-T3-continuity`. Postflight assertion: verify every `creates:` path exists in the specialist's worktree; missing → `gap_recorded: missing-declared-output` (R61).
- **Test Scenarios:**
  - Harvest includes: diff file, test output file, usage delta JSON, envelope JSON.
  - Custody chain: each header's `prev_hash` equals the previous header's `content_hash`.
  - Custody chain broken (header deleted) → evidence gap recorded.
  - T2-T3: workspace hash same at harvest and integration → no gap. Hash different → `gap_recorded`.
  - Postflight: builder declares `creates: ["src/foo.py"]` but file absent → `gap_recorded: missing-declared-output`.
  - Postflight: all `creates:` present → no gap.
  - Test code (not in `creates:`) harvested as evidence → stored in evidence dir, not integrated.
- **Verification:** `npm test -- --grep "evidence"` passes; `npm test -- --grep "custody"` passes; `npm test -- --grep "postflight"` passes.

### U7. Acceptance, Grading, and Gaps

- **Goal:** Implement the grading ladder, the acceptance predicate (no open gap + pass at or above tier), the gap_recorded/gap_closed pairing, and the integration self-containedness check.
- **Requirements:** R28 (tier declaration), R47-R51 (grading ladder, calibration, acceptance predicate), R54 (integration self-containedness check), R74 (calibration bar numbers).
- **Files:** `src/acceptance.ts`, `src/grading.ts`, `src/calibration.ts`, `src/gap.ts`
- **creates:** `src/acceptance.ts`, `src/grading.ts`, `src/calibration.ts`, `src/gap.ts`
- **inputs:** `src/journal.ts` (U3), `src/evidence.ts` (U6), `src/postflight.ts` (U6)
- **depends-on:** U3, U6
- **Approach:** Grading ladder: `deterministic` (test pass/exit code → pass/fail from test output in evidence), `calibrated-judge` (reviewer verdict from envelope → check calibration file at `~/.miah/calibration/<provider>-<model>.json` → if bar cleared, verdict is authoritative; if not, verdict is an ungraded input → escalate per R48/R20), `human` (operator judgment → `escalation_raised` → `miah resolve`). Acceptance predicate: for each criterion on the unit, find a passing evidence record at or above the declared tier with no open gap referencing that criterion; if all pass → `acceptance_decision: accept`; if any fails → `acceptance_decision: not_accepted` + route to rework or escalation per D7. Gap mechanism: `gap_recorded(unit, criterion, reason)` → criterion cannot be accepted until `gap_closed(unit, criterion, close_reason)`. Integration self-containedness check (R54): checkout canonical worktree at base commit, copy `creates:` paths from specialist worktree, run verification commands; if any fail due to missing undeclared files → `gap_recorded: integration-smuggle`.
- **Test Scenarios:**
  - All criteria pass at deterministic tier → `accept`.
  - One criterion at `calibrated-judge` but reviewer not calibrated → verdict is ungraded → escalate.
  - One criterion at `calibrated-judge` and reviewer calibrated (bar cleared) → verdict authoritative → accept if pass.
  - Open gap on a criterion → `not_accepted` regardless of evidence.
  - `gap_closed` for the criterion → re-evaluate acceptance.
  - Integration check: `creates: ["src/foo.py"]` imports undeclared `src/_helper.py` → verification fails → `gap_recorded: integration-smuggle`.
  - Integration check: all good → pass → `accept`.
- **Verification:** `npm test -- --grep "acceptance"` passes; `npm test -- --grep "gap"` passes; `npm test -- --grep "grading"` passes; `npm test -- --grep "integration"` passes.

### U8. Run-Phase FSM and Step Function

- **Goal:** Implement the supervisor step function that ties dispatch, evidence, acceptance, and phase transitions together; implement the full loop via `miah run` / `--once`.
- **Requirements:** R1-R3 (standalone CLI, reconstructable core, lease+replay+reconcile), R12 (parallel support), R14 (dependency gating), R71-R82 (thresholds as runtime mechanisms), R82 (escalation triggers).
- **Files:** `src/step.ts`, `src/fsm.ts`, `src/driver.ts`, `src/escalation.ts`, `src/commands/start.ts`, `src/commands/run.ts`
- **creates:** `src/step.ts`, `src/fsm.ts`, `src/driver.ts`, `src/escalation.ts`
- **inputs:** `src/run-store.ts` (U3), `src/dispatch.ts` (U5), `src/evidence.ts` (U6), `src/acceptance.ts` (U7), `src/types.ts` (U1)
- **depends-on:** U2, U3, U4, U5, U6, U7
- **Approach:** The step function: (1) reconstruct state from journal + lease.lock; (2) reconcile any non-terminal dispatch intents (R37); (3) evaluate budget predicates (R81: takes remaining, rework remaining, no-progress, cost ceiling); (4) find dispatch-eligible units (R14: all dependencies terminal-accepted); (5) if eligible unit within concurrency cap → dispatch (U5); (6) poll in-flight specialists (U5); (7) on terminal → harvest evidence (U6) → evaluate acceptance (U7); (8) if accepted → integration check → if pass → integrate → mark unit accepted; if not → rework or escalate; (9) transition phase per FSM (KTD14); (10) append phase_transition if phase changed. The driver: `miah run` acquires lease, loops step function until stop condition (no eligible work, all done, stop requested, escalation that blocks all work). `miah run --once` runs one step and exits. FSM transitions: Admitting→Ready (after lease), Ready→Implementing (first dispatch), Implementing→Reviewing (candidate frozen for testing), Reviewing→Implementing (next unit) or→AwaitingApproval (all units done), AwaitingApproval→Complete (operator approve), any→Attention (escalation), any→Stopping (operator stop).
- **Test Scenarios:**
  - One unit through full cycle: admit → ready → implement → review → accept → awaitingApproval.
  - Two units, U2 depends on U1: U1 accepted unlocks U2; U2 dispatches after U1.
  - Two independent units, cap=1: U1 runs, finishes, then U2 runs (sequential).
  - No-progress: 3 polls with no activity change → `escalation_raised: no-progress` → Attention.
  - Max takes exceeded: 3rd take fails → `escalation_raised: repeatedly-fails`.
  - Stop requested: `stop-requested` flag seen at step boundary → terminate in-flight → Stopping → lease released.
  - `miah run --once` advances one step and exits; next `miah run --once` continues.
- **Verification:** `npm test -- --grep "fsm"` passes; `npm test -- --grep "step"` passes; `npm test -- --grep "driver"` passes.

### U9. Operator Interface

- **Goal:** Implement `miah status`, `miah stop`, `miah resolve`, `miah approve`/`reject`, `miah amend`, and `miah list`.
- **Requirements:** R63-R70 (D6 operator interface, change orders, journaled decisions).
- **Files:** `src/commands/status.ts`, `src/commands/stop.ts`, `src/commands/resolve.ts`, `src/commands/approve.ts`, `src/commands/reject.ts`, `src/commands/amend.ts`, `src/commands/list.ts`
- **creates:** `src/commands/status.ts`, `src/commands/stop.ts`, `src/commands/resolve.ts`, `src/commands/approve.ts`, `src/commands/reject.ts`, `src/commands/amend.ts`, `src/commands/list.ts`
- **inputs:** `src/journal.ts` (U3), `src/step.ts` (U8), `src/preflight.ts` (U2), `src/types.ts` (U1)
- **depends-on:** U3, U8
- **Approach:** `status`: read journal, reconstruct phase (latest `phase_transition`), per-unit state, open gaps, pending escalations, usage totals; render to stdout as a structured table or tree. `stop`: append `operator_decision: stop`, set `stop-requested` flag in run store. `resolve`: append `operator_decision: resolve` with decision and note, append `escalation_resolved`, mark affected unit for re-dispatch or acceptance. `approve`: append `operator_decision: approve`, append `run_terminal: complete`, release lease. `reject`: append `operator_decision: reject`, if `--rework` mark units for re-dispatch, if `--end` append `run_terminal: rejected`. `amend`: run preflight on new plan, create new `plan-snapshot.<version>.md`, diff `units.json` against previous, identify affected units + transitive dependents, append `amendment_applied` with new hash and affected list, mark affected units for re-dispatch (pause in-flight ones first). `list`: scan `~/.miah/runs/`, print run id, plan title, phase, last activity.
- **Test Scenarios:**
  - `miah status` on a multi-unit run renders phase, units, gaps, escalations, usage.
  - `miah stop` appends the event; a subsequent `miah run` honors it (terminates in-flight).
  - `miah resolve` appends `escalation_resolved`; next `miah run` sees it and re-dispatches.
  - `miah approve` on an all-accepted run writes `run_terminal: complete`.
  - `miah reject --end` writes `run_terminal: rejected`.
  - `miah reject --rework <unit-ids>` marks the specified units for re-dispatch without terminating the run.
  - `miah amend` with a plan that changes U2's `creates:` → new snapshot, `amendment_applied`, U2 marked for re-dispatch, U1 preserved.
  - `miah amend` on a plan with a dependency chain (U3 depends on U2, U2 changes) → U2 AND transitive-dependent U3 marked for re-dispatch.
  - `miah list` shows all runs in `~/.miah/runs/`.
  - All operator actions journaled with identity, timestamp, decision.
- **Verification:** `npm test -- --grep "status"` passes; `npm test -- --grep "stop"` passes; `npm test -- --grep "resolve"` passes; `npm test -- --grep "approve"` passes; `npm test -- --grep "amend"` passes.

### U10. End-to-End Integration and Kill Drill

- **Goal:** Run a full Miah execution against a test CE plan with real Paseo specialists; pass the kill drill (first-class verification milestone); test the deadline-past-death refusal and the substrate-fail-closed admission.
- **Requirements:** R2-R3 (reconstructable core), R5 (deadline refused), R6 (reconcile), R42 (kill drill property), R57 (substrate fail-closed), R90 (test approach), R63-R70 (operator interface E2E).
- **Files:** `test/e2e/kill-drill.ts`, `test/e2e/full-run.ts`, `test/e2e/deadline-refusal.ts`, `test/e2e/substrate-fail-closed.ts`, `test/fixtures/test-plan.md`, `test/fixtures/test-plan-bad.md`, `test/fixtures/fake-substrate-probe.ts`
- **creates:** `test/e2e/kill-drill.ts`, `test/e2e/full-run.ts`, `test/e2e/deadline-refusal.ts`, `test/e2e/substrate-fail-closed.ts`, `test/fixtures/test-plan.md`, `test/fixtures/fake-substrate-probe.ts`
- **inputs:** all prior units (U1-U9)
- **depends-on:** U1, U2, U3, U4, U5, U6, U7, U8, U9
- **Approach:** Test CE plan (`test/fixtures/test-plan.md`): 3 units — U1 creates `src/hello.ts` (a TypeScript hello module), U2 depends on U1, creates `src/greeter.ts` (imports `hello.ts`), U3 independent, creates `config/app.json`. Using TypeScript (not Python) keeps the test environment single-runtime (Node only — Assumption 3) and avoids an unstated Python dependency. Each unit has acceptance criteria with tiers (`deterministic` for the code, `calibrated-judge` for one criterion to exercise the calibration gate). With empty default corpora (KTD10), the `calibrated-judge` criterion always escalates (no profile clears the bar) — the full-run test exercises the `escalation_raised` → `miah resolve --decision approve` → `escalation_resolved` → `gap_closed` → acceptance path for that criterion. Full run test uses an injected fake substrate probe (`test/fixtures/fake-substrate-probe.ts`, reporting max-duration present, MCP scoped, immutability present) so `miah start` proceeds despite the live daemon lacking the feature: `miah start`, `miah run` to completion, `miah approve` — assert all units accepted, evidence harvested, integration completed, `approval-package.json` written. The fake-probe seam is a test-only injection point on the `SubstrateProbe` interface (defined in U4); it lets U10 exercise the full pipeline against the live adapter without waiting for the max-duration feature to ship. The substrate-fail-closed test uses the real probe (live daemon) — it never uses the fake. Kill drill test uses the same injected fake probe (so `miah start` proceeds): `miah start`, `miah run`, kill mid-dispatch at U2, `miah run --once` → assert byte-identical state, reconcile intent-without-created, refuse work past deadline, continue to completion. Deadline-past-death test: simulate a deadline that passed while Miah was dead, on resume assert the dispatch is terminated and work is refused per R5. Substrate-fail-closed test: run `miah start` against the live daemon (real probe); assert admission fails with the max-duration-absent message.
- **Test Scenarios:**
  - Full run (with fake probe, KTD10 empty corpora): admit → implement (U1) → test → accept → implement (U2) → test (U2's `calibrated-judge` criterion escalates because no calibration exists → operator resolves via `miah resolve --decision approve` → `escalation_resolved` → `gap_closed` → accept) → implement (U3) → test → accept → awaitingApproval → approve → complete.
  - **Kill drill (first-class milestone):** kill at U2 mid-dispatch → resume → byte-identical state → intent reconciled → continue → complete.
  - Deadline-past-death: deadline expired during outage → resume → specialist terminated → work refused → `gap_recorded: deadline-exceeded`.
  - Substrate fail-closed: admission against live daemon → max-duration absent → admission refused → no journal created.
  - `miah status` renders correct phase and unit states at each checkpoint.
  - `miah stop` stops the run cleanly; `miah run` resumes.
  - `miah amend` inserts a change order mid-run and continues.
- **Verification:** `npm test -- --grep "e2e"` passes; **the kill drill passes** (this is the milestone that gives D1's "resume is the only implementation" its teeth); the deadline-past-death refusal test passes; the substrate-fail-closed test passes against the live daemon.

---

## Verification Contract

- **Unit tests:** `npm test` runs all `vitest`/`jest` test suites. Target: every module (parser, preflight, journal, lease, replay, adapter, substrate-probe, admission, dispatch, evidence, custody, postflight, acceptance, grading, gap, fsm, step, driver, commands) has passing tests.
- **Build:** `npm run build` compiles TypeScript with no errors.
- **Lint:** `npm run lint` passes (if configured; use `eslint` with TypeScript plugin).
- **Kill drill:** `npm test -- --grep "kill-drill"` passes. This is the central verification property: kill supervisor mid-run, resume, assert byte-identical state, including intent-without-created and dead-past-deadline cases (R42, R90).
- **Preflight standalone:** `miah preflight test/fixtures/test-plan.md` returns a green verdict; `miah preflight test/fixtures/test-plan-bad.md` returns structured failures.
- **Admission fail-closed:** `npm test -- --grep "admission"` passes; admission against the live Paseo daemon fails with the max-duration-absent message.
- **E2E:** `npm test -- --grep "e2e"` passes: full run, kill drill, deadline refusal, substrate fail-closed, operator interface (status/stop/resolve/approve/amend).
- **Windows 10 + Git Bash:** the CLI and all file operations work on Windows 10 with Git Bash; no POSIX-only primitives are load-bearing (R84) — verified by `test/portability/no-posix-only.test.ts` (U1).

---

## Definition of Done

### Global

- All R1-R90 requirements are implemented and traceable to a unit.
- `npm run build` compiles without errors.
- `npm test` passes including all e2e and kill-drill tests.
- `miah preflight` works standalone on a test CE plan.
- `miah start` fails closed when the Paseo per-agent `max-duration` is absent (against the live daemon).
- The kill drill passes: kill mid-run → resume → byte-identical supervisor-derived state (R42, R90). This is non-negotiable — it is the test that validates D1's central claim.
- The deadline-past-death refusal test passes (R5).
- All D7 thresholds are configurable via `~/.miah/config.json` with documented defaults.
- The CLI is installable via `npm install -g` or `npm link` and runs on Windows 10 + Git Bash.
- The README is updated to reflect Phase 3 completion (this happens after operator approval, per AGENTS.md).
- Abandoned-attempt code (experimental approaches that did not pan out) is removed from the diff.

### Per-unit

- Each unit's Test Scenarios pass.
- Each unit's Verification check passes.
- The unit's `creates:` files exist and are functional.
- The unit's approach is documented in code structure (not separate docs).

### Honest limits (what remains unverifiable until the Paseo feature ships)

- **Per-agent max-duration enforcement (R4/R5):** cannot be tested end-to-end until the Paseo daemon ships the feature. The probe and fail-closed admission are tested; the actual enforcement is not. The full pipeline (U10 full run, U10 kill drill, U10 operator interface E2E) is exercised against an injected fake probe (`test/fixtures/fake-substrate-probe.ts`) that reports 'present' — this tests Miah's end, not Paseo's enforcement. The real-probe tests (substrate-fail-closed, admission gate) run against the live daemon and pass (they assert fail-closed, not success). When the real feature ships, drop the fake probe and re-run U10 against the live daemon.
- **Post-termination workspace immutability (R46):** the probe records whatever the live daemon provides; if absent, the dual-hash T2-T3 check is the mitigation. Re-verify when Paseo ships an immutability guarantee.
- **MCP injection per-agent scoping (R21):** no per-agent scoping exists in v0.3.0-beta.2. The fail-closed admission gate is tested; actual per-agent scoping is deferred until Paseo ships it. Until then, the operator must disable global injection.