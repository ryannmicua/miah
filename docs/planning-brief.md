# Miah Planning Brief

> Input for Phase 2 brainstorming and planning sessions. This brief frames the open decisions standing between the approved vision and an implementation-ready plan. It decides nothing — every item below is an operator decision to be made during brainstorming/planning.

**Grounding:** `VISION.md` (canonical), `STRATEGY.md` (derived). Both were reviewed on 2026-08-05 and are consistent. If anything in this brief appears to conflict with `VISION.md`, the vision governs.

## Purpose

The vision defines *what Miah is*: a resumable supervisor that directs one immutable approved plan through specialist agents (planner, builders, testers, reviewers) with durable evidence, bounded autonomy, escalation gates, and operator approval. It deliberately stays product-level. Every technical decision is still open, and a plan cannot be implementation-ready until the decisions below are made.

Use this brief to drive a `ce-brainstorm` session (settle the architecture-shaping decisions, especially D1–D2) and then `ce-plan` (produce the plan in `docs/plans/`).

## Already decided — do not re-litigate

From `VISION.md`; these are constraints on any design, not open questions:

- One active approved plan at a time; each run locked to an immutable plan snapshot
- Append-only run journal; workflow state, evidence, statuses, and handoffs durable and filesystem-based
- Miah coordinates but never implements, tests, or reviews itself
- Builders, testers, and reviewers are distinct roles; testing and review are independent of implementation
- Escalation blocks only the affected dependency chain; independent units continue
- Operator gates: execution start, escalated decisions, final completion
- Miah cannot change approved scope, requirements, or acceptance criteria

## Open decisions

Ordered by dependency — D1 shapes everything below it.

### D1. Runtime and form factor

**Question:** What *is* Miah, concretely? An OpenCode agent/skill, a standalone CLI, a long-running daemon, a library, something else?

**Why it matters:** This is the decision everything else hangs on. It determines how Miah survives crashes (the "resumable" promise), how it runs long enough to supervise a full run, how the operator talks to it, and what "spawning a builder" even means.

**Feeds:** D2, D3, D6, D8.

**Tension to resolve:** Miah must outlive or recover from the death of any single agent session (VISION: resumable), yet agent harnesses are typically session-bound. Where does the durable supervisor loop actually live?

### D2. Specialist agent invocation

**Question:** How are planners, builders, testers, and reviewers created, scoped, and monitored? Subagents within one harness? Independently dispatched sessions? Separate processes? Which harnesses/models per role?

**Why it matters:** Independence of testing and review (VISION: constraint) is only real if the mechanism enforces it — a tester that shares the builder's context is not independent. Parallel execution of independent units also depends on what dispatch primitive exists.

**Feeds:** D5 (what evidence agents can emit), D7 (how limits are enforced per agent).

### D3. Plan input format

**Question:** What does an "approved plan" look like as an artifact Miah can validate and execute? Is it the CE unified-plan convention (already the Phase 2 output format per `AGENTS.md`), or something Miah-specific?

**Why it matters:** Step 1 of every run is "validate the plan for executability" — impossible to specify without knowing the plan's structure. Also determines what "immutable snapshot" means mechanically (copy? hash? git ref?).

**Feeds:** D4 (journal references plan units), the executability-validation rules.

### D4. Journal and state schema

**Question:** What is the concrete filesystem layout and format of the append-only journal and workflow state? What are the entry types (decision, handoff, escalation, acceptance, rework...)? How does resume-from-crash actually reconstruct state?

**Why it matters:** This is the core of resumability, auditability, and observability — three of the nine success criteria. It's also the hardest thing to retrofit.

**Feeds:** D5, D6.

### D5. Evidence contract

**Question:** What must builders, testers, and reviewers produce for their work to count? What makes evidence "durable" and sufficient — file formats, required fields, where it lives relative to the journal?

**Why it matters:** Acceptance decisions (run step 7) and the final evidence package (step 9) are only as good as the evidence contract. STRATEGY's proof-completeness-rate metric is measured directly against this.

### D6. Operator interface

**Question:** How do approvals, escalations, and status checks happen? Terminal prompts, watched files, notifications, a status command? How does the operator stop a run?

**Why it matters:** VISION requires the operator to see run status and resource use without constant supervision (STRATEGY: operator touch time). Escalations must reach an operator who may not be watching.

**Depends on:** D1.

### D7. Thresholds and limits

**Question:** Concrete cost, time, retry, and severity values — per unit and per run. What counts as "repeatedly fails" or "no meaningful progress"?

**Why it matters:** `VISION.md` explicitly defers these to implementation planning (its final constraint). They bound Miah's autonomy; without them, escalation rules are unenforceable.

**Note:** Likely operator-configurable with defaults; planning must at least fix the mechanism and defaults.

### D8. Tech stack and delivery shape

**Question:** Language, dependencies, test approach, and how Miah is installed/run in a target repo.

**Why it matters:** The repo has no code; this decision gates Phase 3 entirely.

**Depends on:** D1, D2.

## Prior art handling (staged context — operator-set, do not weaken)

A direct predecessor of Miah exists: the heypogi "Paseo Plan Execution Supervisor" (planned 2026-07-28, implementation-ready, never built). The operator deliberately keeps it out of brainstorming context so Miah's decisions are made on standalone research, not anchoring.

1. **Brainstorming runs without prior-art context.** Research inputs are the three files in `docs/research/` — `ecosystem-grounding.md` points to prior art but does not summarize its decisions. The full digest (`research/prior-art-paseo-supervisor.md`) is marker-staged: open only at step 2.
2. **Cross-check phase — after decisions are drafted, not before.** Read the staged digest, then compare decision by decision against our drafted decisions. Agreement = corroboration; disagreement = a conflict to resolve deliberately with the operator.
3. **Adversarial check.** After the cross-check, run the `anti-sycophancy` skill against the drafted decisions, explicitly probing for convergences that are unexamined rather than earned.
4. Anything adopted from prior art is recorded as `prior-art adoption` with a one-line justification in the plan. The plan must never silently inherit prior-art decisions.

## Suggested session sequencing

1. **Brainstorm 1 — form factor and agent model (D1, D2).** Highest leverage, most constrained by the resumability requirement. Exit with a decided architecture direction.
2. **Brainstorm 2 — artifacts (D3, D4, D5).** Plan format, journal schema, evidence contract. These three must cohere with each other.
3. **Planning session — everything to a unified plan (D6, D7, D8 resolved along the way).** Output to `docs/plans/`, operator approves, AGENTS.md advances to Phase 3.

Sequencing is a suggestion; the operator may reorder or merge sessions.

## Exit criteria for this brief

This brief is spent when an approved implementation plan exists in `docs/plans/` that answers D1–D8 (or explicitly defers a decision with the operator's consent). At that point, archive or delete this brief — the plan supersedes it.
