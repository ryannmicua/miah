---
lorespec: "0.1"
id: "2026080801"
date: "2026-08-08"
source: "opencode"
topic: "Miah v1 Phase 3 implementation dispatch — orchestration of ten sequential units (U1-U10) plus hardening, simplify, MiniMax-M3 review, and review fixes, from the dispatch persona session to commit 0f44f21"
tags: [miah, implementation, phase3, paseo-orchestrator, kill-drill, disk-first, cross-family, simplify-then-review, compound-engineering, deepseek-v4-flash, glm-5.2, minimax-m3]
classification:
  type: technical
  secondary_type: strategy
  domains: [agent-orchestration, durable-execution, code-review, test-strategy]
  value: high
trails: [miah-implementation, paseo-orchestration, agent-orchestration]
---

## Session Arc

### Started
Phase 2 had landed an approved, deepened implementation plan (`docs/plans/2026-08-06-003-miah-implementation-plan.md`, R1-R90, 10 units U1-U10) plus a derived audit file (`…003….audit.md`, committed `23fcfe2` on the implementation worktree). The operator advanced Miah into the implementation phase and primed a Paseo dispatch session (`ses_02662f8f1ffeakPYZp0mv72n3k`, agent `paseo-orchestrator`, `deepseek-v4-flash` @ max thinking) that owned the loop: read git and the worktree, dispatch a builder per unit, dispatch an independent verifier, accept-on-PASS, escalate on two consecutive FAILs, and recover agent deaths from disk. The first builder (U1) was dispatched ~28 minutes after the orchestrator started (`ses_02649273cffeaP8eMQ4GjedTFi`, 2026-08-07 00:54 UTC).

### Pivots
- **Disk-first invariant validated by a real builder death (costless).** A builder session for U3 died mid-run with `"OpenCode event stream ended before the turn reached a terminal state"`; its work was already committed to `feat/miah-implementation` (`9021851`), tree clean. The orchestrator dispatched the fresh verifier with *"no report exists — verify everything from scratch"* and the unit passed its audit from disk state alone. Only a chat summary was lost. This incident became the `disk-first-paseo-loop` pattern doc — and was applied recursively: the kill drill (U3→U5→U10) institutionalizes the same property inside Miah itself (`docs/solutions/patterns/disk-first-paseo-loop.md`).
- **The honest-substrate gate blocked the first-class milestone.** With fail-closed admission (R4/R5), `miah start` refuses every run because Paseo v0.3.0-beta.2 has no per-agent `max-duration` — so the U10 full-run/kill-drill E2E could not even start. Resolved by the injectable `SubstrateProbe` seam + a test-only fake probe (`test/fixtures/fake-substrate-probe.ts`) reports-present, so the full pipeline is E2E-tested against the live adapter now; the `substrate-fail-closed` test keeps the real probe and asserts the refusal. (`feature-gated-milestone-testability-seam` pattern.)
- **Substrate probe silently minted 19 orphan Paseo projects.** The probe's scratch repos lived in `%TEMP%\miah-probe-repo-<random>` and `paseo run --new-workspace worktree` auto-derived a project per run. Fixed with one stable scratch path + best-effort teardown (`cfc834a`), then formalized into the attach-to-existing-project rule and an adapter-level `dispatch.default_workspace` config field that reads the admission-time config snapshot (`92f644b`). Two pattern docs staged on main.
- **Two real FSM bugs caught in the hardening pass.** The driver at `AwaitingApproval` unconditionally wrote the approval package and returned `complete`; the `AwaitingApproval → Ready` transition (R67 resume after `miah reject --rework`) was not in the static transition table, so rework-marked units were silently completed. Fixed by making the transition validator **state-aware** — `hasReworkMarkedUnits(state)` gates that one transition, and the driver branches on the same predicate at both checkpoint sites (`a6b7949`, `state-aware-fsm-transition-guards` pattern). The lease handed off by `miah start` was not released either, so the run could not proceed — fix `85f73657` releases the admission lease after start.
- **Simplify-then-review-then-fix discipline held end to end.** A behavior-preserving simplify pass (`0f4086b`, +128/-192 on 14 files) ran *before* the review so the reviewer saw a consolidated diff; the review was report-only on a model family not involved in the build (MiniMax-M3) and dispatched three parallel sub-agents on the riskiest surface; findings were severity-calibrated (0 Critical, 0 Major, 5 Minor + 1 CI-process, 4 Nit); a fix agent landed one commit per finding (`f727b0c`–`0f44f21`) and added test coverage for the two gaps the review surfaced. (`simplify-before-third-party-code-review` pattern.)

### Ended
The implementation branch `feat/miah-implementation` sits at `0f44f21` (26 commits, 23,592 insertions across 102 files, 335 unit tests + 4 E2E suites green, kill-drill v1/v2/v3 passing). A pre-PR final review (`docs/reviews/2026-08-08-final-code-review.md`) returned **APPROVE — recommend merging the PR**. A compounding pass (`ses_01e1b4516ffeSxpEMxxR4PNIQc`) staged 7 cross-project pattern docs + `CONCEPTS.md` on main (untracked, pending the orchestrator's commit). The Paseo per-agent `max-duration` feature ask (R4/R5), post-termination immutability (R46), and per-agent MCP scoping (R21) remain open — honestly fail-closed, honestly deferred.

## ARTIFACT

### A1. Implementation branch `feat/miah-implementation` (worktree 29gy4n1g, HEAD `0f44f21`)
- **Layout**: TS/Node.js CLI; `package.json` bin `miah`; `src/` modules + `test/` (unit + e2e) + `test/fixtures/`. 23,592 +/0 net across 102 files (at simplify-pass HEAD `0f4086b`); 9 review-fix commits land after it to `0f44f21`.
- **Commit map (feat → review-fix), 2026-08-07…08** — `git -C miah-implementation log --oneline`:

  | commit | tag | what | session |
  |---|---|---|---|
  | `23fcfe2` | docs | audit criteria for 003 plan (pre-U1) | (planning tail) |
  | `a8f0387` | feat(U1) | CLI skeleton, config defaults, portability test | `…49273cf…` U1 builder |
  | `8deedf7` | feat(U2) | CE plan parser, content-hash snapshots, pure preflight | `…3e3942ff…` U2 builder |
  | `9021851` | feat(U3) | append-only journal, lease.lock heartbeat/TTL, snapshot+tail replay, kill drill v1 | `…2ab617ff…` U3 builder (died; verifier `…f48ee9ff…` from disk) |
  | `51e5161` | feat(U4) | Paseo lifecycle adapter, honest substrate probe, fail-closed admission | `…f0835eff…` U4 builder; audit `…cdf9e9ff…` |
  | `cfc834a` | test(U4) | probe scratch-dir hygiene — stable path + cleanup (fix 19-orphan-project incident) | `…5dc983ff…` |
  | `d578b80` | feat(U5) | dispatch pipeline, packet, envelope, R37 reconciliation, kill drill v2 | `…c80c72ff…` U5 builder; audit `…b7be4ff…` |
  | `9a00366` | feat(U6) | evidence harvest, hash-chained custody, T2-T3 continuity, postflight | `…b450c6ff…` U6 builder; audit `…a79ddc…` |
  | `37f6fbb` | feat(U7) | grading ladder, calibration bar, gap pairing, acceptance, integration check | `…a4b1e1ff…` U7 builder; audit `…94b3f2ff…` |
  | `e895ec9` | feat(U8) | run-phase FSM, supervisor step function, looping driver | `…8fc038ff…` U8 builder; audit `…633da9ff…` |
  | `e2861ed` | feat(U9) | operator interface — status, stop, resolve, approve/reject, amend, list | `…4b2529ff…` U9 builder; audit `…10f199ff…` |
  | `d311fc4` | feat(U10) | E2E suite (kill drill v3, deadline refusal, substrate fail-closed); fix unbounded adapter stop (25s timeout) | `…24cac557…`/`…0b1ee45ff…`/`…1fc696f4ff…`/`…1f94a2d6ff…`/`…1f84f97ff…` builders; `…1f6eb6faf…` final audit |
  | `85f7365` | fix(U4) | release admission lease after start so run proceeds immediately | `…502ecdff…` |
  | `6c448aa` | fix(U1) | move `commander` to dependencies (bin was broken as devDep) | `…502ecdff…` |
  | `a6b7949` | fix(U8) | resume from AwaitingApproval when units marked for rework (state-aware FSM guard) | `ses_01effaed5ffeUd5QX1vg3YQPva` hardening |
  | `92f644b` | fix(U4) | adapter workspace binding + `dispatch.default_workspace` (config-snapshot-aware) | `ses_01effaed5ffeUd5QX1vg3YQPva` |
  | `0f4086b` | refactor(U-all) | final simplify pass before review (+128/-192, behavior-preserving) | `ses_01ee24b0dffeewyK1acKFnkUzC` (+3 general sub-agents) |
  | `f727b0c` | fix(M1) | journal `gap_closed` for implicitly-closed gaps on operator approval | `ses_01e57d6f7ffe7SnkCprtsVrC9P` |
  | `dbdeae2` | test(resolve) | cover `--decision deny` path (review §4 gap 3) | same |
  | `420f23b` | fix(L1) | gate live-daemon E2E on `paseoCliAvailable()` in the other 3 E2E files | same |
  | `4996089` | fix(L2) | give every command its own `errorPrefix` in `runGuarded` | same |
  | `82cd8d0` | test(L3) | real-binary smoke test for built `dist/index.js` bin | same |
  | `89202fa` | test(L4) | no-progress does not carry across a session boundary (R76) | same |
  | `7cfa855` | test(L5) | assert exact `RUN_BLOCKED_EXIT_CODE` (1) on deadline-refusal resume | same |
  | `583dcea` | test(run) | assert `RUN_BLOCKED_EXIT_CODE` (1) for the Attention exit path (review §4 gap 5) | same |
  | `0f44f21` | chore(N1-N4) | drop dead `LIST_ERROR_EXIT_CODE`; document umbrella R82 trigger; route stop-timeout warning via `onWarning`; microtask hop in command-wiring harness | same |
  | `48fc830` | docs(review) | final code review | `ses_01ed1e40effenjSowv2O3OyIom` |

- **Session ledger (implementation phase, ordered by `time_created`):** orchestrator `ses_02662f8f1ffeakPYZp0mv72n3k` (paseo-orchestrator / deepseek-v4-flash max) spans the whole phase. Per-unit pairs run on the implementation worktree — builder on `deepseek-v4-flash`, verifier/auditor on `glm-5.2`, dispatched fresh (independent context; reads disk). Fix agents: `ses_0255dc983ff…` (scratch hygiene), `ses_025502ecdff…` (lease handoff), `ses_01effaed5ff…` (post-completion hardening), `ses_01ee24b0dff…` (simplify + 3 general sub-agents), `ses_01e57d6f7ff…` (review fixes). Third-party review: `ses_01ed1e40eff…` (MiniMax-M3) + 3 sub-agents (2 explore + 1 thinker). Pattern-doc sessions on main: `ses_025d3a368ff…` (disk-first), `ses_0253f9040ff…` (attach-workspace). Compounding: `ses_01e1b4516ff…` (staged the 7 patterns + CONCEPTS.md).
- **Caveat**: the AGENTS.md working-rules file observed in the main checkout still lists **Phase 2 — Planning** as the current phase (the Phase-3 rewrite had not landed in main when this digest was written). The implementation branch is the Phase-3 product; the operator owns the phase-advance rewrite.

### A2. Plan audit file — `…003….audit.md` (committed `23fcfe2`)
- **Contents**: 296 lines. Global exit bar G0.1–G0.11 (every R1-R90 traceable to a unit; `npm run build`; `npm test`; `miah preflight`; `miah start` fail-closed against live daemon; kill drill non-negotiable; deadline-past-death; config thresholds snapshotted at admission; Windows/portability; abandoned-code-free; README only after approval). Per-unit criteria U1.1…U10.12, each citing its plan source (every criterion is *derived*, none invented). Binary verdicts (`PASS`/`FAIL`); freeze rule forbids builders from touching carried-forward R1-R62; sequencing check forbids auditing a unit whose `depends-on` is not yet accepted. Kill-drill milestones block (v1@U3, v2@U5, v3@U10). Honest-limits block: max-duration (R4/R5), immutability (R46), MCP scoping (R21) — never a builder FAIL.
- **Role in the phase**: the verifiers (glm-5.2 testers) ran each unit's G-criteria as the acceptance gate, evidence-only (command output, file existence, code inspection) — never agent prose. This is what made the verification rigorous and what made cross-family contrast a hedge, not authority (`cross-family-verifier-audit-g-criteria` pattern).

### A3. Final code review — `docs/reviews/2026-08-08-final-code-review.md` (committed `48fc830`)
- **Reviewer**: MiniMax-M3 (third model family — never involved in the build). Skill `ce-code-review` loaded, report-only path (no source modified, no commits, no pushes). 3 parallel sub-agents on commands/CLI, crash-safety/durability, and plan-conformance/test-quality; findings cross-verified by direct file reads.
- **Verdict**: `APPROVE — recommend merging the PR`. Test status at HEAD (`0f4086b`): 335 unit tests green; full E2E + kill-drill suites green. Counts: **0 Critical, 0 Major, 5 Minor** (M1 plus L1-L5; L3 is CI-process) and **4 Nit** (N1-N4). Simplify-pass §3 verdict: *SAFE* — every consolidation traced, one small bug fix folded in (amend.ts `previousHash` null handling).
- **Findings → fixes**: M1 (approval package silently drops implicitly-closed gaps → `f727b0c`); L1 (E2E daemon gate → `420f23b`); L2 (errorPrefix → `4996089`); L3 (real-binary smoke test → `82cd8d0`); L4 (no-progress across session boundary → `89202fa`); L5 (exact `RUN_BLOCKED_EXIT_CODE` → `7cfa855`); plus two test-coverage gaps the review surfaced (`test(resolve)` `--decision deny` → `dbdeae2`; `test(run)` Attention exit code → `583dcea`); N1-N4 (dead code, latent R82 trigger, structured `onWarning`, microtask hop in harness → `0f44f21`).
- **Test-suite strengths noted**: real-CLI E2E against the live daemon; kill-drill rigor (deterministic crash-tail injection + independent-artifact byte-identical assertion); calibration-bar boundaries; boundary preflight; lease invariants; correct mock boundaries (no `any`, no wrong-layer mocks).
- **Surfaced gaps (not blocking)**: open-gap-surviving-to-`run_terminal` untested (now closed by M1 fix test); lease-held paths in `resolve`/`approve`/`reject`/`amend` untested (only `stop`/`run` cover it).

### A4. Compound knowledge (7 pattern docs + `CONCEPTS.md`, untracked on main)
- **Staged by** compounding session `ses_01e1b4516ffeSxpEMxxR4PNIQc` after the review fixes. All are cross-project knowledge (the operator synthesizes into other projects). The 7 untracked artifacts are `CONCEPTS.md` plus six new pattern docs:
  1. `docs/solutions/patterns/simplify-before-third-party-code-review.md` — consolidate → independent review → severity-calibrated findings → one commit per finding.
  2. `docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md` — builder on one family, independent verifier on another; convert plan exit bars into a checkable audit file.
  3. `docs/solutions/patterns/kill-drill-byte-identical-resume-verification.md` — stage the drill at every recovery layer; deterministic crash-tail injection; CLI-availability gate for CI.
  4. `docs/solutions/patterns/state-aware-fsm-transition-guards.md` — when a transition's legality depends on derived state, pass the state into the validator; branch on the same predicate at every checkpoint.
  5. `docs/solutions/patterns/explicit-gap-close-before-supersede.md` — journal per-item close events *before* the superseding accept; the derived approval package must be as honest as the raw journal.
  6. `docs/solutions/patterns/adapter-default-workspace-config-field.md` — wire `dispatch.default_workspace` into the adapter; read from the admission-time config snapshot, never the live file.
- **Already-tracked patterns this phase validated** (committed on `main` earlier, cited below as `instance_of`): `disk-first-paseo-loop.md` (the U3 death), `attach-workspace-to-existing-project.md` (the 19-orphan incident), `paseo-per-agent-hard-bound-verification.md` (R4/R5 framing), `feature-gated-milestone-testability-seam.md` (the fake probe).
- **`CONCEPTS.md`** — repo domain vocabulary seeded from this phase: run-phase FSM, AwaitingApproval, approval package, config snapshot, kill drill, G-criteria, cross-family verifier, gap, custody chain, `dispatch.default_workspace`. Each concept links to its pattern doc. Glossary only, not a spec.
- **Caveat**: all 7 are untracked (`git status` on main lists them as `??`); the orchestrator commits after this step.

## DECISION

### D1. Sequential U1→U10 dispatch, builder+verifier per unit, accept-on-PASS before advancing
- **Decision**: The orchestrator dispatched every unit as a fresh builder followed by a fresh independent verifier; a unit advanced only when its G-criteria returned all-PASS and `creates:` existed and `npm test`/`npm run build` cleared.
- **Issue**: how to hold the plan's "execute sequentially, verifying each before advancing" contract with an orch loop that cannot trust builder self-report.
- **Positions**: (a) builder+verifier pair per unit, accept-on-PASS; (b) builder-only with the orchestrator's own re-run; (c) one big E2E at the end.
- **Arguments**: the plan's Product Contract is explicit — a builder's self-report is an input, not a fact; evidence is what Miah harvests, never agent prose. A fresh verifier re-running every gate from disk is the cheapest way to catch a builder's missed bar. The G-criteria audit file (A2) made the verification mechanical.
- **Warrant**: when the loop's own belief in a unit cannot exceed the evidence the verifier re-ran itself, sequencing cannot silently advance a defect.
- **Qualifier**: always
- **Status**: settled

### D2. Cross-family builder-vs-verifier pairing (deepseek-v4-flash builder; glm-5.2 tester/auditor)
- **Decision**: Pin builders on `opencode-go/deepseek-v4-flash`, testers/auditors on `opencode-go/glm-5.2` (different families), per the plan's D8-i role→model defaults; the final pre-PR review went to MiniMax-M3 (a third family).
- **Issue**: which model families run builder vs checker, and whether cross-family contrast is the authority.
- **Positions**: (a) cross-family contrast as a hedge, calibration as authority (the plan's R20/D7-d); (b) same-family faster loop; (c) authority-by-cross-family.
- **Arguments**: a checker trained differently is more likely to surface a defect the builder's family systematically under-weights. But cross-family is defense-in-depth, not authority: R20 is explicit that a checker's verdict has authority only after its profile clears the calibration bar; with empty default corpora (KTD10), every `calibrated-judge` criterion escalates to the operator. The MiniMax-M3 review added a third independent family on the accumulated diff.
- **Warrant**: a model family trained against the same data shares the blind spots of that training; a checker from a different family is a hedge against one class of systematic miss.
- **Qualifier**: usually
- **Status**: settled

### D3. Convert the plan's exit bars into a derived per-unit audit file before the first builder dispatch
- **Decision**: The audit file `…003….audit.md` was committed (`23fcfe2`) *before* U1; every criterion cites its plan source and the verdict is binary (PASS/FAIL, evidence-anchored).
- **Issue**: how to keep the verifier's "audit" from becoming its impressions.
- **Positions**: (a) derive checkable criteria from the plan only; (b) free-form review; (c) let the verifier pick its own criteria.
- **Arguments**: plan bars as a checkable file make the audit mechanical; freeze rule prevents the builder from weakening carried-forward R1-R62; sequencing check prevents auditing a dependent unit before its deps are accepted.
- **Warrant**: an audit not anchored to the plan's own bars is the same judgment call the disk-first loop refuses to let the builder make about itself.
- **Qualifier**: always
- **Status**: settled

### D4. Kill drill staged at three layers as the non-negotiable first-class milestone
- **Decision**: Build and run the crash-recovery drill at U3 (journal/lease), U5 (dispatch intent reconciliation), and U10 (full E2E); each kills the supervisor mid-run and asserts byte-identical derived state on resume.
- **Issue**: how to prove "resume is the only implementation" (D1's central claim) rather than assert it.
- **Positions**: (a) multi-layer staging; (b) one end-to-end kill test with random timing; (c) exit-0-on-resume assertion.
- **Arguments**: a single happy-path kill proves the common case, not the failure mode. The byte-identical assertion must compare independent artifacts (raw journal prefix vs derived-state serialization) so a regression in either the writer or the replayer is caught. Random `process.kill()` does not always land mid-write, so a deterministic crash-tail is injected. Live-daemon E2E must gate on `paseoCliAvailable()` so a CI host without the daemon skips rather than fails.
- **Warrant**: a system that claims crash-recovery but has never been killed mid-run is making an untested claim; the claim is only as strong as the layer at which it is tested.
- **Qualifier**: always
- **Status**: settled

### D5. Fake substrate probe seam: test the full pipeline now, keep the real fail-closed gate honest
- **Decision**: Define the `SubstrateProbe` behind an injectable interface; ship a test-only fake that reports `max-duration`/MCP/immutability "present" so U10's full-run/kill-drill run against the live adapter today; the `substrate-fail-closed` test uses the real probe and asserts the refusal.
- **Issue**: with fail-closed admission (R4/R5), `miah start` refuses every run until Paseo ships per-agent `max-duration` — U10 cannot run at all.
- **Positions**: (a) injectable seam + test-only fake; (b) defer the whole milestone until the feature ships; (c) silently weaken the real gate in tests.
- **Arguments**: (b) silently blocks the end-to-end verification of the pipeline itself for the lifetime of the dependency; (c) would weaken the real gate. The seam separates two conflated claims — "Miah's end works" (testable now, fake) vs "Paseo's enforcement works" (deferred, real probe) — and asserts both.
- **Warrant**: an unverifiable whole milestone is worse than an honest deferral; the seam lets the pipeline be validated against the live adapter without weakening the gate whose whole purpose is to refuse.
- **Qualifier**: in this case
- **Status**: settled (revisit when Paseo ships max-duration — drop the fake, re-run U10 against the live daemon)

### D6. Disk-first commit-per-step contract for every dispatched builder
- **Decision**: Every builder goal prompt mandates an atomic commit after its verification passes; the verifier is dispatched fresh and told to re-run every gate itself; on a builder death, the orchestrator runs a fixed `git status`→compare→resume/redo/escalate protocol from disk.
- **Issue**: how to make agent-session death a non-event (loop lives on disk, never in a session).
- **Positions**: (a) commit-per-step + disk-read verifier + fixed recovery protocol; (b) trust the builder's final message; (c) resume a dead session by continuing it.
- **Arguments**: the U3 builder died mid-run with a stream error and zero final report; its `feat(U3)` commit survived, the verifier passed from disk alone, only a chat summary was lost. Resuming a dead session by replaying its context inherits every unstated assumption; the disk is the only honest state.
- **Warrant**: session liveness must never be coupled to work liveness; a worker's chat output is the only record of its work only if the disk is not the state of record.
- **Qualifier**: always
- **Status**: settled

### D7. Simplify pass *before* the third-party-model review; review report-only; atomic per-finding fix commits
- **Decision**: a behavior-preserving refactor (`0f4086b`) landed before the review; MiniMax-M3 reviewed report-only, severity-calibrated; the fix agent committed one `fix(<id>):` per finding.
- **Issue**: how to spend independent-review attention well and keep the review→fix trail auditable.
- **Positions**: (a) consolidate → independent review → severity findings → one commit per finding; (b) review on the un-simplified diff; (c) reviewer edits source.
- **Arguments**: an un-simplified diff burns review attention on duplicate helpers and dead parameters the build team could remove for free; a reviewer that edits source is no longer independent and the fix trail is lost; a `chore: address feedback` commit hides which findings were addressed. The simplify pass is verified explicitly in the review §3.
- **Warrant**: reviewer attention is a scarce budget and the fix trail is part of the audit story the PR tells; consolidating first and tagging commits per finding respects both.
- **Qualifier**: usually
- **Status**: settled

### D8. The final review goes to a model family not involved in the build
- **Decision**: MiniMax-M3 ran the final pre-PR review (deepseek/glm built it; an unrelated third family reviewed it).
- **Issue**: who reviews your own build before the PR.
- **Positions**: (a) third-family report-only; (b) builder's own family; (c) self-review.
- **Arguments**: the reviewer's value is independence — no investment in the build's choices, no shared blind spot. The same cross-family hedge (D2) at the review gate.
- **Warrant**: independence is the review's product; co-authorship or same-family review dilutes it.
- **Qualifier**: always
- **Status**: settled

### D9. Adapter-level `dispatch.default_workspace` + scratch attach-to-project, after the 19-orphan-project incident
- **Decision**: Add a `dispatch.default_workspace` field to `DispatchConfig` and a `defaultWorkspaceOf()` resolver that reads the admission-time config snapshot; the adapter branches `--workspace <id>` (attach) vs `--new-workspace worktree` (create) explicitly. Probe scratch uses one stable path and attaches to an existing project.
- **Issue**: the substrate probe's `paseo run --new-workspace worktree` from unrooted `%TEMP%` dirs auto-derived 19 orphan Paseo projects before anyone noticed.
- **Positions**: (a) config-driven attach at the adapter layer + stable scratch path; (b) per-dispatch operator CLI flag; (c) auto-derive and ignore the orphans.
- **Arguments**: the CLI-level attach rule is a manual discipline the operator must remember; the config field makes it automatic and pins the run's workspace policy at admission (R80 — read the snapshot, not the live file). Orphans pollute the project list and accumulate silently.
- **Warrant**: project topology is load-bearing for tooling that reasons over the project set; the substrate must not silently mint projects from unrooted run dirs.
- **Qualifier**: in this case
- **Status**: settled

### D10. Resume truncated/large-pipeline agents with execution-only instructions when analysis is the expensive part
- **Decision**: When a U10 builder's work spanned multiple builder/verify sessions (large E2E suiting kill drills), the orchestrator resumed against disk with a fresh agent reading git first — never by replaying the dead session's context. (Echoes the Phase-2 planning session's resume of a truncated deepening agent: keep the durable analysis in the session, narrow the instructions.)
- **Issue**: a dispatched agent's turn died or hit limits mid-work.
- **Positions**: (a) resume-with-narrowed-instructions / fresh-from-disk; (b) re-dispatch fresh and re-do everything; (c) do it myself.
- **Arguments**: the killer drill's path on disk (commits, tests) is durable; re-dispatching loses expensive work the disk already carries.
- **Warrant**: the disk is the state of record; analysis/executions durable on disk make resume cheaper than re-dispatch.
- **Qualifier**: usually
- **Status**: settled

## INSIGHT

### I1. The disk-first invariant held under a real builder death
The U3 builder died with a stream error and zero final report, and the unit passed its independent audit from disk state alone — only a summary was lost. The kill drill institutionalizes the same property one level down: `dispatch_intent` is journaled before the adapter call; result envelopes are read from disk after termination; the supervisor's derived state is reconstructed from the journal on every invocation. The validating incident and the design are the same property. See `docs/solutions/patterns/disk-first-paseo-loop.md`. Confidence: high (verified live).

### I2. A static FSM adjacency table is wrong when a transition's legality depends on derived state
The `AwaitingApproval → Ready` (R67 resume) transition was not in the static table, so a run with rework-marked units silently completed instead of resuming — only caught in the hardening pass. The fix made `isValidTransition(from, to, state?)` state-aware: the predicate `hasReworkMarkedUnits(state)` gates that one transition, and the driver branches on the same predicate at both its checkpoint sites (initial entry and mid-loop). See `docs/solutions/patterns/state-aware-fsm-transition-guards.md`. Confidence: high (bug reproduced, fix landed, tested).

### I3. An accept/override event must journal per-item close events before the superseding event, or the derived view lies
`acceptance_decision: accept` silently dropped every remaining open gap on the unit from derived state; the raw journal was still honest, but the approval package's `gap_close_reasons` list (filtered on `gap_closed`) omitted them. Soft violation of R50 ("a problem cannot disappear silently"). The fix journals a `gap_closed` with `close_reason: "operator-approval"` *per remaining open gap* before the accept. See `docs/solutions/patterns/explicit-gap-close-before-supersede.md`. Confidence: high (review M1, fix `f727b0c`).

### I4. A simplify pass genuinely reduces review noise — and the review must verify it explicitly
`+128/-192` across 14 files: deduplicated helpers (`refFromIntent`, `summaryFromEvent`, `parseCases`), removed dead params/methods, swapped hand-rolled `sleep` for `timers/promises`. The review §3 walked each consolidation with a verdict and an evidence pointer and concluded `SAFE`, catching one incidentally-folded bug fix (amend.ts `previousHash` null handling) rather than letting it slip through as behavior change. See `docs/solutions/patterns/simplify-before-third-party-code-review.md`. Confidence: high.

### I5. The honest-substrate gate is the only honest position until the feature ships — and a fake probe makes the rest testable now
Paseo v0.3.0-beta.2 has no per-agent `max-duration` (only `--wait-timeout`, which bounds the waiter); no per-agent MCP scoping; immutability unverified. The plan's correct framing is fail-closed acceptance, not containment: a dead Miah cannot stop a runaway specialist (bounded *cost* exposure), but R16 + R9/R13 already prevent *correctness* exposure. The injected fake probe is the seam that tests Miah's end now while the real-probe test asserts the refusal. See `docs/solutions/patterns/paseo-per-agent-hard-bound-verification.md` and `feature-gated-milestone-testability-seam.md`. Confidence: high (verified live 2026-08-06; re-verify at U4 during Phase 3).

### I6. Cross-family is a hedge; calibration is the authority
The builder/verifier pairs (deepseek builder, glm verifier) earned catches the build team valued — but R20 is explicit that a checker's verdict has authority only after its profile clears the calibration bar (`≥15-case` corpus, `>14/15` agreement, `≤2` false-blocks, zero false-pass). With empty default corpora (KTD10), every `calibrated-judge` criterion escalates to the operator — by design. The MiniMax-M3 review was a third family on the accumulated diff, still report-only and severity-calibrated. See `docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md`. Confidence: high.

## PATTERN

### P1. Disk-first Paseo loop (commit-per-step, fresh verifier, fixed recovery protocol)
Universal. Work liveness must never be coupled to session liveness. Every dispatched worker: atomic commit after verification; verifier dispatched fresh, re-runs every gate itself; on death, dispatcher runs `git status → compare → resume/redo/escalate` from disk alone. Validated by the U3 builder death (costless). See `docs/solutions/patterns/disk-first-paseo-loop.md`.

### P2. Feature-gated milestone testability seam (injectable probe + test-only fake)
Universal. When a milestone depends on an unshipped substrate feature, put the substrate behind an injectable interface and provide a test-only fake reporting the feature "present". The full pipeline is E2E-tested now; real-probe tests keep asserting fail-closed. Drop the fake when the feature ships. See `docs/solutions/patterns/feature-gated-milestone-testability-seam.md`. **instance_of** D5.

### P3. Cross-family verifier pairing with a plan-audit G-criteria file
Universal. Pair every builder unit with a verifier from a different model family; convert the plan's exit bars into a checkable per-unit audit file (criteria derive from the plan only; binary PASS/FAIL; freeze + sequencing checks). Cross-family is a hedge; calibration is authority. See `docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md`. **instance_of** D2, D3.

### P4. Kill-drill byte-identical resume verification with deterministic crash-tail injection
Universal. Stage the drill at every layer that claims recovery; assert byte-identical derived state by comparing independent artifacts; inject a deterministic crash-truncated tail when random kill timing is unreliable; gate live-daemon E2E on CLI availability so CI without the daemon skips rather than fails. See `docs/solutions/patterns/kill-drill-byte-identical-resume-verification.md`. **instance_of** D4.

### P5. State-aware FSM transition guards
Universal. When a transition's legality depends on derived state (unit statuses, open gaps, in-flight intents), pass the state into the validator; branch on the same predicate at every checkpoint that could take the transition; test the two-command lifecycle (e.g. `miah reject --rework` then `miah run`), not just the single-run path. See `docs/solutions/patterns/state-aware-fsm-transition-guards.md`. **instance_of** I2.

### P6. Explicit gap-close before the superseding acceptance
Universal (any append-only journal whose derived state feeds downstream artifacts). When an accept/override event supersedes open items, journal a per-item close event with a close_reason *before* the superseding event; the derived approval package must be as honest as the raw journal. Test the implicitly-closed path explicitly — the happy path does not cover it. See `docs/solutions/patterns/explicit-gap-close-before-supersede.md`. **instance_of** I3.

### P7. Simplify-then-review-then-fix (atomic per-finding commits, third-family review)
Universal. Behavior-preserving simplify pass *before* the review; reviewer is a model not involved in the build; findings severity-calibrated (Critical/Major/Minor/Nit); fix agent commits one `fix(<id>):` per finding and adds test coverage for the gaps the review surfaces; reviewer verifies the simplify pass explicitly. See `docs/solutions/patterns/simplify-before-third-party-code-review.md`. **instance_of** D7, D8.

### P8. Adapter-level attach-to-project (config-driven, snapshot-read, explicit branch)
Universal for any adapter dispatching Paseo agents. Put the workspace id in the run config (`dispatch.default_workspace`, optional and absent-by-default); read the admission-time config snapshot for a run in progress (R80), never the live file; the adapter branches `--workspace <id>` vs `--new-workspace worktree` explicitly, never by heuristic. See `docs/solutions/patterns/adapter-default-workspace-config-field.md` (+ sibling CLI-level `attach-workspace-to-existing-project.md`). **instance_of** D9.

## SOLUTION

### S1. U3 builder session died mid-run, zero final report
- **Broken**: builder's stream ended before a terminal state; session left in `error`, no chat report.
- **Fixed by**: nothing — the disk-first contract already made it a non-event. The builder's `feat(U3):…` commit (`9021851`) survived with a clean tree; the orchestrator dispatched a fresh glm-5.2 verifier told *"no report exists — verify from scratch"*; the unit passed its audit from disk alone.
- **Why it works**: a worker's chat report is courtesy, not state; work liveness is never coupled to session liveness (P1).
- **Caveats**: requires commit-per-step in every goal prompt; careful verifier prompt that the report absent ≠ the work absent.

### S2. U4 admission lease not released → `miah start` could not let the run proceed
- **Broken**: `51e5161` held the lease after admission, so the subsequent `miah run` could not take it.
- **Fixed by**: `85f73657` releases the admission lease after start.
- **Caveats**: the lease must be released only after the journal-manifest is durable, not before.

### S3. `AwaitingApproval` driver silently completed a run with rework-marked units
- **Broken**: static `PHASE_TRANSITIONS` adjacency table had no `AwaitingApproval → Ready` edge; the driver wrote the approval package and returned `complete`.
- **Fixed by**: `a6b7949` made `isValidTransition(from, to, state?)` state-aware — `hasReworkMarkedUnits(state)` gates *that one* transition; `transitionPhase` passes the snapshot; the driver branches on the same predicate at both checkpoint sites. Tests in `test/driver.test.ts`, `test/fsm.test.ts`, `test/reject.command.test.ts`.
- **Why it works**: a transition whose legality depends on derived state cannot be represented by static adjacency alone; the single predicate is the source of truth for both validator and driver.

### S4. `acceptance_decision: accept` silently dropped open gaps from the approval package (review M1)
- **Broken**: the resolve path closed only the escalation's criterion, then accepted the unit regardless; other open gaps vanished from derived state (the approval-package `gap_close_reasons` list filters on `gap_closed`).
- **Fixed by**: `f727b0c` journals a `gap_closed` with `close_reason: "operator-approval"` *per remaining open gap* before the acceptance; reads derived state (not raw replay) to avoid divergence. Test added in `test/resolve.command.test.ts`.
- **Why it works**: the close events precede the superseding event in the journal, so any derivation reading a prefix ending at (or before) the accept still sees them.

### S5. Three E2E files failed (not skipped) where the `paseo` daemon was absent (review L1)
- **Broken**: only `substrate-fail-closed.test.ts` gated on `paseoCliAvailable()`; `full-run`/`kill-drill`/`deadline-refusal` did not.
- **Fixed by**: `420f23b` wrapped each `it(...)` in `it.runIf(paseoCliAvailable())(...)` in the other three files.
- **Why it works**: the helper is in the harness; unit tests that inject the adapter run everywhere; real-daemon tests gate where they must.

### S6. Substrate probe auto-derived 19 orphan Paseo projects
- **Broken**: probe scratch in `%TEMP%\miah-probe-repo-<random>` + `paseo run --new-workspace worktree` minted one project per run.
- **Fixed by**: `cfc834a` (one stable scratch path + best-effort teardown) then formalized by `92f644b` (adapter `dispatch.default_workspace`, snapshot-read) and the `attach-workspace-to-existing-project` pattern.
- **Caveats**: Paseo v0.3.0-beta.2 has no `paseo project archive`; orphans persist in `~/.paseo/projects/projects.json`.

### S7. `commander` declared a devDependency — the `miah` bin did not work
- **Broken**: U1 listed `commander` under devDependencies; the installed bin could not import it.
- **Fixed by**: `6c448aa` moves `commander` to dependencies.

## OPEN_QUESTION

### OQ1. Has the Paseo per-agent `max-duration` feature shipped upstream?
- **Progress**: feasible (schedule `expiresIn` precedent); unshipped in v0.3.0-beta.2; admission fail-closed; U10 E2E exercises Miah's end via the fake probe.
- **Blocks**: real-daemon enforcement of R4/R5; dropping the fake probe and re-running U10 against the live daemon.

### OQ2. Post-termination workspace immutability (R46) — does Paseo ever guarantee it?
- **Progress**: the probe records whatever the live daemon provides; the dual-hash T2-T3 check is the v1 mitigation.
- **Blocks**: removing the T2-T3 continuity check as a mitigation; relying on a substrate guarantee.

### OQ3. Per-agent MCP injection scoping (R21) — does Paseo ever ship it?
- **Progress**: absent in v0.3.0-beta.2; the operator's workaround is to disable `daemon.mcp.injectIntoAgents` globally during Miah runs; fail-closed admission gate is tested.
- **Blocks**: per-dispatch scoping without the operator workaround.

### OQ4. Should the AGENTS.md on main be advanced to Phase 3 (now) / Phase 4 (after the PR merges)?
- **Progress**: the main checkout's AGENTS.md still reads **Phase 2 — Planning** as the current phase; the implementation branch is the Phase-3 product. The operator owns the rewrite-on-phase-advance (AGENTS.md working rules).
- **Blocks**: surface this drift to the operator rather than silently editing the file.

### OQ5. When is the implementation branch pushed and the PR opened?
- **Progress**: 26 local commits on `feat/miah-implementation`; `git status` shows the branch ahead of origin; the review noted 5 unpushed commits at simplify-pass HEAD (the rest follow).
- **Blocks**: external merge; the operator's standing rule is no auto-push.

## NEXT_STEP

### N1. Commit the 7 untracked compound artifacts + CONCEPTS.md (now — orchestrator commits after this step)
Prompted by: compounding session `ses_01e1b4516ffeSxpEMxxR4PNIQc` staged them; the orchestrator owns the commit, per the dispatch contract.

### N2. Operator decides on push + PR for `feat/miah-implementation` (soon — operator's call)
Prompted by: review APPROVED; the branch carries 26 commits + the review/fix trail; `dist/index.js` is not in the diff and must be built before install/publish.

### N3. When Paseo ships per-agent `max-duration`: drop the fake probe and re-run U10 against the live daemon (someday)
Prompted by: D5/OQ1; honest-limits section of the plan. Same instruction for R46/OQ2 and R21/OQ3.

### N4. Operator surfaces the AGENTS.md phase drift and rewrites it on phase advance (soon)
Prompted by: OQ4; AGENTS.md working rules — rewrite only when the operator approves the phase advance.

### N5. Cover the remaining review-surfaced test gaps if desired (someday)
Prompted by: review §4 gaps 2 (no-progress across session boundary — now locked by `89202fa`/`583dcea`) and 4 (lease-held paths in `resolve`/`approve`/`reject`/`amend` untested).

## Connections
- D1 —[led_to]→ A1 (sequential accept-on-PASS produced the branch)
- D2 —[led_to]→ P3 —[instance_of]→ A3 (cross-family verifier pairs + MiniMax-M3 review)
- D3 —[led_to]→ A2 (audit file derived before first dispatch)
- D4 —[led_to]→ P4 —[instance_of]→ I1 (kill drill at three layers; disk-first incident validates D1's claim)
- D5 —[led_to]→ P2 (fake-probe seam) ; D5 —[depends_on]→ I5 (honest-substrate framing)
- D6 —[led_to]→ P1 —[instance_of]→ S1 (U3 builder death handled by the disk-first contract)
- D7 —[led_to]→ P7 —[instance_of]→ A3 (simplify-then-review-then-fix)
- D8 —[related_to]→ D2 (third-family review is cross-family at the gate)
- D9 —[led_to]→ P8 —[instance_of]→ S6 (orphan-project incident → adapter attach)
- D10 —[related_to]→ P1 (resume-with-narrowed-instructions is disk-first at the loop scale)
- I2 —[led_to]→ P5 —[instance_of]→ S3 (state-aware FSM guard)
- I3 —[led_to]→ P6 —[instance_of]→ S4 (explicit gap-close before supersede)
- I4 —[related_to]→ P7 (review verifies the simplify pass explicitly)
- A2 —[depends_on]→ digest `2026080702`'s A1 (deepened 003 plan) ; A2 —[informed_by]→ digest `2026080701`'s A4
- A3 —[informed_by]→ A1 (review reads the branch diff) ; A3 —[led_to]→ A4 (compounding extracted the patterns the review surfaced)
- A4 —[depends_on]→ I1, I2, I3, I4 (patterns index the phase's insights)
- OQ1 —[depends_on]→ I5 ; OQ4 —[contradicts]→ the main checkout's current AGENTS.md text

## Trail Updates
- **miah-implementation**: Phase 3 implementation complete on `feat/miah-implementation` @ `0f44f21` — 10 units built, paired each builder with a cross-family verifier (cross-family-audit-G-criteria), kill drill passing at v1/v2/v3, MiniMax-M3 pre-PR review APPROVED, all review findings landed as atomic fix commits. Branch unpushed; PR is the operator's call. Honest limits (max-duration R4/R5, immutability R46, MCP scoping R21) remain open and fail-closed.
- **paseo-orchestration**: disk-first commit-per-step validated by a real builder death; adapter-level `dispatch.default_workspace` added after the 19-orphan-project incident; resume-with-narrowed-instructions re-applied at the loop scale; dispatch session (`ses_02662f8f1ffeakPYZp0mv72n3k`) spans the full phase.
- **agent-orchestration**: cross-family builder/verifier + third-family review as the cheapest hedge against shared-training blind spots; an injected probe seam decouples pipeline testing from substrate-feature readiness; simplify-then-review-then-fix is the discipline that keeps independent review honest and fix trails auditable.