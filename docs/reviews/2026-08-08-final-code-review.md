# Miah v1 — Final Code Review (pre-PR)

- **Branch:** `feat/miah-implementation` @ `0f4086b` (16 commits, 23,592 +/0 net, 102 files)
- **Base:** `main` (`git diff main...HEAD`)
- **Test status at HEAD:** 335 unit tests green; full E2E + kill-drill suites green
- **Plan audit status:** `docs/plans/2026-08-06-003-miah-implementation-plan.audit.md` PASS (pre-audit, by glm-5.2 testers)
- **Reviewer model:** MiniMax-M3 (this review)
- **Review date:** 2026-08-08

---

## 1. Verdict

**APPROVE — recommend merging the PR.**

The implementation is mature, well-tested, and demonstrates consistent discipline on the hard surfaces (journal atomicity, lease takeover, driver loop, dispatch pipeline, evidence custody, acceptance predicate, integration self-containedness). No critical or major defects were found. The simplify pass at `0f4086b` is genuinely behavior-preserving on every consolidation; one of its changes is a small *bug fix* (amend.ts `previousHash` null handling) rather than a behavior change.

The findings below are minor or nit-level: one transparency issue in the approval package (M1), three test/observability gaps (L1, L4, L5), one consistency nit (errorPrefix), and a handful of dead-code / dead-trigger nits. None block merge. M1 should be acknowledged in the PR description; the rest can be follow-ups.

---

## 2. Findings

| # | Severity | Location | What | Why it matters | Suggested fix |
|---|---|---|---|---|---|
| M1 | **minor** | `src/replay.ts:205-206` | `acceptance_decision: accept` silently drops every open gap on the unit from derived state without a paired `gap_closed` event. | The journal still carries the original `gap_recorded` events (so the audit trail is honest), but the approval package's `gap_close_reasons` list (`src/driver.ts:277-284` filters on `gap_closed` type) will omit any gap the accept decision implicitly closed. Reachable today only via `miah resolve --decision approve` when the unit has more than one open gap (the resolve path closes only the escalation's criterion, `src/commands/resolve.ts:100-106`, then accepts the unit regardless). Soft violation of R50 "a problem cannot disappear silently". No test covers an open gap surviving to `run_terminal`. | Either (a) journal a `gap_closed` per open gap with close_reason `operator-approval` from the accept path, or (b) document the override as explicit and add a test that an operator-accepted unit's other open gaps are reflected in the approval package. |
| L1 | **minor** | `test/e2e/full-run.test.ts`, `test/e2e/kill-drill.test.ts`, `test/e2e/deadline-refusal.test.ts` | These three E2E files do **not** gate on `paseoCliAvailable()`. Only `substrate-fail-closed.test.ts:65,106` does. The harness ships the gate helper at `test/e2e/helpers/e2e-harness.ts:177-184`. | Without the gate, the three E2E tests will *fail* (not skip) on a CI host where the `paseo` CLI is not on PATH or the daemon is unavailable. The unit-test suite passes regardless (the unit tests inject the adapter), so this is purely a CI resilience gap. | Wrap each `it(...)` in `it.runIf(paseoCliAvailable())(...)` (or a `describe` block) in those three files. |
| L2 | **minor** | `src/commands/index.ts:43, 60, 78, 87` | The new `runGuarded` errorPrefix is inconsistent: only `start` and `run` pass an explicit `"miah start"` / `"miah run"` prefix; the other eight commands fall back to the default `"miah"`. | On a *thrown* exception, the user sees `miah: <msg>` even for `miah approve` / `miah reject` / etc. — visually inconsistent with the command's own stderr messages (which use the `miah <cmd>:` form). The command bodies' own `console.error` calls are untouched. No test asserts a specific prefix, so nothing breaks today. | Either default the prefix to a per-command name (e.g. a small `nameFor` map) or accept the inconsistency and document that thrown exceptions use the bare `miah:` prefix. |
| L3 | **minor** | `test/e2e/*.test.ts` (all) | E2E tests exercise the command modules in-process (`runStart`, `runCommand`, ...); the only separate process is the vite-node kill-drill child. The `dist/index.js` bin path is covered only indirectly via `createProgram().parse` in `test/cli.test.ts` / `test/command-wiring.test.ts`. | A real-binary smoke test (`node dist/index.js start …` against a stub substrate) would catch packaging regressions (missing files, bin path, shebang, dependency hoisting) that no in-process test can. | Add a small E2E that builds the bin and runs one no-op command. Not blocking. |
| L4 | **minor** | `test/driver.test.ts`, `test/step.test.ts` (gap) | No-progress escalation (`src/step.ts:520-540`) is tested within a single session but **not** across a session boundary. R76 claims the per-session `StepRuntime` (created once per driver) means no-progress cannot carry across a downtime gap. | The claim rests on structural reasoning, not on a test. A test that runs 2 unchanged polls, kills the driver, restarts it, and asserts the unit does NOT escalate on the next poll would lock the R76 invariant. | Add a step test with an injected `now()` and two `runStep` calls across a fresh runtime. |
| L5 | **minor** | `test/e2e/deadline-refusal.test.ts:107` | The resume assertion is `expect(resumeCode).not.toBe(0)` where the exact expectation is exit code 1 (`RUN_BLOCKED_EXIT_CODE`, `src/commands/run.ts:18`). | Directionally correct but imprecise; a future change to the Attention exit code would silently weaken the test. | `expect(resumeCode).toBe(1)`. |
| N1 | **nit** | `src/commands/list.ts:15` | `LIST_ERROR_EXIT_CODE` is declared (= 1) but `runList` never returns it (it always returns 0 — no error path by design). | Dead code, but harmless. The constant is no longer imported by `commands/index.ts`. | Delete the constant, or leave as documentation that list cannot fail. |
| N2 | **nit** | `src/escalation.ts:29-31` | `max-takes-exceeded` and `max-rework-cycles-exceeded` are declared as R82 triggers but never raised. The code always raises the umbrella `repeatedly-fails` (`src/step.ts:346-361`). | Declarative-only — the R82 set is "must include" and the umbrella trigger covers the same semantics. Not a violation; just a slight redundancy that may invite drift. | Either raise the specific triggers from `escalateRepeatedlyFails` (and remove the umbrella), or remove the unused entries. |
| N3 | **nit** | `src/adapter/paseo.ts:615` | The stop-exec timeout path uses `console.error` to warn the operator that the daemon didn't acknowledge within 25s. | The rest of the adapter uses typed errors and structured returns. One `console.error` from a library module is inconsistent and may surface in tool output the operator didn't expect. | Route through a callback or return a structured warning, or accept the pragma and add a comment. |
| N4 | **nit** | `test/command-wiring.test.ts:76-80` | The harness reads `process.exitCode` synchronously right after `program.parse()`. For async commands (start/run/resolve/approve/reject/amend), `runGuarded` sets it in a microtask, so a sync read sees a stale `0`. | Pre-existing harness design (the file predates the simplify pass); currently safe because the file only exercises the three sync commands. A trap for future tests. | Read `process.exitCode` after a microtask hop or use `await Promise.resolve()`. |

### Counts

- **Critical:** 0
- **Major:** 0
- **Minor:** 5 (M1, L1, L2, L3, L4, L5 — six items but L3 is CI-process, not a code defect)
- **Nit:** 4 (N1, N2, N3, N4)

No standards violations: zero `any` types in `src/`, no uncommented silent catches, mocks at the right boundaries.

---

## 3. Simplify-pass verification (commit `0f4086b`, 14 files, +128/-192)

Every consolidation was read and traced. Findings are per the user's specific risk list:

| Consolidation | Verdict | Evidence |
|---|---|---|
| `src/commands/index.ts` `runGuarded` routing (exit-code + error-prefix) | **safe** | Verified at every per-command test file (`test/*command*.test.ts`): all error-path assertions hardcode exit code `1`. Verified the constants: `ADMISSION_FAILURE_EXIT_CODE`, `RUN_BLOCKED_EXIT_CODE`, `STATUS_ERROR_EXIT_CODE`, `STOP_ERROR_EXIT_CODE`, `RESOLVE_ERROR_EXIT_CODE`, `APPROVE_ERROR_EXIT_CODE`, `REJECT_ERROR_EXIT_CODE`, `AMEND_ERROR_EXIT_CODE` are *all* literally `1` (`src/commands/start.ts:17`, `run.ts:18`, `status.ts:34`, `stop.ts:25`, `resolve.ts:27`, `approve.ts:19`, `reject.ts:19`, `amend.ts:38`). The old `process.exitCode = ADMISSION_FAILURE_EXIT_CODE` in the catch and the new `process.exitCode = 1` set the same value. The one e2e helper that consumes the exit code (`test/e2e/helpers/drive-run-child.ts:88-93`) loops on `code !== 0 && code !== 1` and treats `1` as Attention. No operator script or test distinguishes per-command codes. The *only* observable delta is the `errorPrefix` for two of ten commands (see L2 above). |
| `src/run-store.ts` `readUnitsJson` dedup | **safe** | The new exported function returns `null` on missing/unreadable. `RunStore.readUnits` (private) re-wraps to `undefined` (`src/run-store.ts:154-156`) to preserve the old type; the dispatch path already used `null`. All callers check `!== null` (or truthy). No call site broke. |
| `src/snapshot.ts` `filename` parameter | **safe** | Default value `DEFAULT_SNAPSHOT_FILENAME` ("plan-snapshot.v1.md") preserves the pre-simplify behavior for the v1 admission path (`src/admission.ts:154` uses the default). The amendment path (`src/commands/amend.ts:206`) passes an explicit `plan-snapshot.v<N>.md`. All `test/snapshot.test.ts` cases use the 2-arg form. |
| `src/journal.ts` deleted `Journal.repair()` | **safe** | `grep -r "journal.repair\|\.repair("` across `src/` and `test/` returns zero hits. The `Journal` class's only caller was `Journal.initialize()` which still calls the module-level `repairJournalTail`. The replay path (`replayFromSnapshot`) also still calls it directly. The method was a thin public wrapper that nothing needed. |
| `src/driver.ts` `writeApprovalPackage` config param removed | **safe** | `git show 0f4086b^:src/driver.ts` shows `config: Config` was the second parameter but **never referenced** in the function body (`src/driver.ts:258-312`). The function reads `store.layout`, `state`, `units`, `manifest`, evidence dir, and journal events. Pure dead-parameter removal. All three call sites (lines 370, 407, 422) updated in the same commit. |
| `src/dispatch.ts` `refFromIntent` extraction, `readUnits` dedup, `sleep` from `timers/promises` | **safe** | `refFromIntent` is the exact same shape as the inlined `ref` (`{unit_id, role, take, idempotency_key, deadline}`); two call sites updated. The `sleep` swap from hand-rolled to `timers/promises` is identical in behavior — the Node built-in does `setTimeout(..., ms) → Promise<void>`. The `refusePastDeadline` destructure change drops `gapEvent` which was destructured-but-never-used in that one branch. |
| `src/commands/amend.ts` `writeSnapshot` + `previousHash` null handling | **safe — small bug fix** | The new code: `const previousSnapshotHash = previous !== null ? currentSnapshotHash(previous.filePath) : null; const previousHash = previousSnapshotHash !== null ? previousSnapshotHash : manifest.plan_hash;`. The old code cast `currentSnapshotHash(previous.filePath) as string` and used it without a null check, which on a corrupted/incomplete prior snapshot could feed `null` into the journal. The new flow is correct. |
| `src/evidence.ts` `verification.all_passed` cached, loop var rename `[key, ref] -> [, ref]` | **safe** | The local `verification` variable was already computed from the same `results.every((r) => r.exit_code === 0)`. Renaming the unused loop var is a cosmetic. |
| `src/fsm.ts` `INITIAL_PHASE_SENTINEL` re-exported from `replay.ts` | **safe** | Both sides name the same string `"not-started"`. `replay.ts:18` is the canonical source. |
| `src/preflight.ts` `isGradingTier` indirection | **safe** | Pure call-site change from inline array `.includes()` to the exported predicate from `src/grading.ts`. |
| `src/calibration.ts` `parseCases` extraction | **safe** | Two near-identical loops de-duplicated. Both call sites retain the same null-on-malformed-input semantics. |
| `src/commands/list.ts` unused `manifest` removed | **safe** | The variable was assigned from `readManifest(layout)` and never read; the function uses the `readOnlyState(store)` view instead. |
| `src/escalation.ts` `summaryFromEvent` extraction | **safe** | One map-from-event shape used in two places (the local push in `unresolvedEscalations` and the caller in `step.ts`); deduped. |
| `src/step.ts` local `toRef` / `toEscalationSummary` replaced with shared exports | **safe** | `toRef` and `refFromIntent` produce identical objects; `toEscalationSummary` and `summaryFromEvent` produce identical summaries. The dead `const unit = units[intent.unit_id] ?? null;` in the polling loop was removed — confirmed unused (`unit` was never referenced in the loop body). |
| `src/step.ts` `await runStep` outcome discarded | **safe** | The returned `StepOutcome` was assigned but never read in the driver's main loop body; the driver decides its next move from `state.phase` and the in-memory `units`. Pure cleanup. |

**Simplify pass overall: SAFE.** No behavior regressions. One small bug fix (amend.ts null hash) was incidentally folded in.

---

## 4. Test-suite assessment

### Strengths

- **Real CLI drive.** E2E tests spawn the real `PaseoCliAdapter` against the live daemon in real git worktrees (`test/e2e/helpers/e2e-harness.ts:5-15, 50-53`). The fake substrate probe is injected only for the KTD9-injected seam the plan mandates; `substrate-fail-closed.test.ts` runs the real probe.
- **Kill-drill rigor.** `test/kill-drill-v1.test.ts:166-178` injects a manual crash-truncated tail when the random kill doesn't produce one, so the repair path is *deterministically* covered. Byte-identical state assertions (`:208-218`) compare independent artifacts (raw journal prefix vs. derived-state serialization) so a regression in either path is caught.
- **Calibration bar boundaries.** `test/calibration.test.ts:47-98` covers the strict `>` (14/15 does not clear; 15/15 does), the zero-false-pass floor, and the non-relaxable invariant.
- **E2E resume-after-crash.** Well covered in `test/dispatch.test.ts` (4 reconciliation scenarios) and `test/kill-drill-v{1,2}.test.ts` (intent-without-created, intent+created, stale-takeover, continue-to-completion).
- **Boundary preflight.** Cyclic dependency, missing-acceptance, missing-creates, missing-inputs, unresolved-dependency, unrecognized-tier, cross-unit-creates-conflict, unresolved-input — all asserted (`test/preflight.test.ts`).
- **Lease invariants.** Stale-takeover (R72), never-fresh-steal (R39), two-drivers-compete-for-lease — all asserted (`test/lease.test.ts`, `test/run.command.test.ts:167-199`).
- **No `any` and no wrong-boundary mocks.** Verified by search. Adapter, substrate-probe, diff-runner, and command-runner seams are mocked at the right layer; no test mocks the parser or filesystem under the seam.

### Gaps (worth surfacing but not blocking)

1. **Open gap surviving to `run_terminal` is untested** — see M1. The acceptance predicate is unit-tested for the "all-criteria-pass + no-blocking-gap" happy path and the "blocking gap present" rejection path, but never the "operator accepts with a different gap still open" path.
2. **No-progress across a session boundary is untested** — see L4.
3. **`miah resolve --decision deny` is untested** (`test/resolve.command.test.ts` only covers approve and rework).
4. **Lease-held paths in `resolve`/`approve`/`reject`/`amend` are untested** (only `stop` and `run` cover it).
5. **`run` returning `RUN_BLOCKED_EXIT_CODE` (1) is unasserted at the unit level** — only the E2E child relies on it. (See also L5 for the deadline-refusal sibling.)
6. **No real-binary smoke test** — see L3.

### Calibration

The 335 unit tests + 4 E2E tests cover the documented R-number surface at the unit level. The riskiest surface (driver loop, step function, reconciliation, journal repair, custody chain, T2-T3 continuity) is covered by both unit tests with seeded fakes and the real-daemon E2E. The simplify pass did not reduce test count or coverage.

---

## 5. Operator-facing notes for the PR

- **M1 is the only finding worth a PR-description callout.** The operator's `approval-package.json` may omit implicitly-closed gaps when the operator uses `miah resolve --decision approve` to accept a unit with multiple open gaps. The journal itself is honest; this is a transparency issue, not a corruption issue. Decide whether to land as-is and document, or ship M1's `gap_closed` close-reason injection as a small follow-up.
- **L1 (E2E daemon gate) is a CI-only concern** but easy to fix. The harness already has the helper; copy the pattern from `test/e2e/substrate-fail-closed.test.ts:65,106` into the other three E2E files.
- **L2 (errorPrefix inconsistency) is a UX nit** and the simplify pass preserved the old behavior for 8/10 commands. Either accept or pass a per-command prefix; not blocking.
- **The simplify pass is genuinely safe** — feel free to call it out as behavior-preserving in the commit message (and note the `amend.ts` null-hash cleanup as a small bonus fix).
- **No changes to public APIs**, no schema breaks, no config-default changes, no `package.json` dependency changes other than `commander` moving to dependencies (commit `6c448aa`, which is correct per the simplify pass).
- **`dist/index.js` is not in the diff** — the operator will need to run the build before installing or publishing. The `package.json` `bin` field already points at it; just confirm the build step is in the merge checklist.
- **The 5 unpushed commits** (`Your branch is ahead of 'origin/feat/miah-implementation' by 5 commits`) include the simplify pass and the three deferred fixes. Pushing them is the operator's call.

---

## 6. Methodology & scope

- **Skill:** `ce-code-review` loaded and followed. Report-only path (no source files modified, no commits, no pushes).
- **Scope:** 16-commit branch diff vs `main` (23,592 +/0 net across 102 files).
- **Deep-read files:** `src/fsm.ts`, `src/driver.ts`, `src/step.ts`, `src/journal.ts`, `src/run-store.ts`, `src/lease.ts`, `src/replay.ts`, `src/snapshot.ts`, `src/dispatch.ts`, `src/evidence.ts`, `src/custody.ts`, `src/acceptance.ts`, `src/grading.ts`, `src/calibration.ts`, `src/preflight.ts`, `src/adapter/paseo.ts`, `src/commands/index.ts`, `src/commands/amend.ts`, `src/commands/resolve.ts`, `src/commands/start.ts`, `src/types.ts`, `src/escalation.ts`, `src/gap.ts`.
- **Sub-agent dispatches:** 3 parallel review sub-agents (commands/CLI surface, crash-safety/durability, plan-conformance + test-quality) on the riskiest surface; their findings were cross-verified by direct file reads.
- **Not modified:** No source files. The only file created is this review at `docs/reviews/2026-08-08-final-code-review.md`.
- **Calibration check:** The review consciously applies a strict "no vibes" bar. M1 is rated *minor* (not medium) because the journal is honest and only the approval-package list is incomplete — a real defect but bounded in blast radius. The latent custody-chain race at concurrency > 1 is rated *nit* because the plan's default `concurrency_cap: 1` (`src/types.ts:177`) makes it unreachable in v1; it is a follow-up note, not a current defect.
