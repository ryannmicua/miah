---
mode: explanation
verified: 2026-08-09
---

# Miah v1 — Design Decisions

This document distills the settled design decisions of Miah v1: what was decided, why, where the decision is enforced in code, and its status (including supersessions). It is an **explanation** — it answers *why the system is shaped this way*. Exact values and interfaces live in the reference docs ([state-machine-reference](./state-machine-reference.md), [data-and-security](./data-and-security.md)); the problem history behind the decisions lives in the [patterns store](../solutions/patterns/) and is linked, not re-narrated.

> **Authority.** The decisions below derive from the approved implementation plan (`../plans/2026-08-06-003-miah-implementation-plan.md`, cited as `PLAN:Dx` / `PLAN:Rnn` / `PLAN:KTDn`) and the D1/D2 decision record (`../decisions/2026-08-06-d1-d2-runtime-and-agent-invocation.md`, cited as `ADR:Dx`). When a decision and the code disagree, the code is the current design; disagreements are recorded in the [README conflict log](./README.md#conflict-log), never silently resolved. Citation convention: `PLAN:R23` = requirement 23, `PLAN:KTD14` = key technical decision 14, `PLAN:D6-a` = operator-interface decision.

---

## 1. Runtime shape: a stateless interpreter over a durable run directory

**Decision.** Miah is a standalone CLI that behaves as a stateless interpreter over a durable run directory — immutable plan snapshot + append-only journal + single-writer lease — rather than a daemon, an agent, or a library. The supervisor loop lives on disk, not in a process; resume is the only implementation.

**Rationale.** A session-bound agent loses its state when the session dies; a resident daemon loses its state when memory is lost; both still need a journal to be correct. Making the run the durable entity and the loop a re-derivable function removes the hosting question. (ADR:D1, adopted from prior art.) Liveness and resumability are separated: a run nobody is driving is paused, not lost (ADR:D1-c, `PLAN:VISION` run step). The direct consequence is that any process may pick the run up — a terminal, a cron job, a Paseo schedule, or another agent (ADR:D1-b).

**Enforced at.** `src/driver.ts:318` (`runDriver`: acquire → replay → reconcile → loop → release); `src/replay.ts:471` (`replayFromSnapshot`); `src/lease.ts:172` (single-writer acquire).

**Status.** Current. The one-path property is enforced by the kill drill test, not just by design (ADR:A2): `test/kill-drill-v1.test.ts`, `test/e2e/kill-drill.test.ts`. See [kill-drill-byte-identical-resume-verification pattern](../solutions/patterns/kill-drill-byte-identical-resume-verification.md).

## 2. Single-writer lease via temp-write-then-rename

**Decision.** A per-run `lease.lock` file (`{holder_id, acquired_at, last_heartbeat_at, ttl_s}`) is the authority for the current writer. Acquisition, heartbeat, and release use temp-write-then-rename (`fs.renameSync`), atomic on NTFS same-volume; no POSIX-only primitives are load-bearing (PLAN:D8-c, PLAN:R84).

**Rationale.** Exactly one process may append to the journal at a time; a stale-takeover must never steal a fresh heartbeat. Heartbeat interval (30s) is shorter than TTL (60s) to tolerate one missed heartbeat; a resumer takes a stale lease only after TTL **plus** one failed renewal attempt (PLAN:D7-b, PLAN:R72, PLAN:KTD8).

**Enforced at.** `src/lease.ts:172` (`acquire`), `src/lease.ts:229` (`renew`), `src/lease.ts:242` (`maybeHeartbeat`), `src/lease.ts:279` (`assertActiveHolder`, the journal's write gate). Heartbeat and TTL defaults: `src/types.ts:164-187` (`DEFAULT_CONFIG`).

**Status.** Current. Supersedes the earlier plan draft's "fail if target exists" acquire semantics: the final design adds idempotent already-held acquisition and same-holder refresh (ADR OP-1 scope).

## 3. Append-only JSONL journal with global seq and periodic snapshots

**Decision.** The journal is a single append-only JSONL file (`journal.jsonl`), one typed event per line, each with a global monotonic `seq`; every K=50 events Miah writes a derived-state snapshot (`snapshots/state-<seq>.json`). Snapshots store **derived state only** — statuses, ids, hashes, references — never raw contexts, tool inputs, or specialist prose (PLAN:D7-a, PLAN:R71, PLAN:R41).

**Rationale.** Append-not-replace: replacing the file would discard prior events (the atomic temp-write-then-rename primitive is reserved for files that legitimately replace, like the lease). A crash mid-append may leave a partial trailing line; replay validates each line and truncates a malformed tail, restoring the last complete event. Mid-file corruption throws rather than being silently dropped.

**Enforced at.** `src/journal.ts:203` (`append`), `src/journal.ts:62` (`parseJournalText`), `src/journal.ts:113` (`repairJournalTail`), `src/replay.ts:353` (`writeStateSnapshot`), `src/run-store.ts:181` (`RunStore.append`: snapshot every K-th event).

**Status.** Current. Snapshot cadence is operator-configurable (`config.journal.snapshot_cadence`).

## 4. Derived state reconstructed by replay from snapshot + tail

**Decision.** Miah never holds a single in-memory source of truth. Every decision reads `DerivedState` reconstructed from the latest snapshot plus the journal tail after it (PLAN:R42); a torn/unreadable snapshot degrades to a full journal replay. Replay validates global monotonic seq — a duplicate or out-of-order seq means corruption and throws.

**Rationale.** Replaying a bounded tail after a snapshot keeps recovery O(tail) while preserving byte-identical state to a full replay. A snapshot is authoritative only as a replay seed, never as a truth the journal can contradict (PLAN:R42; kill-drill property PLAN:R90).

**Enforced at.** `src/replay.ts:471` (`replayFromSnapshot`), `src/replay.ts:328` (`deriveState`), `src/replay.ts:90` (`applyEvent`), `src/replay.ts:424` (`readStateSnapshot`).

**Status.** Current.

## 5. Plan immutability and parse-once machine view

**Decision.** At admission Miah canonicalizes the plan (CRLF→LF, trailing-blank normalization), copies it verbatim into the out-of-tree run store as `plan-snapshot.v1.md`, and computes a SHA-256 content hash (PLAN:R23, PLAN:R85). The parsed machine view is written once to `units.json` and is the only view the journal, dispatcher, and acceptance predicate read (parse-once-and-cache, PLAN:R24). Amendments write new snapshot versions; the original is never mutated (PLAN:D6-f, PLAN:R68).

**Rationale.** The immutable snapshot makes "changes to scope, requirements, or acceptance criteria require operator approval" (VISION) structurally enforceable: specialists receive excerpts of the snapshot, never license to change it. Parse-once avoids divergence between parsers mid-run.

**Enforced at.** `src/snapshot.ts:36` (`canonicalizePlan`), `src/snapshot.ts:53` (`writeSnapshot`), `src/parser.ts:199` (`parsePlan`), `src/run-store.ts:95` (`readUnitsJson`), `src/commands/amend.ts:204-212` (new version + rewrite of `units.json`).

**Status.** Current.

## 6. Preflight is pure; admission is `preflight ∧ substrate probe`, fail-closed

**Decision.** Preflight is a pure function over the plan artifact plus the workspace's current path set — no I/O, no lease, no run state (PLAN:R55). It runs three check classes: structural, referential, verifiability (PLAN:R56). Severity is block-only (PLAN:R58). Admission composes the preflight verdict with a live substrate probe and refuses the run when either fails (PLAN:R57, PLAN:R86-R87).

**Rationale.** The D1 stateless shape fits a pure preflight exactly; admission is the first place a run touches disk. Fail-closed refusal is the honest response to unshipped substrate features: if per-agent `max-duration` is absent or MCP injection is unscopable, admission refuses and names the missing mechanism and the operator workaround.

**Enforced at.** `src/preflight.ts:373` (`preflightPlan`), `src/admission.ts:107` (`admitPlan`), `src/admission.ts:70` (`maxDurationAbsentMessage`), `src/admission.ts:80` (`mcpUnscopableMessage`).

**Status.** Current. The preflight execution-mode rejection (`execution: knowledge-work`) is in `src/admission.ts:115-120`, per `PLAN:R22`.

## 7. Substrate probe behind an injectable seam, with a test-only fake

**Decision.** The substrate probe is an interface (`SubstrateProbe`) with a real implementation (`PaseoSubstrateProbe`) and a test-only fake (`test/fixtures/fake-substrate-probe.ts`) that reports all checks present. The fake is an injection point so the full pipeline is E2E-testable now; real-probe tests always use the real implementation (PLAN:KTD9).

**Rationale.** The U10 milestone (full-run E2E, kill drill) was blocked by fail-closed admission until Paseo ships per-agent `max-duration`. The seam separates "Miah's end works" (testable now, fake) from "Paseo's enforcement works" (deferred, real probe). The fake never weakens the real gate.

**Enforced at.** `src/substrate-probe.ts:82` (interface), `src/substrate-probe.ts:113` (`PaseoSubstrateProbe`), `src/admission.ts:57` (injected probe in `AdmitOptions`), `test/fixtures/fake-substrate-probe.ts`.

**Status.** Current. See [feature-gated-milestone-testability-seam pattern](../solutions/patterns/feature-gated-milestone-testability-seam.md).

## 8. Five-capability Paseo adapter contract; no plugin system

**Decision.** Dispatch goes through one adapter (`PaseoCliAdapter`) implementing the five-capability contract: launch, status, inspect, stop, cancel (ADR:D2-a). The contract is documented; no plugin framework is built because one implementation does not earn an abstraction layer.

**Rationale.** A raw provider subprocess dies with its parent; Paseo's durable handles survive supervisor death, which is what detachable dispatch (ADR:D1-d) requires. The adapter bounds the stop exec at 25s so the driver can always reach the Stopping transition and release the lease even when the daemon is slow to acknowledge.

**Enforced at.** `src/adapter/paseo.ts:107` (interface), `src/adapter/paseo.ts:479` (class), `src/adapter/paseo.ts:158` (`DEFAULT_STOP_EXEC_TIMEOUT_MS`), `src/adapter/paseo.ts:608` (`execStopWithTimeout`).

**Status.** Current. Paseo remains a hard dependency of dispatch (ADR:OP-2 as implemented — one adapter, contract documented).

## 9. Dispatch intent journaled before the adapter call; identity observed, not self-reported

**Decision.** Every dispatch journals `dispatch_intent` (with idempotency key, packet hash, deadline, provider/model) **before** the adapter call leaves. On success it journals `dispatch_created` recording the *actual* agent id, workspace id, and the base commit read from git — never from the packet (ADR:A6, PLAN:R17, PLAN:R36).

**Rationale.** The intent-before-launch ordering makes a crash between intent and created recoverable: on resume the intent is reconciled against the adapter. Recording observed identity (not the packet's intent) applies Miah's own evidence discipline to itself — the record is partly evidence, not wholly self-report.

**Enforced at.** `src/dispatch.ts:341-351` (intent before `adapter.launch`), `src/dispatch.ts:363-369` (`dispatch_created` with `baseCommit` from `gitReader`).

**Status.** Current.

## 10. Results are file-based result envelopes, read after termination

**Decision.** Specialists write a single JSON result envelope at a packet-declared path relative to their worktree root; Miah reads it only after the adapter reports terminal (ADR:D2-b, PLAN:R43). An absent envelope at harvest is an evidence gap, not an auto-failure and not an auto-completion.

**Rationale.** A streamed or returned result is lost if the supervisor is dead when it arrives; a file on disk survives. The envelope is the producer's self-report — an input, never authority; its self-reported file hashes are navigation hints only (PLAN:R45).

**Enforced at.** `src/envelope.ts:115` (`readEnvelope`), `src/envelope.ts:142` (`defaultEnvelopePath`), `src/dispatch.ts:403-433` (`harvestEnvelope` — gap on absence).

**Status.** Current.

## 11. Replay-then-reconcile, never replay alone

**Decision.** On resume, Miah first reconstructs state from the journal, then reconciles every non-terminal dispatch intent against the adapter (PLAN:R37-R38). A `dispatch_intent` without `dispatch_created`/`dispatch_failed`/`dispatch_terminated` is queried via an injectable handle-resolver seam; a missing handle appends `dispatch_failed` (unit routed to rework) and a found handle appends `dispatch_created` with the discovered identity.

**Rationale.** The journal records what Miah authorized, not what the repository looks like; the workspace is the thing the run changes (ADR:D1-f). Reconciliation is how Miah learns whether a specialist it launched before its own death is alive, dead, or terminal.

**Enforced at.** `src/dispatch.ts:643` (`reconcileIntents`), `src/dispatch.ts:509` (`reconcileOne`), `src/step.ts:388-412` (reconcile once per session, then harvest if the attempt already terminated).

**Status.** Current. The default resolver honestly reports "no handle" — the U4 adapter has no idempotency-key lookup — routing intent-without-created to rework (PLAN:R37; kill-drill v2 case).

## 12. Deadlines refuse work produced past the recorded deadline

**Decision.** Every dispatch carries an ISO deadline (default now + `dispatch.max_duration`, 15m). Work past the recorded deadline is refused: the specialist is terminated immediately and the dispatch closes with a deadline-exceeded gap (PLAN:R5, PLAN:R73).

**Rationale.** Paseo v0.3.0-beta.2 has no daemon-enforced per-agent max-duration, so a dead Miah cannot stop a runaway specialist. The honest posture is fail-closed **acceptance**: refuse anything past the deadline, terminate on resume. This bounds cost exposure; correctness exposure is already bounded by worktree isolation (specialists never write canonical state). See [paseo-per-agent-hard-bound-verification pattern](../solutions/patterns/paseo-per-agent-hard-bound-verification.md).

**Enforced at.** `src/dispatch.ts:442` (`refusePastDeadline`), `src/dispatch.ts:477-489` (poll-path refusal), `src/step.ts:508-516`.

**Status.** Current. `max_duration` is not enforceable until Paseo ships the feature; admission fails closed on its absence (PLAN:R73, PLAN:R86).

## 13. Per-unit worktree isolation; `dispatch.default_workspace` attach

**Decision.** Each dispatch creates a fresh worktree via `paseo run --new-workspace worktree --worktree-mode branch-off`, unless the run config sets `dispatch.default_workspace`, in which case dispatches attach to that existing workspace via `--workspace <id>` and do not pass the new-workspace flags (ADR:D2-h, PLAN:R36; `dispatch.default_workspace` from [adapter-default-workspace-config-field pattern](../solutions/patterns/adapter-default-workspace-config-field.md)).

**Rationale.** Worktree isolation makes specialists' writes confined to their own tree (the primary defense against a runaway specialist); attaching to an existing workspace avoids the auto-derived-project trap for scratch/rootless cwds (see [attach-workspace-to-existing-project pattern](../solutions/patterns/attach-workspace-to-existing-project.md)). The workspace policy is read from the run's config snapshot (R80), not the live config file, so a run in progress keeps the policy it was admitted with.

**Enforced at.** `src/adapter/paseo.ts:505-510` (launch arg branch), `src/dispatch.ts:232-240` (`defaultWorkspaceOf`), `src/dispatch.ts:354-362`.

**Status.** Current.

## 14. Role→model defaults from D8-i, operator-overridable

**Decision.** Each specialist role maps to a Paseo role plus a provider/model pair. Operator's `~/.paseo/orchestration-preferences.json` wins when present; otherwise the D8-i defaults apply (PLAN:D8-i). Tester and verifier share the `audit` Paseo role and the same provider/model — cross-family contrast is per unit (builder ≠ checker), not per role (ADR:D2-c.5, ADR:C1/C4).

**Rationale.** Cross-family contrast is a hedge against shared-training blind spots, not an authority: a checker's verdict earns authority only by clearing the calibration bar (ADR:D2-d, PLAN:R20). The defaults pin the builder to one family and checkers to another.

**Enforced at.** `src/types.ts:312-320` (`D8I_ROLE_DEFAULTS`), `src/dispatch.ts:262` (`resolveRoleDefaults`).

**Status.** Current. Cross-family is defense-in-depth; calibration is the authority (see §19).

## 15. Evidence harvesting and hash-chained custody

**Decision.** After a specialist terminates, Miah alone harvests the artifacts that carry evidence authority: the git diff against the base commit, the exit code/stdout/stderr of the verification-contract commands Miah itself runs, the usage delta between pre/post adapter snapshots, and the result envelope (as an input). Every harvested artifact is SHA-256 content-hashed and appended to a per-run hash-chained custody sequence (`evidence/custody-chain.json`), each header carrying `(role, agent_id, attempt, take, harvest_ts, content_hash, prev_hash)` (PLAN:R45, PLAN:R85, PLAN:D8-g). A broken or missing link is an evidence gap that cannot support acceptance.

**Rationale.** The builder's self-report is an input, not a fact; Miah controls what counts as evidence and can verify it itself. The chain makes deletion or reordering detectable after the fact.

**Enforced at.** `src/evidence.ts:342` (`harvestEvidence`), `src/custody.ts:67` (`appendToChain`), `src/custody.ts:95` (`verifyChain`), `src/evidence.ts:522` (`verifyCustodyChain`). The chain file (`evidence/custody-chain.json`) is a runtime path under `~/.miah/runs/<run-id>/evidence/`, not a repo file.

**Status.** Current.

## 16. T2–T3 continuity check for post-termination workspace stability

**Decision.** Miah takes a workspace hash right after harvest (hash 1) and again just before integration (hash 2). A divergence is journaled as `gap_recorded: t2-t3-continuity` and blocks acceptance (PLAN:R46).

**Rationale.** Paseo v0.3.0-beta.2 provides no post-termination workspace immutability guarantee; the dual-hash check is Miah's own mitigation. Absence of immutability is recorded as a manifest caveat, not a refusal (PLAN:KTD4).

**Enforced at.** `src/evidence.ts:571` (`takeContinuityRecord`), `src/evidence.ts:192` (`workspaceHash`), `src/substrate-probe.ts:139-149` (caveat text).

**Status.** Current.

## 17. D5 grading ladder: deterministic > calibrated-judge > human

**Decision.** Every acceptance criterion declares a tier from the D5 ladder (PLAN:R28). Grading maps evidence to a verdict per tier: `deterministic` (mechanical — verification-contract exit codes), `calibrated-judge` (a verifier verdict that is authoritative only when the verifier's profile clears the calibration bar), `human` (operator judgment, the natural fallback). An `ungraded` verdict carries no acceptance authority and escalates (PLAN:R47-R48).

**Rationale.** This is how Miah is "mechanical, not judgmental" (ADR:D1-e): residual judgment is delegated to a dispatched verifier and returns as an evidence artifact, or to the operator via escalation. Calibration, not model family, grants verdict authority (ADR:D2-d).

**Enforced at.** `src/grading.ts:113` (`gradeCriterion`), `src/grading.ts:39` (`tierMeetsOrExceeds`), `src/grading.ts:134` (`gradeDeterministic`), `src/grading.ts:149` (`gradeCalibratedJudge`), `src/grading.ts:173` (`gradeHuman`).

**Status.** Current.

## 18. Calibration bar for checker verdict authority

**Decision.** A checker profile clears the bar only with: corpus ≥ 15 pre-labeled cases, agreement > 14/15, false-blocks ≤ 2, and — mandatory, non-relaxable — zero false-passes (PLAN:D7-d, PLAN:R74, PLAN:KTD10). v1 ships with default-empty corpora: no profile has verdict authority until the operator supplies calibration files at `~/.miah/calibration/<provider>-<model>.json`. A missing, unreadable, or malformed profile is treated as absent — fail-closed, never authority.

**Rationale.** The zero-false-pass floor is falsification-floor discipline; the agreement/false-block thresholds are operator-configurable. A checker that cannot clear the bar escalates its criteria to operator judgment — an escalation, not a deadlock (ADR:D2-d).

**Enforced at.** `src/calibration.ts:108` (`computeCalibrationMetrics`), `src/calibration.ts:234` (`loadCalibrationProfile`), `src/calibration.ts:247` (`resolveCalibrationMetrics`). Defaults in `src/types.ts:181-186`.

**Status.** Current.

## 19. Acceptance predicate: pass at or above declared tier, no open gap

**Decision.** A unit is accepted only when, for **every** acceptance criterion, there is a passing evidence record at or above the criterion's declared tier **and** no open evidence gap references that criterion (PLAN:R47, PLAN:R51). Open evidence-integrity gaps on the unit (missing declared output, T2-T3 divergence, broken custody, integration smuggle) also block acceptance. A failed verdict routes to bounded rework or an operator escalation per D7 (PLAN:R52, PLAN:R82).

**Rationale.** This is the decidable predicate that replaces judgment (ADR:D1-e): "every criterion has a qualifying pass with no open gap" is checkable, not vibes.

**Enforced at.** `src/acceptance.ts:80` (`evaluateAcceptance`), `src/acceptance.ts:155` (`applyAcceptance`), `src/step.ts:674-716` (composed transition with integration check).

**Status.** Current.

## 20. Integration self-containedness check (R54) and R89 integration

**Decision.** When a unit is accepted, its `creates:` deliverables are copied into a checkout of the canonical worktree at the run base commit and the unit's verification-contract commands run there. Any verification failure in the integrated checkout is a `gap_recorded: integration-smuggle` (an undeclared dependency from the builder's worktree) and blocks acceptance (PLAN:R54). On success, the accepted `creates:` paths are committed in the canonical worktree so dependent units' worktrees (branched off canonical HEAD) see the integrated deliverable (PLAN:R89). Test code not declared in `creates:` is harvested as evidence but never integrated (PLAN:R53).

**Rationale.** Without the check, a unit could "pass" in its own worktree only because it depends on files the plan never declared — a self-containedness lie. The R89 commit is what makes dependency chains work across units.

**Enforced at.** `src/acceptance.ts:261` (`runIntegrationCheck`), `src/acceptance.ts:212` (`commitIntegrationFiles`), `src/postflight.ts:70` (`deliverableFiles`), `src/evidence.ts:409-413` (evidence-only partitioning).

**Status.** Current.

## 21. Gaps are first-class typed events with enforced close pairing

**Decision.** `gap_recorded(unit, criterion, reason)` opens a gap; `gap_closed(unit, criterion, close_reason)` closes it. The pairing is enforced: a close with no matching open gap is refused, and the close reason must be one of the R50 set (`rework-take`, `re-verification-success`, `operator-approval`, `deadline-still-in-effect-cleared`) (PLAN:R50, PLAN:R52).

**Rationale.** "A problem cannot disappear silently" (VISION): every problem is recorded, addressed, or escalated. The enforced close reasons force the mechanism of closure to be named.

**Enforced at.** `src/gap.ts:53` (`closeGap`), `src/gap.ts:19` (`GAP_CLOSE_REASONS`), `src/replay.ts:221-250` (open-gap pairing in derived state).

**Status.** Current. Supersession: the M1 fix journals a `gap_closed` per implicitly-closed gap *before* `acceptance_decision: accept` (PLAN:R50 via operator approval); see [explicit-gap-close-before-supersede pattern](../solutions/patterns/explicit-gap-close-before-supersede.md).

## 22. Escalation mechanism with an R82 trigger set

**Decision.** Escalations are first-class journal events (`escalation_raised` / `escalation_resolved`) with a stable id (`esc-<seq>`); the trigger set covers every operator-attention condition the plan mandates (max takes, max rework, no-progress, scope/requirement change, security risk, destructive side effect, high-severity failure, missing access/judgment, cost ceiling, calibration-bar failure, blocked-no-eligible-work) (PLAN:R82, PLAN:R66). An unresolved escalation pauses the run in Attention; the operator resolves via `miah resolve`.

**Rationale.** Every budget/authority limit routes to an operator escalation, never auto-termination and never silent skip (PLAN:D7-j). The driver prints escalation details and exits; the run is paused, not lost.

**Enforced at.** `src/escalation.ts:23` (`ESCALATION_TRIGGERS`), `src/escalation.ts:89` (`raiseEscalation`), `src/escalation.ts:124` (`unresolvedEscalations`), `src/step.ts:561-562` (Attention transition on escalation).

**Status.** Current.

## 23. Run-phase FSM with state-aware transition guards

**Decision.** The run-phase FSM has eight phases (Admitting, Ready, Implementing, Reviewing, AwaitingApproval, Attention, Stopping, Complete) (PLAN:KTD14). Transition legality is **state-aware**, not just static adjacency: `AwaitingApproval → Ready` (the R67 rework-resume) is legal only when the reconstructed state shows rework-marked units. See [state-machine](./state-machine.md) for the walkthrough and [state-machine-reference](./state-machine-reference.md) for the exact table.

**Rationale.** The operator can mark units for re-dispatch (`miah reject --rework`, `miah amend`) while the run sits at the approval gate; a static table cannot see that, so the run would silently complete instead of resuming. The validator takes the derived state as a parameter and shares the predicate with the driver's checkpoints (PLAN:R67).

**Enforced at.** `src/fsm.ts:92` (`isValidTransition`), `src/fsm.ts:76` (`hasReworkMarkedUnits`), `src/driver.ts:358-372` and `src/driver.ts:401-409` (both gate checkpoints branch on the same predicate). See [state-aware-fsm-transition-guards pattern](../solutions/patterns/state-aware-fsm-transition-guards.md).

**Status.** Current.

## 24. Bounded autonomy thresholds, operator-configurable

**Decision.** The D7 thresholds are config fields with documented defaults: snapshot cadence 50, heartbeat 30s, TTL 60s, max-duration 15m, no-progress 3 polls, concurrency cap 1, max takes 3, max rework cycles 2, calibration bar, optional cost ceiling (PLAN:D7, PLAN:R71-R82). The config file is read on every invocation; a run in progress uses the config read at **admission time**, snapshotted into the manifest (PLAN:R80).

**Rationale.** Bounded autonomy: budget predicates are evaluated synchronously before each dispatch and each poll cycle, and a failing predicate routes to escalation or stop, never silent skip (PLAN:D7-j, PLAN:R81). The admission-time snapshot keeps a run's limits stable even if the operator edits config mid-run.

**Enforced at.** `src/types.ts:164-187` (`DEFAULT_CONFIG`), `src/config.ts:68` (`loadConfig`), `src/commands/run.ts:79` (uses `manifest.config_snapshot`), `src/step.ts:414-452` (budget predicates), `src/step.ts:330` (`budgetExhausted`).

**Status.** Current.

## 25. Operator interface: ten commands, journaled decisions

**Decision.** The CLI surface is exactly ten commands: `preflight`, `start`, `run`, `status`, `stop`, `resolve`, `approve`, `reject`, `amend`, `list` (PLAN:D6-a, PLAN:R63). Every operator action (stop/resolve/approve/reject/amend) is journaled as an `operator_decision` event with operator identity, timestamp, decision, and optional note (PLAN:R69). Exit code is 0 on success and 1 on every failure/blocked path; `miah run` returns 0 only for complete/advanced/stopped (PLAN:KTD15).

**Rationale.** CLI-first, no push notifications, no GUI/TUI (PLAN:D6-d). Journaled decisions survive restart: an operator action recorded while no driver is alive is honored on the next `miah run` (PLAN:R65).

**Enforced at.** `src/commands/index.ts:17` (`COMMANDS`), `src/commands/index.ts:37` (`runGuarded`), `src/commands/stop.ts:82`, `src/commands/approve.ts:62`, `src/commands/reject.ts:86`, `src/commands/resolve.ts:82`, `src/commands/amend.ts:216`. Exit-code mapping in [state-machine-reference](./state-machine-reference.md#exit-codes).

**Status.** Current.

## 26. Technology and delivery

**Decision.** TypeScript/Node.js, npm package with a `miah` bin entry, commander for CLI parsing, `yaml` for frontmatter, vitest for tests (PLAN:D8-a/D8-b, PLAN:R83). No background service or daemon; Windows 10 + Git Bash portability with no POSIX-only primitives (PLAN:R84). Build is `tsc`; the package ships `dist/`.

**Rationale.** Matches the operator's npm/Node ecosystem; JSON is native (journal is JSONL); Windows portability is mandated by the environment (PLAN:KTD2). Go/Rust/Python were considered and rejected (PLAN:D8-a alternatives).

**Enforced at.** `package.json:1-38` (deps, scripts, bin), `tsconfig.json:1-18`.

**Status.** Current. The test approach centers on the kill drill (PLAN:R90): `test/kill-drill-v1.test.ts`, `test/kill-drill-v2.test.ts`, `test/e2e/kill-drill.test.ts`.

---

## Supersessions and drift notes

- **ADR D1/D2 record** is superseded-by the implementation plan (PLAN:32-34): its requirements R1-R21 are carried forward verbatim. The doc set treats the plan as the design authority and the ADR as the historical record.
- **M1 gap-close fix** (plan §21): the resolve-approve path journals close events before acceptance — a supersession of the plan's R50 reading that was a defect fix, recorded in the [explicit-gap-close pattern](../solutions/patterns/explicit-gap-close-before-supersede.md).
- **R67 rework-resume** (plan §23): a supersession of the static transition table by the state-aware guard — recorded in the [state-aware-fsm pattern](../solutions/patterns/state-aware-fsm-transition-guards.md).
- **`dispatch.default_workspace`** (plan §13): an addition to the dispatch config after the plan — recorded in the [adapter-default-workspace-config-field pattern](../solutions/patterns/adapter-default-workspace-config-field.md).
