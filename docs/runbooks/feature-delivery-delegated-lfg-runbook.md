# Runbook — Delivering a Feature from Spec/Brainstorm to Merged Work

A reusable, agent-delegated delivery process. Distilled from the session that
shipped the **independent-verifier-role** feature (PR #9, squash `ea58d3f`,
Aug 11–12 2026): a `/dispatch-setup` dispatcher agent (Paseo agent
`31b95081`) took a requirements-only spec, enriched it into an
implementation-ready plan, implemented it through delegated specialist
agents, drove it through two independent review loops to a verified
merge-ready verdict, merged it, and captured the knowledge — without writing
a single line of code itself.

Use this runbook when you want the same process applied to another plan,
spec, or brainstorm. It works for any repo that has: opencode + Paseo, the
Compound Engineering (CE) plugin skills, and the `gh` CLI with a GitHub
remote.

## The one-paragraph model

You are the **dispatcher**, not the doer. You clarify the operator's intent,
turn it into a goal prompt, dispatch one specialist agent per stage on a
rotating model roster, supervise the loop against each stage's exit gate,
verify every handoff yourself (never trust a handoff summary), and escalate
to the operator only for genuine decisions. Work happens in an **isolated
git worktree** so the main checkout never sees mid-flight state.

## Prerequisites

| Thing | Need for |
| --- | --- |
| opencode + Paseo workspace | agent dispatch, background agents, heartbeats |
| CE plugin skills | `ce-plan`, `ce-work`, `ce-simplify-code`, `ce-code-review`, `ce-commit-push-pr`, `ce-babysit-pr`, `lfg` |
| Model roster | frontier planner (gpt-5.6-sol or opus 5), workhorse (deepseek-v4-flash), auditor (minimax-m3) |
| `gh` CLI + GitHub remote | PR, CI watch, Copilot review requests, issues |
| Repo conventions | artifact roots (CE resolves `docs` without a `.compound-engineering/config.yaml`), commit style, PR squash convention |

Verify provider live-ness before the run: some models are only reachable
through a sub-provider path (e.g. `opencode/opencode-go/deepseek-v4-flash`,
`opencode/openai/gpt-5.6-sol`); a bare `opencode/deepseek-v4-flash` fails
agent creation. Check `paseo_list_providers` / `paseo_list_models` first and
test-resolve the exact string before dispatching.

## The pipeline at a glance

| # | Stage | Skill / mechanism | Agent (model) | Exit gate (orchestrator verifies) |
| --- | --- | --- | --- | --- |
| 0 | Intake triage | read plan + `ce-work` | dispatcher | plan readiness known; gaps surfaced |
| 1 | Setup | worktree + routing + heartbeat | dispatcher | clean worktree on new branch |
| 2 | Plan enrichment | `ce-plan` | frontier model | file on disk, `implementation-ready`, U-IDs, verification contract, DoD |
| 3 | Implement | `ce-work mode:return-to-caller` | deepseek-v4-flash | structured envelope, change set matches, suite green, no commits |
| 4 | Simplify | `ce-simplify-code` | deepseek-v4-flash | diff reduced or justified; test baseline held |
| 5 | Review | `ce-code-review mode:agent` | minimax-m3 (cross-family) | findings JSON; P1s verified real by orchestrator |
| 6 | Fixes | apply findings | deepseek-v4-flash | each finding landed + test; suite green |
| 7 | Residuals | committed record file | dispatcher | `docs/residual-review-findings/<feat>.md` committed |
| 8 | Browser test | `ce-test-browser` | dispatcher | **skip with reason** if no UI changed |
| 9 | Ship | `ce-commit-push-pr mode:pipeline` | deepseek-v4-flash | commit pushed, PR open vs main |
| 10 | CI | `ce-babysit-pr` | deepseek-v4-flash | CI terminal + pass on head |
| 11 | Merge-ready loop | `pr-merge-ready-loop` | judge + babysitter + Copilot | judge-written `ready` in verdict log, Copilot review on current head, CI green |
| 12 | Merge + cleanup | operator command | dispatcher | merged, branches/worktrees/agents cleaned |
| 13 | Explain + wrapup | `ce-explain`, `wrapup`, `ce-compound` | dispatcher | explainer committed, digest + learning + vocabulary pushed |

---

## Stage 0 — Intake triage (fail closed)

1. Read the spec/plan **and** the skill you'll hand it to (`ce-work` in this
   case). Never dispatch before reading both.
2. Parse the plan's frontmatter, especially `artifact_contract` and
   `artifact_readiness`.
3. **`requirements-only` is a hard stop.** It means: no Implementation
   Units, no per-unit Verification Contract, no Definition of Done. Do NOT
   let a worker "figure out" contract-level decisions during implementation
   — those are operator-frozen calls. Surface the exact gaps and the
   Outstanding Questions that must be settled.
4. Options you offer: (a) enrich the plan first (Stage 2), or (b) run the
   full pipeline with planning as stage 2 (the operator's choice in this
   session was `/lfg` but delegated).

## Stage 1 — Setup

1. Orient: repo remote (exists → full push/PR/CI pipeline applies), branch
   state, workspaces, CE artifact root, existing knowledge stores.
2. Create an **isolated worktree** on a new branch
   (`feat/<feature-slug>`) — `paseo_create_workspace isolation:worktree`,
   `branch-off`. Verify the plan is present in the worktree and the tree is
   clean.
3. Confirm the model roster with the operator before spending (this session
   changed opus 5 → gpt-5.6-sol mid-run; record routing in the todo view).
4. Create a **supervision heartbeat** (`paseo_create_heartbeat`, every 15
   min) that pings you to verify subagents are alive and progressing. Delete
   it when the pipeline reaches DONE — never leave it running.

## Stage 2 — Plan enrichment (ce-plan, frontier model)

1. Dispatch a planner agent on the frontier model (`gpt-5.6-sol` or opus 5)
   in `bypassPermissions` mode (writes files in the isolated worktree
   without permission churn). Brief = the lfg/ce-plan handoff: enrich the
   requirements-only plan into a **new sibling file**, leave the source
   untouched, resolve the Outstanding Questions explicitly, produce
   non-overlapping units sized so the repo's preflight can admit them, each
   with a frozen verification contract.
2. **Failure mode: "finished" without an artifact.** A planner can burn
   budget designing and return without writing (this session: ~$3.66, clean
   tree). NEVER trust the return message — check the worktree/disk. If no
   file landed, re-dispatch the SAME brief verbatim (lfg retry rule) and
   add: "write the file and verify it exists on disk before finishing."
3. Exit gate — verify all of these yourself on disk:
   - `artifact_readiness: implementation-ready`, `execution: code`,
     `origin:` pointer to the source spec
   - Implementation Units with U-IDs, per-unit Verification Contract,
     Definition of Done, stop conditions
   - `git diff --check` clean, no absolute paths (fix if present)
   - Vision/strategy alignment check passed (if the repo has the rubric)

## Stage 3 — Implementation (ce-work, workhorse)

1. Dispatch `ce-work` in **`mode:return-to-caller`** on deepseek-v4-flash:
   implement + locally verify, NO commits, NO PR, return a structured
   envelope (status, changed files, units attempted/completed, verification
   results, environment caveats).
2. Supervise (heartbeat): the agent should first establish a **baseline**
   (install deps, run the suite before changing code). Then units in
   dependency order, each gated by its per-unit tests, full-suite check at
   the end.
3. Failure playbook you will likely need:
   - **Hanging test command**: check process CPU, not wall clock. Isolate:
     run the hanging file alone with a timeout; exclude the known-bad group
     (e.g. `--exclude test/e2e`). Tell the agent to treat it as an
     environment limitation, document it in the envelope, and **never
     weaken/skip/mock an assertion to force a pass**.
   - **Agent idle mid-turn with no finish notification**: re-prompt to
     resume with the completion instruction restated. One stall → re-prompt;
     two consecutive → treat as failure and escalate to operator.
   - **Temp debug files**: agents create throwaway test files (`tmp-debug*`)
     when debugging. Enforce removal before the stage closes.
4. Exit gate — the orchestrator independently verifies EVERYTHING:
   - Tree matches the envelope (changed files, untracked files, no temp
     files, no commits — HEAD still at base)
   - Run the authoritative suite yourself (and tsc/build) — do not copy the
     agent's numbers

## Stage 4 — Simplify (ce-simplify-code)

1. Dispatch on the workhorse against the branch diff, with explicit
   **structure-pin protection** (the plan's settled decisions / KTD-KD
   items are frozen; simplifier must decline, not refactor, anything the
   plan pins) and a hard requirement to hold the test baseline.
2. Expect parallel reviewer subagents (reuse/quality/efficiency) and
   declined findings — declining with reason is a correct outcome, not a
   failure.
3. Exit gate: tsc + full suite independently re-run; baseline held;
   structure pins untouched.

## Stage 5 — Review (ce-code-review, cross-family auditor)

1. Dispatch `ce-code-review mode:agent` on a **different model family than
   the implementer** (minimax-m3 audits deepseek-v4-flash work — fresh
   mind, not a mirror of the worker's context). Point it at the plan so its
   fixed decisions are the review's structure pins.
2. **Arbitrate, don't rubber-stamp.** The audit returns JSON findings
   (severity P1/P2, confidence, evidence) plus advisory items. Before
   accepting, verify each P1/P2 against the actual code yourself. In this
   session both P1s were confirmed real; the earlier claim of "0 findings"
   is not a reason to skip this.
3. Route: P1/P2 with `autofix_class: gated_auto` → Stage 6. Advisory items
   → Stage 7 residuals. The auditor's review budget is one pass; don't let
   it loop.

## Stage 6 — Fixes (apply findings)

1. Dispatch the fixer (workhorse) with the verified findings list; each fix
   must come with a test and the suite must stay green.
2. Exit gate: verify each fix landed in code (not just "claimed"), tsc
   clean, suite green (this session: 413 → 419 with the 4 fixes).

## Stage 7 — Residuals (durable, always)

Advisory/non-eligible findings must not vanish. If no tracker exists,
write a committed record file under `docs/residual-review-findings/<feature>.md`
listing each advisory finding with context, and commit it as its own
canonical commit (dispatcher-owned). Include environment limitation notes
(e.g. daemon-dependent tests that only run in CI). Everything not fixed is
tracked somewhere durable — that is the rule.

## Stage 8 — Browser test (applies only if UI changed)

A CLI/API change has no UI surface → **skip with a documented reason** in
the report. Only run `ce-test-browser` when the diff touches user-visible
pages.

## Stage 9 — Ship (ce-commit-push-pr)

1. Dispatch on the workhorse in `mode:pipeline` with `branding:on`: commit
   the implementation + untracked plan files, push the branch, open the PR
   against main.
2. PR body requirements: plan path, settled-decisions provenance
   (KD1..KDn, no conflicts), validation caveats (CI-only tests), branding
   footer. Don't invent a `New concepts:` trailer if the vocabulary is
   already in `CONCEPTS.md`.
3. Exit gate: verify the PR exists (OPEN), correct base/head range, clean
   working tree.

## Stage 10 — Babysit CI

1. Dispatch `ce-babysit-pr mode:pipeline` (workhorse): watch to a
   CI-decided state, fix real convergent failures within the skill's
   round budget, resolve review comments.
2. Verify independently: check states terminal + pass on head, merge state
   CLEAN/MERGEABLE.
3. Upon DONE: **delete the supervision heartbeat**, publish the close-out
   report (journey table, what was verified, what's left for the operator),
   and hand the merge decision to the operator. You never merge without
   being told.

## Stage 11 — Merge-ready loop (pr-merge-ready-loop)

Optional second gate, used when the operator wants review-driven merge
readiness beyond CI.

1. Adopt the PR. Spawn two agents with **separated authority**:
   - **Judge** (read-only, cross-family model): decides verdict + fix-list
     + Copilot-round requests; writes ONLY the verdict log
     (`tmp/merge-ready-verdicts.json`, gitignored)
   - **Babysitter** (executor, workhorse): executes — Copilot review
     requests, fixes, commits, pushes, thread resolution
   - **Copilot** (`copilot-pull-request-reviewer[bot]`) as primary reviewer
2. Readiness conditions for a `ready` verdict (all three):
   1. Latest Copilot review is on the **current head**
   2. Judge's verdict in the log (written by the judge, not the babysitter)
      resolves every finding: fixed-and-verified, or declined with reason
   3. CI green on head, merge state CLEAN/MERGEABLE
3. Budgets: max 3 Copilot rounds. If findings exceed the budget, the loop
   parks them and returns `needs-human` — parking is a loop-bound rule, not
   a quality verdict.
4. **Operator override**: if the operator says "why not fix the parked
   findings now?", extend the budget by the requested number of rounds,
   record the override in the verdict log, fix, verify, and run one fresh
   Copilot round on the new head (a new head invalidates the old review —
   condition 1).
5. Verify the verdict log yourself each round (judge's own writing), and
   query GraphQL directly for review state; PowerShell truncates/behaves
   differently (`gh pr view` may miss `copilot-pull-request-reviewer` —
   query `reviewRequests` via GraphQL).
6. Terminal state: report to operator with full accounting (rounds, Copilot
   rounds, findings fixed/declined/parked, parked follow-ups). **File
   follow-ups as GitHub issues** when the operator asks, with evidence,
   root cause, suggested fix, and PR provenance. Neither loop agent merges.

## Stage 12 — Merge + cleanup

1. On operator command, verify the PR is still in its verified state
   (head unchanged, CI pass, MERGEABLE) before merging. Squash per repo
   convention.
2. Known collision: `--delete-branch` fails if the branch's worktree is
   checked out on main — the merge itself still lands; clean the branch
   separately.
3. Cleanup checklist:
   - `git ls-remote` — feature branch gone
   - Paseo workspace archived (archives the worktree + all agents)
   - leftover worktree dir removed; `git worktree list` shows only main

## Stage 13 — Explain + wrapup (knowledge capture, non-negotiable)

1. If a non-technical stakeholder needs to understand the change, offer the
   options menu (stakeholder email / HTML one-pager / presentation /
   `ce-explain` explainer / promo copy) and build what they choose. For
   `ce-explain` rendered for another reader: third person, plain language,
   full depth, honest caveats, timeline-led, self-contained HTML.
2. **Placement trap:** committing the explainer to the feature branch
   advances the head and invalidates a merge-ready verdict (needs a fresh
   Copilot round). Leave it uncommitted in the worktree and land it as its
   own docs commit on main AFTER the merge.
3. Run `wrapup` exactly: session digest
   (`docs/session-digests/YYYYMMDDNN_<slug>.md`), then `ce-compound`
   **headless** for the most valuable solved problem
   (`docs/solutions/<category>/...`), then CONCEPTS.md vocabulary capture
   for any new project-specific term, and record refresh recommendations
   (e.g. a pattern doc whose headline fact is now false).
4. Commit and push the capture artifacts; verify `HEAD == origin/main`.

---

## Cross-cutting rules (observed, non-negotiable)

1. **You never implement.** If work is small enough to do yourself, it's
   small enough to dispatch. Your output is goal prompts, verification, and
   plain-language reports.
2. **Fail closed.** Requirements-only plans, unresolved contract questions,
   missing verification gates — stop and surface, don't route around.
3. **Verify independently at every gate.** File exists on disk, change set
   matches the envelope, suites run by you, P1s checked against code,
   verdict log written by the judge, CI terminal state checked directly.
4. **Cross-family review.** Reviewer/auditor/judge on a different model
   family than the worker.
5. **Authority separation.** Judge decides, babysitter executes, Copilot
   reviews, operator merges. No agent occupies two roles.
6. **One heartbeat per pipeline run, deleted at DONE.** Supervision checks
   in every 15 min; stalled agents get one re-prompt, then escalation.
7. **Everything durable or tracked.** Residuals committed, follow-ups filed
   as issues, learnings compounded, vocabulary captured.
8. **Cleanup to a blank slate.** Branches, worktrees, agents, temp files.
9. **Report shape is constant:** status → what happened → evidence → next
   step → what you need from the operator.

## Reusable checklist for the next feature

- [ ] Read spec + target skill; triage readiness
- [ ] Confirm roster/routing with operator
- [ ] Worktree isolation on `feat/<slug>`
- [ ] Heartbeat created (15 min), model verified via provider list
- [ ] Planning: frontier model, sibling file, verify on disk (readiness
      metadata, U-IDs, contract, DoD, diff-check clean)
- [ ] Implement: ce-work return-to-caller; supervise; verify tree +
      suite yourself
- [ ] Simplify: structure pins; baseline held
- [ ] Review: cross-family; arbitrate P1s against code
- [ ] Fix: findings + tests; re-verify
- [ ] Residuals: committed record file
- [ ] Browser test: skip-with-reason or run
- [ ] Ship: commit/push/PR with provenance in body
- [ ] Babysit CI to green; delete heartbeat
- [ ] Merge-ready loop (judge/babysitter/Copilot) to `ready`; operator
      overrides recorded; follow-ups filed
- [ ] Merge on operator command; full cleanup
- [ ] Explainer (if asked); wrapup: digest + compound + vocabulary,
      commit + push