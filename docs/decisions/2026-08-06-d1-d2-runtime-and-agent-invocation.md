---
title: D1/D2 — Runtime form factor and specialist agent invocation
date: 2026-08-06
session: Brainstorm 1
scope: docs/planning-brief.md D1, D2 only
status: decided; OP-1 settled by the operator 2026-08-06, OP-2 awaiting confirmation. The "not a
  daemon" clause and the "Long-running Miah daemon" rejected alternative below are superseded —
  see docs/decisions/2026-08-18-d1-revision-add-watchdog-daemon.md.
supersedes: nothing
superseded_by: the Phase 2 unified plan in docs/plans/ once written; and, for the "not a daemon"
  clause specifically, docs/decisions/2026-08-18-d1-revision-add-watchdog-daemon.md (2026-08-18)
---

# D1/D2 — Runtime form factor and specialist agent invocation

> Output of Brainstorm 1. Decides `docs/planning-brief.md` **D1** (runtime and form factor) and
> **D2** (specialist agent invocation). Nothing else in the brief is decided here; implications for
> D3–D9 are recorded as forward references only.
>
> **Authority:** `VISION.md` governs. Where this record and `VISION.md` appear to differ, the vision
> wins and the drift is an operator matter. No conflict with `VISION.md` or `STRATEGY.md` was found
> while writing this.
>
> **Grounding:** `VISION.md`, `STRATEGY.md`, `docs/planning-brief.md`, the four files in
> `docs/research/`, and `docs/ideation/2026-08-05-open-ideation.html`. The prior-art digest
> (`docs/research/prior-art-paseo-supervisor.md`) was opened only after the decisions below were
> drafted and frozen; see "Cross-check against prior art".

---

## D1 — Runtime and form factor

### Decision

**Miah is a standalone command-line program that behaves as a stateless interpreter over a durable
run directory.** It is not an agent, not a skill, and not a library. *(The "not a daemon" clause
that originally appeared here is superseded — see
docs/decisions/2026-08-18-d1-revision-add-watchdog-daemon.md, 2026-08-18. The supervisor itself
remains a stateless interpreter with no resident supervisor process; a separate watchdog daemon was
added for deadline enforcement only.)*

The supervisor loop does not live in a process. It lives on disk, as **immutable plan snapshot +
append-only journal + single-writer lease**. Any process may pick it up.

Seven sub-decisions carry the weight:

**D1-a. The supervisor is a pure step function.** `step(run) -> (effects, new journal events)`.
Every invocation reconstructs supervisor state from the journal, reconciles reality, performs at
most the next safe transition, and appends. There is no separate "resume" implementation, because
resume is the only implementation.

**D1-b. The driver is a separate concern from the step function.** `miah run` acquires the lease and
loops the step function until a stop condition; `miah run --once` advances as far as it can without
blocking and exits. Same entry point, same semantics, different loop. A terminal, a cron job, a
Paseo schedule, or another agent can each be the driver. None of them is privileged.

**D1-c. Liveness is a separate and degradable property from resumability.** A run that nobody is
driving is **paused**, not lost. `VISION.md` requires resumability ("a crash or interrupted session
does not lose completed work or workflow state"); it does not require unattended progress.
Separating the two means the promise Miah makes is the one it can keep unconditionally.

**D1-d. Dispatch is by durable handle, never by in-process child.** Miah journals dispatch intent
with an idempotency key *before* launching; the dispatch adapter returns a handle that outlives
Miah's process; Miah reconciles later by querying that handle. This is the hinge that makes a
stateless supervisor compatible with long-running specialist agents, and it is where D1 and D2 meet.

**D1-e. Miah's own decisions are mechanical, not judgmental.** `VISION.md` run step 7 ("evaluate the
available evidence and decide whether each unit is acceptable") is implemented as a decidable
predicate: every acceptance criterion has a passing verdict from a grader at or above its declared
tier, the evidence exists, and its custody is intact. Residual judgment is *delegated to a
dispatched reviewer* and returns as an evidence artifact. The repo-grounded reason is stronger than
any general appeal to determinism: `VISION.md` says Miah never reviews, so a supervisor that formed
its own qualitative verdicts would be doing the job it is forbidden to do.

**D1-f. Supervisor state rebuilds from the journal; workspace state does not.** The journal is
sufficient to reconstruct *what Miah knows and has authorized*. It is not sufficient to reconstruct
the repository — the workspace is the thing the run changes. Recovery is therefore
**replay-then-reconcile-against-reality**, never replay alone.

**D1-g. The control store is out-of-tree and owner-only.** Journal, lease, and run state live outside
the working tree that builders can write to. (Adopted from prior art — see below.) Evidence
artifacts may live in a workspace, but they are hashed into the journal, and the journal is not
reachable by a specialist agent's ordinary write authority.

### The resumability tension, answered directly

> *Miah must outlive or recover from the death of any single agent session, yet agent harnesses are
> typically session-bound. Where does the durable supervisor loop actually live?*

**Nowhere. That is the answer, not an evasion of it.**

The question presumes the loop is an object that must be hosted somewhere durable, which forces a
choice between a mortal session and a mortal daemon — both of which still need a journal to be
correct, so neither actually solves the problem it was chosen for. Making the *run* the durable
entity and the *loop* a re-derivable function removes the hosting question entirely: session-bound
harnesses stop being a constraint, because no harness is holding anything that matters.

Two consequences follow that a session-hosted design cannot offer:

- **Mid-run substitution is free.** The operator can change hosts, harnesses, or models between
  steps; nothing is carried in a context window.
- **The most bug-prone path stops existing.** `docs/research/agent-orchestration-research.md` §2.9
  names it: "the resume path is exactly where bugs live." A design with one path has no resume path
  to get wrong — provided that property is *tested*, which is why the kill drill below is
  load-bearing rather than decorative.

### Alternatives considered and rejected

| Alternative | Why rejected |
| --- | --- |
| **Miah as a harness agent or skill** (LLM control loop driving Paseo) | The decisive objection is not non-determinism, it is **auditability of omission**. A journaled LLM loop records what it did; it cannot record what it failed to do. A skipped gate leaves no entry, and `VISION.md` requires that "problems cannot disappear silently." Program control flow makes a gate unskippable; a prompt cannot. Secondary: loop state lives in a context window, and it puts Miah in the judging seat D1-e forbids. **Retained fragment:** an agent may *invoke* the CLI, and probably will. |
| **Long-running Miah daemon** | *(Rejection superseded 2026-08-18 for the narrow case of deadline enforcement — see docs/decisions/2026-08-18-d1-revision-add-watchdog-daemon.md. The reasoning below is kept as the historical record.)* A second supervisory daemon beside Paseo's. A process is still mortal, so the journal is required anyway — the daemon buys liveness, not durability, at the cost of install, autostart, and lifecycle burden. At one-active-plan scale it is idle most of the time, and it drifts toward the "general-purpose multi-project orchestration platform" `VISION.md` excludes. If unattended liveness later proves necessary, a thin scheduled cranker is a much smaller addition than a stateful daemon. |
| **Library only** | No operator surface, no lease owner, no run identity. It is a component of the CLI, not a rival to it. |
| **Ride Paseo entirely** (Miah as a set of Paseo skills plus schedules) | Paseo's state is mutable and Paseo-owned; there is no append-only journal. `docs/research/paseo-capabilities.md` records that restarting the daemon kills all running agents, so run durability would inherit a beta daemon's restart semantics. |
| **Adopt a durable-execution engine** (Temporal, LangGraph, DBOS) as the spine | The boring option, and genuinely tempting. Rejected for v1 because `VISION.md` mandates durable state that is *filesystem-based* and auditable by the operator; a server-backed or framework-owned checkpointer makes the audit artifact opaque and adds a runtime dependency to a single-operator tool. **Their mechanics are adopted wholesale** — write-ahead logging, idempotency keys, leases, reconcile-on-resume, continue-as-new — just not their runtimes. |
| **Git history as the journal** | Rewritable, so not append-only in any enforceable sense. The run mutates the same repository, so run events would interleave with builder commits. A run must be able to journal without touching the target repo's history. **Retained fragment:** content-hashing the plan snapshot. |

---

## D2 — Specialist agent invocation

### Decision

**Every specialist is an independently dispatched session addressed by a durable handle, launched by
Miah itself, scoped by a Miah-composed packet — and independence is enforced as a predicate at the
acceptance gate, not asserted as a role label.**

**D2-a. Dispatch adapter contract.** A usable adapter must supply five capabilities: launch with an
idempotency key, status by handle, result retrieval by handle, cancel by handle, and **survival of
supervisor death**. Paseo supplies all five. A raw provider subprocess supplies four — it dies with
its parent — which is what disqualifies it as a primary adapter and is a checkable criterion rather
than a preference. v1 implements exactly one adapter (Paseo). The *contract* is documented so the
coupling is visible and testable; **no plugin system is built** — one implementation does not earn
an abstraction layer.

**D2-b. Results are file-based, not stream-based.** A specialist writes a schema-conforming result
envelope to a declared path; Miah reads it by path after termination. The durable reason is D1-d: a
streamed or returned result is lost if the supervisor is not alive when it arrives. (A Paseo-specific
symptom points the same way — `--output-schema` cannot combine with `--background` — but the
constraint stands even if Paseo removes that limitation.)

**D2-c. Independence, as six enforceable properties.**

1. **Separate dispatch, fresh context.** No specialist ever receives another specialist's transcript.
2. **Packet-scoped input.** A specialist receives objective, the unit's plan excerpt, output schema,
   authority bounds, and — for checkers — the harvested evidence pack. Never "read the whole plan."
   Authority may narrow down the chain, never broaden. (Precedent: the `ce-work` bounded unit packet,
   `docs/research/ecosystem-grounding.md` §1.)
3. **Maker narrative redacted from checkers** (mandatory). The builder's self-description of what it
   did never reaches the checker. The builder's agent id is also omitted, but as a cheap default with
   a weak effect — **the diff is authored, so this is not anonymity and must not be sold as such.**
4. **Distinct workspace.** A checker runs in a fresh worktree pinned to the unit's completion commit,
   not in the builder's working tree. This is deliberately stronger than the same-workspace reviewer
   pattern `docs/research/paseo-capabilities.md` documents, because a pinned commit makes the review
   reproducible later and makes the evidence pack self-contained.
5. **Cross-family model assignment.** A unit's checker runs on a different model family than its
   builder. Justified as a cheap hedge against self-preference bias, and by the operator's own
   standing preference (`docs/research/ecosystem-grounding.md` §2: audit is a "deliberate cross-family
   contrast from impl"). **It is not an accuracy guarantee** — see D2-d.
6. **Independence is recorded and checked at the gate.** Each dispatch journals role, provider and
   model family, workspace id and base commit, packet hash, and the ids of any dispatches whose
   output was included. Acceptance **refuses** a unit whose checker record shares a forbidden
   dimension with its maker record. This is the direct answer to the brief's observation that the
   substrate does not enforce independence: the substrate cannot, so the gate does.

**D2-d. A checker's authority to authorize completion comes from calibration, not from its family.**
Cross-family contrast makes a checker *different*; it does not make it *right*. A checker profile
earns verdict authority by clearing a calibration bar; until it does, its verdict is an input, not an
authorization. (Adopted from prior art — see below.) If no available profile clears the bar, the
affected criteria fall back to a lower grading tier — operator judgment — which is an **escalation**,
not a deadlock. `VISION.md` already mandates escalation when "operator judgment is missing."

**D2-e. Degradation fails loud.** When cross-family assignment or worktree isolation cannot be
satisfied, the dispatch still proceeds, but the acceptance record carries a `degraded-independence`
flag and the unit cannot be accepted at the top corroboration tier. Availability is validated
*before* dispatch, not discovered after.

**D2-f. Role catalog and authority.**

| Role | Authority | Notes |
| --- | --- | --- |
| Planner | Read-only on the repo; writes only its derived execution plan | May not touch scope, requirements, or acceptance criteria (`VISION.md`) |
| Builder | Write only inside its own unit worktree | No external side effects unless the plan authorizes them |
| Tester | Read and execute; writes confined to its own workspace | Runs in a fresh worktree at the unit's completion commit |
| Reviewer | Read-only everywhere | Consumes the evidence pack; emits typed findings and a verdict |

No fifth "judge" role is introduced. Grading against subjective criteria is the reviewer operating
with a calibrated binary rubric. Least toolset per role.

**D2-g. Delegation depth is 1 — specialists may not spawn specialists.** This needs active
enforcement, not just omission: `docs/research/paseo-capabilities.md` records that the operator's
daemon runs `daemon.mcp.injectIntoAgents: true`, which injects orchestration tools into every agent
Paseo launches. **The substrate's current default configuration violates this constraint**, so Miah
must scope or disable tool injection for specialist dispatches. Flagged for the planning session.

**D2-h. Placement and concurrency.** One worktree-isolated workspace per in-flight unit. Independent
units branch from the run base commit and may run in parallel under a concurrency cap; a dependent
unit branches from its dependency's completion commit. Concurrency cap and delegation-depth cap per
`docs/research/agent-orchestration-research.md` §2.8.

**D2-i. Monitoring is poll-by-handle at step boundaries**, not in-process streaming, because Miah may
not be alive. Budget predicates are evaluated before dispatch and on each poll. Evidence is harvested
by Miah from the workspace and the adapter — diffs, exit codes, result files, usage deltas — never
from the agent's prose.

**D2-j. The retry unit is the unit, not the agent turn.** On re-dispatch after an agent death, Miah
records the abandoned attempt's diff as evidence, then resets the unit workspace to its base commit.
Nothing is silently discarded, and at-least-once execution does not compound partial work. Every
result must be attributable to a specific dispatch attempt (adopted from prior art — see below).

**D2-k. Context freshness is mandatory for checkers, default-but-relaxable for builders.** A blanket
"fresh context everywhere" rule is more expensive than the evidence supports. Independence is a
property of the *checking* side; a builder carrying context across dependent units is cheaper and
often better informed. The relaxation must be recorded on the dispatch record when used.

### Alternatives considered and rejected

| Alternative | Why rejected |
| --- | --- |
| **In-harness native subagents** (Task-tool style) | Die with the parent session, which violates D1-d directly. Single-provider, so cross-family assignment is impossible. Results are conversational, not durable artifacts. No durable handle to reconcile against. |
| **One long-lived agent per role, reused across units** | For checkers: unit N's reviewer would have seen unit N−1's review, which falsifies the fresh-context claim outright, and context accumulates (`agent-orchestration-research.md` §2.2, pollution and lost-in-the-middle). Rejected for checkers absolutely. **Partially adopted for builders** as D2-k, because the contamination argument is much weaker there and the token-cache saving is real. |
| **Miah as a lead agent delegating through Paseo's packaged skills** (`paseo-handoff`, `paseo-loop`) | Same failure as D1's agent form. Additionally, those are user-facing workflows with their own opinions about briefing and looping — useful patterns, not a dispatch contract Miah can hold invariants against. |
| **Independence by prompt instruction** ("do not trust the builder's claims") | Named explicitly because it is the tempting cheap version. `agent-orchestration-research.md` §2.4 is direct: prompted critique without external ground truth is unreliable, and a shared-context critique approximates self-correction. It is also unauditable — there is no record that the instruction had any effect. |
| **Same-workspace reviewer with fresh context** (Paseo's documented pattern) | Insufficient rather than wrong: it does not pin the artifact, can be polluted by uncommitted state, and is not reproducible later. **Kept as the fallback** when worktree isolation is unavailable, recorded as `degraded-independence` per D2-e. |
| **A different model family for every role** | Over-constrained. The requirement is maker ≠ checker *per unit*; forcing planner, builder, tester, and reviewer onto four families multiplies cost and provider risk with no supporting evidence in the research. |
| **A pluggable adapter framework in v1** | Rejected on carrying cost. One implementation does not justify a plugin system; the documented five-capability contract captures the value (it names what dispatch must guarantee) without the machinery. |

---

## Cross-check against prior art

Read only after the above was drafted and frozen (frozen draft: `tmp/brainstorm-1-draft-pre-crosscheck.md`, git-ignored).

### Agreements — corroboration, arrived at independently

| Prior-art decision | Our decision | Note |
| --- | --- | --- |
| #1 "A prompt template cannot own durable execution state; the supervisor needs repo-owned execution authority that survives session loss" | D1 (standalone program) | Same rationale, reached independently. Divergence on form — see C3. |
| #5 "Supervisor is the sole state authority; concurrent and self-reported transitions disallowed" | D1-e, D1-h lease, D2-i | Corroborates both the single-writer lease and evidence-not-self-report. |
| #6 "Append-only journal with derived status. Paseo never leads run state" | D1-a, D1-f, and the "ride Paseo" rejection | Strong corroboration of the rejection, from a team that had built against Paseo. |
| #7 "Independent audit required for completion; agent termination does not prove the step is correct" | D1-e, D2-c | — |
| #10 "Fail closed on uncertainty or resume conflict" | D1-h | Sharpened by adoption below. |
| Result contract: "Paseo is the control plane, not a result transport… never parse logs or trust a worker's final sentence" | D2-b | **The strongest corroboration in the cross-check.** Two independent routes to the same mechanism — we derived file-based results from detachable dispatch, they derived it from a control-plane/result-plane split. |
| Sidecar principle: "observation-only… no worker-authored checkpoints" | D2-i | Principle agreed; the *form* is contested — see C2. |
| Re-entry protocol: "replay journal, reconcile against agent inspect, determine next safe transition" | D1-a, D1-d, D1-f | — |

### Prior-art adoptions

Each line is something we did **not** have and are taking, with its justification. Nothing below was inherited silently.

- **prior-art adoption — out-of-tree, owner-only control store (D1-g).** Our draft put the run directory inside the target repo; a builder with write access to the tree could then modify the append-only journal, destroying the integrity property the whole design rests on.
- **prior-art adoption — results must be attributable to a specific dispatch attempt (D2-j).** A terminal lifecycle proves the process stopped, not that a result exists, is complete, or belongs to *this* attempt; without attribution, a stale result file from a prior take is admissible evidence.
- **prior-art adoption — checker verdict authority requires calibration, not just cross-family contrast (D2-d).** Prior art found cross-family contrast alone insufficient, which corrects an overstatement our draft had inherited from the ideation document.
- **prior-art adoption — fail closed when authority, budget, or resume state is unclear (D1-h).** A supervisor that guesses cannot claim evidence-based acceptance.
- **prior-art adoption — validate the run's safety and provider configuration before dispatch (D2-e).** Independence properties that cannot be satisfied must be known before an agent is launched, not discovered at the gate afterwards.
- **prior-art adoption — verified Paseo CLI contracts as planning input.** `paseo agent stop` (not `agent cancel`), `LastUsage` PascalCase fields, usage accounted by deltas between snapshots. Factual reference that saves rediscovery; **must be re-verified against daemon v0.3.0-beta.1**, since it was captured against v0.2.3.

### Conflicts

C1 is resolved by document authority; C2 and C3 were put to the operator and settled on 2026-08-06.

**C1 — Sequential-only v1.** Prior art decision #3 defers concurrency entirely. `VISION.md` mandates
the capability in three places: run step 2 ("identifies work that can safely run in parallel"), the
escalation boundary ("Miah must continue unrelated implementation units"), and the
progress-preserving success criterion. **Resolved toward VISION, which governs:** the architecture is
parallel-capable (D2-h). *Recommendation:* ship v1 with the concurrency cap defaulting to 1, so the
mechanism exists and is exercised while the first runs stay simple. Recorded as a conflict because
prior art deferred it deliberately, and the digest itself flags it for re-examination.

**C2 — Mandatory persistent observer sidecar.** Prior art requires a per-run observer process that
outlives the supervisor session and is required for run admission. This conflicts with D1's
no-extra-process shape. The honest accounting: because Paseo's `LastUsage` is cumulative per agent, a
snapshot at dispatch and another at the next poll yields correct totals across any gap — **the
sidecar buys timeliness of intervention, not correctness of accounting.** **Resolved by OP-1:**
because a looping driver ships, the driver *is* the observer, so the mandatory sidecar is rejected
for v1. Damage from a dispatch made while no driver is up is bounded by adapter-level per-dispatch
deadlines, so an unobserved agent cannot run forever. The sidecar's *principles* (observation-only,
no worker-authored checkpoints) are adopted; only its persistent-process form is declined.

**C3 — Who drives the supervisor.** Prior art's supervisor dispatches and returns control to the
operator, who resumes it later; ours can also loop unattended under a scheduler. Our reading of
prior art's "command plus reusable skill" is that the command is the step function and the skill is
one driver — in which case the two designs agree on structure and differ only on whether a non-agent
driver ships in v1. **Resolved by OP-1 in favour of shipping the driver**, so Miah diverges from
prior art here deliberately and with the operator's decision on record.

**C4 — Subscription-only provider class (prior art #8, #13).** Not a conflict — our draft took no
position on cost metering — but a real constraint on D2's model assignment, since it narrows the
checker pool. Forward-referenced to D7; noted here because it interacts with D2-c.5.

---

## Adversarial pass

Run against the drafted decisions, probing specifically for convergence that was assumed rather than
earned. **Method caveat:** the `anti-sycophancy` skill named in the brief is not installed on this
machine, so this pass ran in the same context that produced the decisions. Its agreement is therefore
**not independent corroboration** — a genuinely independent pass would still be worth running, and
the findings below are the ones a same-context probe can reach.

**A1 — The "stateless interpreter" convergence is near-total, and partly unearned.** Four of six
ideation frames, prior art #6, the durable-execution literature, and this session all land on it. The
falsifying test is whether any supervisor decision depends on information the journal cannot hold.
One does: **no-progress detection is not journal-derivable across supervisor downtime.** The journal
cannot distinguish "the agent hung for three hours" from "Miah was dead for three hours." Neither the
ideation document nor prior art states this. It does not overturn D1, but the claim must be stated
with the exception attached. Resolution belongs to D7; the constraint originates in D1.

**A2 — "Resume is the only code path" is a slogan that hides work.** A cold start must acquire the
lease, replay, and reconcile; a warm loop iteration should not repeat that every tick, so any real
implementation will cache — and the cache is a second code path. The one-path property is therefore
**enforced by a test, not by the design**. This promotes the ideation document's `miah drill` (kill
the supervisor mid-run, assert identical continuation) from a nice ritual to the single artifact that
keeps D1's central claim true.

**A3 — The ideation document oversells cross-family model assignment.** Survivor #5 presents "a
deliberately different model family" as an independence mechanism. The research supports it as a
hedge against self-preference and correlated error; it does not show it produces correct verdicts.
Prior art reached the same correction independently (#9). D2-d now states it explicitly. Also
recorded: a fresh worktree per checker costs disk and checkout time on a large repo, so review over
a pinned diff without a full worktree should be a tunable, not an afterthought.

**A4 — The CLI decision needed a better argument than the one it had.** "LLM control loops are
non-deterministic" does not survive steelmanning: a skill that journals every decision before acting
and calls deterministic gates is defensible, ships in a day, and gets Paseo's operator UI for free.
The argument that *does* survive is **auditability of omission** — a journaled loop records what it
did and cannot record what it failed to do. D1 now leads with that. The honest cost is also recorded:
this is substantially more to build than a skill, in a repo with zero code.

**A5 — Paseo-as-adapter sits inside a strong environmental anchor.** Every research file, the
operator's preferences, and prior art's name are Paseo-shaped. The conclusion survives, but only
because of the five-capability contract in D2-a, not because of familiarity. Two dependency risks now
belong on the record rather than in a footnote: Paseo is v0.3.0-beta.1 with CLI contracts that have
already changed once, and **if the daemon is down, Miah cannot dispatch at all** — a hard
availability coupling.

**A6 — The independence record is Miah checking its own bookkeeping.** D2-c.6 sounded stronger than
it is: properties 1–5 are dispatch-time settings, and property 6 verifies the record of those
settings, which Miah wrote from its own intent. That catches bugs and config drift — real value — but
it is not independent verification. **Improvement adopted:** derive as much of the record as possible
from *observation* rather than intent — the provider and model the adapter reports as having actually
run, the base commit read from git — so the record is partly evidence rather than wholly self-report.
The same principle Miah applies to specialists, applied reflexively to Miah.

**A7 — The blanket fresh-context rule was too expensive for its evidence.** Split into D2-k: mandatory
for checkers, default-but-relaxable for builders.

**A8 — File-based results were reasoned from the wrong constraint.** The draft justified them by
Paseo's `--output-schema` / `--background` incompatibility, which is a symptom. The durable reason is
detachable dispatch (D1-d): a returned result is lost if the supervisor is dead when it arrives.
D2-b now states the reason that survives a Paseo change.

**A9 — Over-build check.** A shell script that runs units sequentially, dispatches in the background,
appends JSONL, and stops on failure is perhaps 300 lines. Each increment above it — parallelism,
enforced independence, crash resume, evidence-based acceptance — is mandated by `VISION.md`, not
chosen for interest. That check passes, but it carries a warning for the planning session:
`agent-orchestration-research.md` §1.2 advises starting at the lowest complexity that reliably meets
the requirement, and the failure mode here is **a v1 with a complete spine and no completed runs**.
Sequence so an end-to-end run exists early with each mechanism thin, rather than finishing the spine
first.

**A10 — The unexamined assumption nobody caught.** D2's entire independence mechanism is
**code-shaped**: worktrees, commits, diffs. `VISION.md` and `STRATEGY.md` never say the supervised
work is code, and the CE plan format carries `execution: code | knowledge-work`
(`docs/research/ecosystem-grounding.md` §1). The ideation document, prior art, and the frozen draft
all missed this. **Recorded as an explicit assumption, not decided:** v1 is scoped to
`execution: code` plans. Whether Miah supervises knowledge-work plans is an operator scope question
that belongs with D3.

---

## Open items for the operator

**OP-1 (D1, from conflict C3) — SETTLED 2026-08-06.** The operator confirmed that **v1 ships a
non-agent driver**: `miah run` loops under a terminal, cron, or a Paseo schedule, so a run advances
while the operator is away. Two consequences are now fixed rather than provisional — the running
driver is the budget observer (closing C2 against prior art's mandatory sidecar), and Miah diverges
from prior art's poke-driven shape by operator decision rather than by our preference.

The rejected alternative, for the record: *poke-driven only* — Miah advances one step per invocation
and returns. Much less to build and naturally rate-limited, but nothing progresses unattended and the
observer sidecar becomes necessary again for budget timeliness. It remains a strict subset of what
ships, so the step function is unaffected either way.

**OP-2 (D2/D8) — is Paseo a hard dependency of v1, or a default adapter behind the documented
contract?** We built to the second reading (D2-a) while implementing only the Paseo adapter, which
keeps the coupling visible without paying for a plugin system. Confirm, given A5's dependency risks.

---

## Forward references — noted, not decided

- **D3 (plan input format)** — the snapshot must be content-hashable; units need stable IDs,
  `depends-on`, and per-criterion grading tiers for D1-e's acceptance predicate to be decidable. A10
  raises whether `execution: knowledge-work` plans are in scope at all.
- **D4 (journal and state schema)** — run directory layout, event types, lease format, attempt/take
  numbering, snapshot-plus-WAL cadence. D1-g fixes only that the control store is out-of-tree and
  owner-only. A2's kill drill belongs to D4's acceptance.
- **D5 (evidence contract)** — evidence pack composition, result envelope schema, the grading ladder,
  custody, and the calibration corpus D2-d requires. Whether tester-authored test code becomes part
  of a unit's deliverable is a D5/D3 question, not a D2 one.
- **D6 (operator interface)** — `miah status` and `miah stop`; cancel must be a journaled record, not
  a signal, or it is lost across a restart. With OP-1 settled, how the operator starts, schedules,
  and stops the looping driver is D6's to specify.
- **D7 (thresholds and limits)** — budget predicates at step boundaries; per-dispatch deadlines
  (C2's mitigation); concurrency cap default (C1's recommendation); no-progress thresholds, with
  A1's downtime ambiguity as an explicit input; C4's provider-class constraint.
- **D8 (tech stack and delivery)** — constrained by D1 to a single executable with no background
  service, running where the repo is. The operator's machine is Windows 10 with Git Bash, so worktree
  handling, file locking for the lease, and path semantics are Windows-first concerns.
- **D9 (plan preflight)** — a pure function over plan plus workspace fits the D1 stateless shape
  exactly; admission calls it before acquiring the lease.

## Assumptions recorded

1. v1 supervises `execution: code` plans only (A10). Not decided — flagged for D3.
2. The operator's Paseo daemon remains the dispatch substrate on the target machine (A5).
3. Paseo CLI contracts carried from prior art are stale by one minor version and need re-verification.
