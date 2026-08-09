---
mode: explanation
verified: 2026-08-09
---

# Mechanism: Evidence and Acceptance — Harvest, Custody, Grading, Gaps

This is an **explanation** of how Miah turns specialist output into trusted, accepted work: what counts as evidence, how it is chained, how it is graded, and how acceptance becomes a decidable predicate. Exact schemas live in [data-and-security](./data-and-security.md); dispatch is [dispatch-and-isolation](./dispatch-and-isolation.md). The trust discipline behind this layer is in the [cross-family-verifier-audit-g-criteria](../../docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md) and [explicit-gap-close-before-supersede](../../docs/solutions/patterns/explicit-gap-close-before-supersede.md) patterns.

## The problem this mechanism solves

The builder's self-report is an input, not a fact. Miah must not rely on agent prose for its acceptance decisions, or a persuasive-but-wrong specialist could pass a unit on vibes. The design answer has two halves: **evidence is whatever Miah can harvest and verify itself** (diffs, exit codes, test output, usage deltas), and **acceptance is a decidable predicate** — every acceptance criterion needs a passing evidence record at or above its declared tier with no open evidence gap (ADR:D1-e, `PLAN:R47`, `PLAN:R51`).

## Harvest: what Miah counts as evidence

After a specialist terminates, Miah alone harvests the artifacts that carry evidence authority (`src/evidence.ts:342`, `harvestEvidence`):

1. **The result envelope** — the producer's self-report, harvested as an *input*, never as authority (`src/evidence.ts:353-358`).
2. **The git diff** of the worktree against its base commit (`diff.patch`) — `git diff <base>` nets the worktree against the recorded base commit, plus `--name-only` and `status --porcelain` for changed/untracked listings (`src/evidence.ts:156-185`).
3. **Verification-contract command results** (`verification.json`) — the exit code, stdout, and stderr of the commands Miah itself runs (the unit's declared verification contract; `src/evidence.ts:365-383`).
4. **The usage delta** (`usage-delta.json`) — computed between the pre-dispatch and post-termination adapter snapshots; a field is `null` when either side lacks the value, never a fabricated zero (`src/evidence.ts:61-70`, `src/evidence.ts:385-402`).

The harvest record partitions changed files into **deliverables** (declared `creates:` paths that exist) and **evidence-only files** (everything else — test code the plan did not declare is evidence, never a deliverable; `PLAN:R53`, `src/evidence.ts:409-413`). The per-unit postflight assertion runs during harvest: a declared `creates:` path missing from the worktree is `gap_recorded: missing-declared-output` (`src/postflight.ts:39-62`, `src/evidence.ts:503-512`).

## Custody: the hash-chained evidence trail

Every harvested artifact is SHA-256 content-hashed and appended to a single per-run chain (`evidence/custody-chain.json` — a runtime path under `~/.miah/runs/<run-id>/evidence/`, not a repo file). Each custody header carries `(role, agent_id, attempt, take, harvest_ts, content_hash, prev_hash)` where `prev_hash` is the previous header's `content_hash` (`src/custody.ts:26-35`, `src/custody.ts:67-73`). Appends are ordered by harvest time.

The chain makes tampering detectable after the fact: `verifyCustodyChain` checks that every header's `prev_hash` equals the preceding header's `content_hash` and the first header's `prev_hash` is null; a broken or missing link is `gap_recorded: custody-chain` for the affected unit (`src/custody.ts:95-110`, `src/evidence.ts:522-541`). The chain is persisted via temp-write-then-rename so a torn write can never destroy the prior chain (`src/custody.ts:140-155`).

Two things the chain is *not*: it is not a journal (it holds no run state, only artifact hashes and identity), and it is not a substitute for the immutability check below.

## The T2-T3 continuity check

Paseo v0.3.0-beta.2 gives no post-termination workspace immutability guarantee, so Miah provides its own: a workspace hash taken right after harvest (hash 1) is paired with one taken just before integration (hash 2). A divergence means the workspace was not frozen post-termination — the harvest is `gap_recorded: t2-t3-continuity` and cannot support acceptance (`src/evidence.ts:571-592`, `src/evidence.ts:192-221` for `workspaceHash`). Absence of substrate immutability is recorded as a manifest caveat, not a refusal (`src/substrate-probe.ts:139-149`; `PLAN:R46`).

## Grading: the D5 ladder

Each acceptance criterion declares a tier from the D5 ladder (`deterministic | calibrated-judge | human`, `PLAN:R28`; `src/types.ts:159-161`). Grading maps evidence to a verdict per tier (`src/grading.ts:113`, `gradeCriterion`):

- **`deterministic`** — a mechanical pass/fail from the verification-contract exit codes (`src/grading.ts:134-142`). "All passed" → pass; any failure → fail (rework); no evidence → ungraded.
- **`calibrated-judge`** — a reviewer verdict is authoritative **only when the reviewer's profile clears the calibration bar**; otherwise the verdict is an ungraded input that escalates (`src/grading.ts:149-167`). Reviewer provenance (provider/model) must be recorded, and the calibration lookup for that (provider, model, tier) triple must return `bar_cleared: true`.
- **`human`** — operator judgment is the only authority; the criterion stays ungraded (and escalates) until `miah resolve` supplies a decision (`src/grading.ts:173-181`).

An `ungraded` verdict carries no acceptance authority: the calibrated-judge tier escalates when no profile clears the bar, and the human tier escalates until the operator decides (`PLAN:R48`). Authority ranking: `deterministic` (3) > `calibrated-judge` (2) > `human` (1); `tierMeetsOrExceeds` compares ranks (`src/grading.ts:24-44`), so a higher-tier evidence record satisfies a criterion declared at a lower-or-equal tier.

## Calibration: what grants a checker authority

A checker profile clears the bar only with a corpus ≥ 15 pre-labeled cases, agreement **strictly greater** than 14/15, false-blocks ≤ 2, and — mandatory, non-relaxable — **zero false-passes** (`src/calibration.ts:108-150`, `computeCalibrationMetrics`). v1 ships with default-empty corpora: no profile has authority until the operator supplies calibration files at `~/.miah/calibration/<provider>-<model>.json` (`src/calibration.ts:90-101`). A missing, unreadable, or schema-invalid file is treated as absent — fail-closed, never authority (`src/calibration.ts:157-231`).

This is the answer to "isn't cross-family contrast enough?": no — a checker that is different is not a checker that is *right*. Calibration is the authority; cross-family contrast is defense-in-depth (`PLAN:R20`, [cross-family pattern](../../docs/solutions/patterns/cross-family-verifier-audit-g-criteria.md)).

## The acceptance predicate

`evaluateAcceptance` (`src/acceptance.ts:80-140`) decides one unit. For every acceptance criterion on the unit:

- An **open gap referencing that criterion** → fail (route: rework).
- Otherwise, a passing evidence record **at or above the declared tier** with no open gap → pass.
- Otherwise → fail, routed to rework (fixable) or escalation (ungraded calibrated/human judgment required).

Open **evidence-integrity gaps** on the unit that do not reference a declared criterion (missing declared output, T2-T3 divergence, broken custody, integration smuggle) are collected as `blockingGaps` and block acceptance regardless of the criteria results (`src/acceptance.ts:85-87`).

The verdict is journaled as `acceptance_decision` (`accept` or `not_accepted`) with per-criterion results (`src/acceptance.ts:155-184`). A `not_accepted` verdict routed to escalation also appends `escalation_raised` (`src/acceptance.ts:171-182`).

## The integration self-containedness check

Acceptance is not the end — a unit that passes *in its own worktree* might depend on files the plan never declared. The R54 check copies the accepted `creates:` deliverables into a checkout of the canonical worktree at the run base commit and re-runs the unit's verification contract there (`src/acceptance.ts:261-293`). Any verification failure in the integrated checkout is `gap_recorded: integration-smuggle` ("undeclared dependency") and the predicate re-evaluates with that gap visible, blocking acceptance (`src/acceptance.ts:315-332`).

On success, the accepted `creates:` paths are committed in the canonical worktree (`src/acceptance.ts:212-240`, `commitIntegrationFiles`) — this is the R89 integration that makes dependency chains work: a dependent unit's worktree is branched off canonical HEAD, so it sees the integrated deliverable. The commit is idempotent on resume ("nothing to commit" is swallowed; `src/acceptance.ts:234-239`).

## Gaps: how problems stay visible

Gaps are first-class typed journal events: `gap_recorded(unit, criterion, reason)` opens one; `gap_closed(unit, criterion, close_reason)` closes it. The pairing is enforced — a close with no matching open gap is refused, and the close reason must be one of the R50 set (`rework-take`, `re-verification-success`, `operator-approval`, `deadline-still-in-effect-cleared`) (`src/gap.ts:19-24`, `src/gap.ts:53-76`).

The "problems cannot disappear silently" rule (VISION, R50) has a sharp edge at the operator gate: when the operator accepts a unit via `miah resolve --decision approve`, the acceptance supersedes the unit's open gaps in derived state. To keep the derived view as honest as the raw journal, Miah journals a `gap_closed` per remaining open gap *before* the acceptance event (`src/commands/resolve.ts:112-119`), so the approval package's `gap_close_reasons` list reflects how each gap was actually closed. This is the M1 fix, documented in the [explicit-gap-close-before-supersede pattern](../../docs/solutions/patterns/explicit-gap-close-before-supersede.md).

## The terminated-specialist pipeline

Everything above is composed by `harvestAndAccept` (`src/step.ts:611-717`), the pipeline that runs when a builder terminates: harvest evidence → verify custody → take the T2-T3 record → grade each criterion from the harvested verification outcome → evaluate acceptance (predicate + integration check) → route: accept, bounded rework (`rework_started`), or escalation (budget exhausted or ungraded). Bounded rework is capped by `max_takes` (3) and `max_rework_cycles` (2); exhaustion raises `repeatedly-fails` and pauses the run in Attention (`src/step.ts:705-712`, `src/step.ts:346-361`).

## The approval package at the gate

When every unit is accepted, the driver writes `approval-package.json` (`src/driver.ts:258-312`): per-unit evidence pointers + acceptance records, `gap_close_reasons` derived from `gap_closed` events, cumulative usage totals from harvested usage deltas, the plan hash, and run duration. The package is what the operator sees at the `AwaitingApproval` gate — the durable summary of *what was accepted and how it was proven*.
