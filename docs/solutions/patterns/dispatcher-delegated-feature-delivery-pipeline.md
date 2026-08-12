---
title: "Dispatcher-orchestrated fully-delegated feature delivery: requirements-only spec to merged, review-verified PR"
date: 2026-08-12
category: patterns
module: miah
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - "Delivering a feature from a requirements-only spec or brainstorm to a merged, review-verified PR"
  - "When an orchestrator must supervise specialist agents without implementing anything itself"
  - "When the repo has opencode + Paseo, CE plugin skills, and gh CLI with a GitHub remote"
  - "When review-driven merge readiness beyond CI is required (judge/babysitter/Copilot loop)"
  - "When authority separation matters: judge decides, babysitter executes, operator merges"
symptoms:
  - "A dispatched planner reports finished but no artifact exists on disk"
  - "A review pass reports zero findings without per-finding evidence"
  - "An agent stalls mid-turn without a finish notification"
  - "A head advance invalidates a merge-ready verdict (needs a fresh review round)"
  - "Test commands hang in a non-daemon environment"
tags:
  - agent-orchestration
  - delegation
  - dispatcher
  - paseo
  - worktree-isolation
  - cross-family-review
  - merge-ready-loop
  - authority-separation
related_components:
  - tooling
  - documentation
---

# Dispatcher-orchestrated fully-delegated feature delivery: requirements-only spec to merged, review-verified PR

> **Cross-project knowledge.** This pattern was validated in the Miah repo (feature "independent verifier role", PR #9) but applies to any repo with opencode + Paseo, the Compound Engineering (CE) plugin skills, and a GitHub remote: an orchestrating dispatcher agent delivers a feature from spec or brainstorm to a merged, review-verified PR by delegating every stage to a specialist agent — and never implementing anything itself.

## Context

This learning documents the **delegated feature-delivery pipeline**: an orchestrating dispatcher agent delivers a feature from a requirements-only spec or brainstorm to a merged, review-verified PR — without writing a line of code itself. The dispatcher clarifies intent, enriches the plan, dispatches one specialist agent per stage on a rotating model roster, supervises each stage's exit gate, verifies every handoff itself, and escalates to the operator only for genuine decisions.

The validating session ran in the miah repo on the **independent-verifier-role** feature, merged as **PR #9** (squash `ea58d3f`, Aug 11–12 2026). A `/dispatch-setup` dispatcher agent (Paseo agent `31b95081`) took a requirements-only spec, enriched it into an implementation-ready plan, delegated implementation to specialist agents, drove it through two independent review loops to a verified merge-ready verdict, merged it, and captured the knowledge. Follow-up issues **#10** and **#11** were filed from that session's residuals; the earlier Miah v1 product merge is **PR #1**.

The pipeline was distilled into a reusable runbook, `docs/runbooks/feature-delivery-delegated-lfg-runbook.md`, which is the full-depth companion to this learning. It runs fourteen stages (0–13): intake triage → setup (worktree + heartbeat) → plan enrichment → implementation → simplify → review → fixes → residuals → browser test → ship (PR) → babysit CI → merge-ready loop → merge + cleanup → explain + wrapup.

## Guidance

The pipeline as observed, stage by stage. Stage numbers and exit gates follow the runbook's table.

### Stage 0 — Intake triage (fail closed)

- Read the spec/plan **and** the skill you will hand it to (`ce-work` in the validating session) before dispatching anything.
- Parse the plan frontmatter, especially `artifact_contract` and `artifact_readiness`.
- **`requirements-only` is a hard stop**: no Implementation Units, no per-unit Verification Contract, no Definition of Done. Do NOT let a worker "figure out" contract-level decisions during implementation — those are operator-frozen calls. Surface the exact gaps and the Outstanding Questions that must be settled.
- Offer the operator two paths: (a) enrich the plan first, or (b) run the full pipeline with planning as a stage. In the validating session the operator chose `/lfg`, delegated.

### Stage 1 — Setup

- Orient: repo remote exists (full push/PR/CI pipeline applies), branch state, workspaces, CE artifact root, existing knowledge stores.
- Create an **isolated worktree** on a new branch (`feat/<feature-slug>`) via `paseo_create_workspace` with `isolation: worktree`, `branch-off`. Verify the plan is present in the worktree and the tree is clean — the main checkout never sees mid-flight state.
- Confirm the model roster with the operator before spending. Roster changes are operator decisions (this session retired opus 5 → gpt-5.6-sol mid-run; routing was recorded in the todo view).
- Verify provider live-ness before dispatching: some models are only reachable through a sub-provider path (e.g. `opencode/opencode-go/deepseek-v4-flash`, `opencode/openai/gpt-5.6-sol`); a bare provider string fails agent creation. Check `paseo_list_providers` / `paseo_list_models` and test-resolve the exact string.
- Create a **supervision heartbeat** (`paseo_create_heartbeat`, every 15 min) that pings you to verify subagents are alive and progressing. Delete it when the pipeline reaches DONE — never leave it running.

### Stage 2 — Plan enrichment (frontier model)

- Dispatch the planner on a frontier model (gpt-5.6-sol or opus 5) in `bypassPermissions` mode (writes files without permission churn). Brief: enrich the requirements-only plan into a **new sibling file**, leave the source untouched, resolve the Outstanding Questions explicitly, produce non-overlapping units sized so the repo's preflight can admit them, each with a frozen verification contract.
- **Failure mode: "finished" without an artifact.** A planner can burn budget designing and return without writing (this session: ~$3.66, clean tree). NEVER trust the return message — check the worktree/disk. If no file landed, re-dispatch the SAME brief verbatim (lfg retry rule) and add: "write the file and verify it exists on disk before finishing."
- Exit gate — verify all of these yourself on disk: `artifact_readiness: implementation-ready`, `execution: code`, `origin:` pointer to the source spec; Implementation Units with U-IDs, per-unit Verification Contract, Definition of Done, stop conditions; `git diff --check` clean, no absolute paths; vision/strategy alignment check passed if the repo has the rubric.

### Stage 3 — Implementation (workhorse)

- Dispatch `ce-work` in **`mode:return-to-caller`** on deepseek-v4-flash: implement + locally verify, NO commits, NO PR, return a structured envelope (status, changed files, units attempted/completed, verification results, environment caveats).
- Supervise: the agent should first establish a **baseline** (install deps, run the suite before changing code), then units in dependency order, each gated by its per-unit tests, with a full-suite check at the end.
- Failure playbook: hanging test command → check process CPU, not wall clock; isolate by running the hanging file alone with a timeout; exclude the known-bad group (e.g. `--exclude test/e2e`); tell the agent to treat it as an environment limitation, document it in the envelope, and **never weaken/skip/mock an assertion to force a pass**. Agent idle mid-turn with no finish notification → re-prompt once to resume with the completion instruction restated; two consecutive stalls → treat as failure and escalate to the operator. Enforce removal of temp debug files (`tmp-debug*`) before the stage closes.
- Exit gate — the orchestrator independently verifies EVERYTHING: tree matches the envelope (changed files, untracked files, no temp files, no commits — HEAD still at base), and run the authoritative suite and tsc yourself; do not copy the agent's numbers.

### Stage 4 — Simplify

- Dispatch `ce-simplify-code` on the workhorse against the branch diff, with explicit **structure-pin protection**: the plan's settled decisions (KTD/KD items) are frozen; the simplifier must decline, not refactor, anything the plan pins. Hard requirement to hold the test baseline.
- Expect parallel reviewer subagents (reuse/quality/efficiency) and declined findings — declining with reason is a correct outcome, not a failure.
- Exit gate: tsc + full suite independently re-run by you; baseline held; structure pins untouched.

### Stage 5 — Review (cross-family auditor)

- Dispatch `ce-code-review mode:agent` on a **different model family than the implementer** (minimax-m3 audited deepseek-v4-flash work — fresh context, not a mirror of the worker's context). Point it at the plan so its fixed decisions are the review's structure pins.
- **Arbitrate, don't rubber-stamp.** The audit returns JSON findings (severity P1/P2, confidence, evidence) plus advisory items. Verify each P1/P2 against the actual code yourself before accepting. In the validating session both P1s were confirmed real; the earlier claim of "0 findings" is not a reason to skip this.
- Route: P1/P2 with `autofix_class: gated_auto` → fixes stage; advisory items → residuals stage. The auditor's review budget is one pass; don't let it loop.

### Stage 6 — Fixes

- Dispatch the fixer (workhorse) with the verified findings list; each fix must come with a test and the suite must stay green.
- Exit gate: verify each fix landed in code (not just "claimed"), tsc clean, suite green (validating session: 413 → 419 with the 4 fixes).

### Stage 7 — Residuals (durable, always)

- Advisory/non-eligible findings must not vanish. If no tracker exists, write a committed record file under `docs/residual-review-findings/<feature>.md` listing each advisory finding with context, and commit it as its own canonical commit (dispatcher-owned). Include environment limitation notes (e.g. daemon-dependent tests that only run in CI). Everything not fixed is tracked somewhere durable — that is the rule.

### Stage 8 — Browser test (only if UI changed)

- A CLI/API change has no UI surface → skip with a documented reason in the report. Only run `ce-test-browser` when the diff touches user-visible pages.

### Stage 9 — Ship

- Dispatch `ce-commit-push-pr` on the workhorse in `mode:pipeline` with `branding:on`: commit the implementation plus untracked plan files, push the branch, open the PR against main.
- PR body requirements: plan path, settled-decisions provenance (KD1..KDn, no conflicts), validation caveats (CI-only tests), branding footer. Don't invent a `New concepts:` trailer if the vocabulary is already in `CONCEPTS.md`.
- Exit gate: verify the PR exists (OPEN), correct base/head range, clean working tree.

### Stage 10 — Babysit CI

- Dispatch `ce-babysit-pr mode:pipeline` (workhorse): watch to a CI-decided state, fix real convergent failures within the skill's round budget, resolve review comments.
- Verify independently: check states terminal + pass on head, merge state CLEAN/MERGEABLE.
- Upon DONE: **delete the supervision heartbeat**, publish the close-out report (journey table, what was verified, what's left for the operator), and hand the merge decision to the operator. You never merge without being told.

### Stage 11 — Merge-ready loop (optional second gate)

Used when the operator wants review-driven merge readiness beyond CI. Adopt the PR and spawn two agents with **separated authority**:

- **Judge** (read-only, cross-family model): decides verdict + fix-list + Copilot-round requests; writes ONLY the verdict log (`tmp/merge-ready-verdicts.json`, gitignored).
- **Babysitter** (executor, workhorse): executes — Copilot review requests, fixes, commits, pushes, thread resolution.
- **Copilot** (`copilot-pull-request-reviewer[bot]`) as primary reviewer.

Readiness conditions for a `ready` verdict (all three): (1) latest Copilot review is on the **current head**; (2) the judge's verdict in the log (written by the judge, not the babysitter) resolves every finding — fixed-and-verified, or declined with reason; (3) CI green on head, merge state CLEAN/MERGEABLE.

Budgets: max 3 Copilot rounds. If findings exceed the budget, the loop parks them and returns `needs-human` — parking is a loop-bound rule, not a quality verdict. **Operator override**: if the operator orders parked findings fixed, extend the budget by the requested number of rounds, record the override in the verdict log, fix, verify, and run one fresh Copilot round on the new head (a new head invalidates the old review — condition 1). Verify the verdict log yourself each round (judge's own writing), and query GraphQL directly for review state (`gh pr view` may miss `copilot-pull-request-reviewer`; query `reviewRequests` via GraphQL). Terminal state: report to the operator with full accounting (rounds, Copilot rounds, findings fixed/declined/parked, parked follow-ups). File follow-ups as GitHub issues when the operator asks, with evidence, root cause, suggested fix, and PR provenance. Neither loop agent merges.

### Stage 12 — Merge + cleanup

- On operator command, verify the PR is still in its verified state (head unchanged, CI pass, MERGEABLE) before merging. Squash per repo convention.
- Known collision: `--delete-branch` fails if the branch's worktree is checked out on main — the merge itself still lands; clean the branch separately.
- Cleanup checklist: `git ls-remote` shows the feature branch gone; Paseo workspace archived (archives the worktree + all agents); leftover worktree dir removed; `git worktree list` shows only main.

### Stage 13 — Explain + wrapup (non-negotiable)

- If a non-technical stakeholder needs to understand the change, offer the options menu (stakeholder email / HTML one-pager / presentation / `ce-explain` explainer / promo copy) and build what they choose. For `ce-explain` rendered for another reader: third person, plain language, full depth, honest caveats, timeline-led, self-contained HTML.
- **Placement trap:** committing the explainer to the feature branch advances the head and invalidates a merge-ready verdict (it needs a fresh Copilot round). Leave it uncommitted in the worktree and land it as its own docs commit on main AFTER the merge.
- Run `wrapup` exactly: session digest (`docs/session-digests/YYYYMMDDNN_<slug>.md`), then `ce-compound` **headless** for the most valuable solved problem (`docs/solutions/<category>/...`), then `CONCEPTS.md` vocabulary capture for any new project-specific term, and record refresh recommendations (e.g. a pattern doc whose headline fact is now false).
- Commit and push the capture artifacts; verify `HEAD == origin/main`.

### Cross-cutting rules (observed, non-negotiable)

1. **You never implement.** If work is small enough to do yourself, it's small enough to dispatch. Your output is goal prompts, verification, and plain-language reports.
2. **Fail closed.** Requirements-only plans, unresolved contract questions, missing verification gates — stop and surface, don't route around.
3. **Verify independently at every gate.** File exists on disk, change set matches the envelope, suites run by you, P1s checked against code, verdict log written by the judge, CI terminal state checked directly.
4. **Cross-family review.** Reviewer/auditor/judge on a different model family than the worker.
5. **Authority separation.** Judge decides, babysitter executes, Copilot reviews, operator merges. No agent occupies two roles.
6. **One heartbeat per pipeline run, deleted at DONE.** Supervision checks in every 15 min; stalled agents get one re-prompt, then escalation.
7. **Everything durable or tracked.** Residuals committed, follow-ups filed as issues, learnings compounded, vocabulary captured.
8. **Cleanup to a blank slate.** Branches, worktrees, agents, temp files.
9. **Report shape is constant:** status → what happened → evidence → next step → what you need from the operator.

## Why This Matters

- **Contract-level decisions are operator territory.** A `requirements-only` plan defers the evidence-package shape, envelope shape, escalation payloads, and contract artifact shape. A worker resolving those quietly during implementation creates drift that is expensive to unwind; fail-closed intake keeps the authority boundary intact.
- **Independent review is only meaningful cross-family.** The minimax-m3 audit of deepseek-v4-flash work found both P1s in the validating session (the `ungraded`-verdict misrouting and the historical `reviewer`-role replay clobbering) — findings a same-family reviewer's mirrored context was likely to miss. "0 findings" from a mirror is not verification.
- **A verifier that always passes is worse than no verifier.** Weakening/skipping/mocking assertions to force a pass destroys the evidence the tests exist to produce. The same principle extends to pipeline gates: never trust a handoff summary, always re-run the suite yourself.
- **Artifact-producing agents must verify on disk before terminating.** The opus 5 planner burned ~$3.66 designing and "finished" without writing anything. A completion message is not an artifact; the write-then-verify instruction is what made the retry succeed.
- **Authority separation makes merge readiness trustworthy.** A fixer that also certifies its own fixes is a rubber stamp. The judge-written verdict log — rounds, findings, fixes_verified — is the audit trail the operator uses to make the merge call.
- **Everything durable.** Residuals committed, follow-ups filed as issues (#10/#11 from this session), learnings compounded, vocabulary captured — so nothing discovered during delivery is lost when the PR merges.

## When to Apply

- When the operator wants a feature delivered from a requirements-only spec, plan, or brainstorm all the way to a merged, review-verified PR — and the repo has opencode + Paseo, the Compound Engineering (CE) plugin skills, and the `gh` CLI with a GitHub remote.
- When the operator asks for the lfg-style full pipeline but delegated: every stage run by a separate specialist agent, the orchestrator verifying and arbitrating but never implementing.
- When review-driven merge readiness beyond CI is wanted (the optional Stage 11 merge-ready loop with judge/babysitter/Copilot).
- Not for repos lacking the prerequisites (no Paseo, no CE skills, or no GitHub remote means the push/PR/CI stages collapse). If work is small enough that doing it yourself is faster, the first cross-cutting rule still applies: it's small enough to dispatch anyway.
- Use the full runbook as the stage-by-stage procedure; this learning is the condensed pattern.

## Examples

**Planner "finished" without an artifact → same-brief retry on verify-on-disk.** In the validating session, the opus 5 planner (`3e18330a`) burned ~$3.66 in deep design reasoning — it had worked out the evidence-package manifest, envelope `grades` field, escalation triggers, contract field name, the R2/R3 integrity gate, and a U1–U10 unit mapping — but its final `[Write]` never landed: working tree clean, plan file unchanged at 150 lines and still `requirements-only`. The dispatcher never trusted the return message; it checked the worktree/disk, killed the dead planner, and re-dispatched the SAME brief verbatim on gpt-5.6-sol (`0bd49255`) with one added instruction: write the file and verify it exists on disk before finishing. The retry delivered the 434-line implementation-ready plan (U1–U7) with per-unit Verification Contracts and DoD, and the dispatcher independently verified the readiness metadata at the gate. This is the lfg retry rule: reuse the brief verbatim when no plan file appears.

**E2E suite hang → isolated, excluded with reason, assertions never weakened.** Mid-implementation, the full `npm test` stalled. The implementer had established the non-e2e suite was green (340 passing) and isolated the stall to the e2e suite: two real-daemon e2e files with 40-minute per-test timeouts (plus a Windows esbuild postinstall block as a second environmental cause, fixed separately via `npm install-scripts approve esbuild` + `npm rebuild esbuild`). The dispatcher told the agent to treat it as an environment limitation, run the hanging file alone with a timeout to characterize it, exclude the group locally (`--exclude test/e2e`), record it as a known-environment limitation in the return envelope, and never weaken/skip/mock an assertion to force a pass. The non-e2e suite ran 340 → 419 → 423 green across the pipeline, CI exercised the e2e files, and the exclusion was later confirmed as CI's own configuration (`--exclude test/e2e/**`).

**Ungraded-verdict P1 verified against code before fixing.** The minimax-m3 audit produced a P1 finding: the verifier's valid `ungraded` verdict was converted to `null` in `src/step.ts` and routed to builder rework instead of escalation, burning builder takes. Rather than rubber-stamping, the orchestrator verified the finding against the actual code (finding #1, `src/step.ts:1101`, confidence 100) — as it did for the other P1 (historical `reviewer`-role termination clobbering replay state) — then routed the four actionable findings to the fixer. Each fix landed with tests, the suite held (413 → 419 with the 4 fixes), and the residual record captured the advisory findings that were not fixed in scope.

## Related

- **Full-depth companion (primary reference):** `docs/runbooks/feature-delivery-delegated-lfg-runbook.md` — the distilled runbook with the 14-stage procedure, exit gates, and reusable checklist this learning condenses.
- **Validating session record:** `docs/session-digests/2026081201_independent_verifier_ship_and_merge.md` — full session arc, decisions (D1–D6), patterns (P1–P4), and solution details for PR #9.
- **Merges and follow-ups:** PR #9 (independent verifier role, squash `ea58d3f`); PR #1 (Miah v1); issues #10 and #11 (filed from merge-loop residuals).
- **Pattern docs in `docs/solutions/patterns/`:** `disk-first-paseo-loop.md` (verify on disk, never trust completion), `cross-family-verifier-audit-g-criteria.md` (cross-family audit criteria), `simplify-before-third-party-code-review.md` (simplify ordering), `paseo-per-agent-hard-bound-verification.md` (per-agent verification bounds), `miah-checker-dispatch-is-builder-only.md` (role separation), `state-aware-fsm-transition-guards.md`, `explicit-gap-close-before-supersede.md`, `kill-drill-byte-identical-resume-verification.md`.
- **Logic-error solution:** `docs/solutions/logic-errors/verifier-ungraded-verdict-misrouted-to-rework.md` — the P1 finding verified and fixed in PR #9.
- **Vocabulary:** `CONCEPTS.md` — dispatcher, cross-family verifier, verifier verdict (`pass`/`fail`/`ungraded`), verification contract, G-criteria.
- **Prerequisite skills:** `ce-plan`, `ce-work` (`mode:return-to-caller`), `ce-simplify-code`, `ce-code-review` (`mode:agent`), `ce-commit-push-pr` (`mode:pipeline`), `ce-babysit-pr`, `pr-merge-ready-loop`, `lfg`, `ce-explain`, `wrapup`.