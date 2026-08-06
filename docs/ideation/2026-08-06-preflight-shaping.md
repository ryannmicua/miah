# Preflight shaping — discussion notes

> **Status:** discussion input, not a decision. Captured from an operator session on 2026-08-06 while reviewing `docs/ideation/2026-08-05-open-ideation.html`. Recorded here rather than in `docs/planning-brief.md` so it carries no brief-level authority — D9 is still open, and the directions below should compete with alternatives during Brainstorm 2, not frame it.

## Where this came from

Reviewing the 2026-08-05 open ideation run, every one of the seven survivors concerned the *run*: how it survives a crash, how evidence is corroborated, how operator attention is spent, how an approved plan is amended when reality drifts. None addressed the case where the plan was simply **unexecutable as written** — not stale, wrong at approval time — and the operator learns this at unit 9 rather than unit 2.

`VISION.md` already requires this: run step 1 is "validate the plan for executability." The brief's D3 already gestures at "the executability-validation rules." So this is not new scope. What was missing was a shape.

## The candidate shape

A `miah preflight <plan>` command: a pure function over plan plus workspace, requiring no run state, no lease, and no dispatched agents.

Three candidate checks, all deterministic:

1. **Structural** — every unit has an ID and at least one acceptance criterion; dependency references resolve; the graph is acyclic.
2. **Referential** — every path or artifact a unit names either exists now, or is declared as an earlier unit's output.
3. **Verifiability** — every acceptance criterion declares a grading tier (deterministic / judge / human). Not *does it pass*, only *is it gradeable, and by what*.

Two callers, one implementation: the operator runs it while drafting, and admission runs it before acquiring the lease.

## The recurrence question

The observation that produced D9's final open sub-question:

Preflight validates the plan against the workspace **as it is at admission** — but the workspace is exactly what the run changes. Every check therefore has a shelf life. A unit that passed at admission may be unexecutable by the time its turn arrives, because an earlier unit did not produce what it promised.

This suggests, but does not settle, running the same function again at a smaller scope:

| When | Scope | Failure means |
| --- | --- | --- |
| Drafting | Whole plan | Fix the draft — free |
| Admission | Whole plan | Refuse; re-submit a new snapshot |
| Pre-dispatch | One unit | The plan has gone stale |

If the third row is adopted, it supplies something survivor 4 of the 2026-08-05 run lacked: a **mechanical trigger for the change-order path**. A pre-dispatch preflight failure is not a bug and not a judgment call — it is a deterministic signal that reality has diverged from the approved plan, which is precisely the condition an amendment exists for.

## The postflight mirror

If units must declare what they create for referential checking to work, that declaration can also be asserted after the unit finishes: did it actually produce what it declared?

That would separate two failures which would otherwise both reach a reviewer:

- **Mechanical** — the artifact is not there. Deterministic, cheap, no reviewer needed.
- **Judgment** — the artifact is there and is wrong. Requires the evidence contract and a corroborator.

Keeping them apart means the expensive path is never spent on a unit that simply did not do the thing.

## Alternatives that deserve a fair hearing

The directions above are cohesive, which is what makes them risky to record — they may be hard to argue with in session even if a better answer exists. Explicitly on the table:

- **One-time gate only.** Preflight runs at admission and nowhere else; staleness is caught by acceptance, not by re-checking.
- **Postflight subsumes pre-dispatch.** If every unit's outputs are asserted on completion, a later unit's preconditions are already guaranteed, and the pre-dispatch check is redundant machinery.
- **A standing precondition contract.** Preconditions are a first-class field the supervisor evaluates, rather than a re-scoped run of the plan checker.
- **No `creates:` field.** Referential checking is scoped to paths that exist at admission, and forward references are simply out of scope — a smaller, weaker, much cheaper check.

## Unresolved

- If pre-dispatch preflight is adopted: does failure pause only that unit and its dependents (consistent with `VISION.md`'s escalation boundaries), or halt the run on the theory that a stale plan is stale everywhere? The vision's existing mandate points to the former, but it should be decided deliberately rather than inherited.
- Whether `creates:` becomes a required plan-format field is a **D3** decision. D9 depends on D3; it must not dictate to it.

## Scope limit worth keeping in view

Preflight catches *unexecutable*, not *wrong*. A plan whose units all have IDs, whose graph is acyclic, whose paths all resolve, and whose criteria all declare a grading tier can still build the wrong thing in the wrong order. Preflight will admit it. The judgment half of plan quality stays where it already is — with the operator, at the approval gate — and a green preflight should not be allowed to feel like more assurance than it is.
