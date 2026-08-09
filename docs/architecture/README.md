---
mode: tutorial
verified: 2026-08-09
---

# Miah Architecture Documentation Set

> This set describes the **current design** of Miah v1 — what the system does, how it is shaped, why it is shaped that way, how the primary flow works end-to-end, and what to touch when the design changes. It is a **tutorial-style orientation hub**: it guides a reader into the set and tells maintainers what to keep current. It is not a user guide, not a problem-history store, and not a code review.

## What this set covers

Miah is a resumable plan supervisor CLI that coordinates specialist agents to execute one immutable approved plan, with durable disk-first evidence, bounded autonomy, and operator approval gates. Every architectural claim in this set carries a verified code citation (`src/...:NNN`) and/or a design-authority citation (`PLAN:Rnn` / `PLAN:KTDn` / `ADR:Dn`), checked against the tree.

## Reading paths (choose by what you want)

The set is written in four Diataxis quadrants. Each file is labeled with its mode. Pick a path:

| I want to... | Read | Quadrant |
|---|---|---|
| Understand the system in one screen | [system-overview](./system-overview.md) | **explanation** |
| Understand why the design decisions were made | [design-decisions](./design-decisions.md) | **explanation** |
| Understand how the run-phase state machine works | [state-machine](./state-machine.md) | **explanation** |
| Understand a load-bearing mechanism | [journal-and-recovery](./journal-and-recovery.md), [dispatch-and-isolation](./dispatch-and-isolation.md), [evidence-and-acceptance](./evidence-and-acceptance.md), [admission-and-preflight](./admission-and-preflight.md) | **explanation** |
| Look up exact values — phases, transitions, events, exit codes | [state-machine-reference](./state-machine-reference.md) | **reference** |
| Look up the data model, config fields, and security guarantees | [data-and-security](./data-and-security.md) | **reference** |
| Change something (add an event, command, or config field; run tests) | [maintenance-guide](./maintenance-guide.md) | **how-to** |
| Orient (you are here) and maintain the set | this `README.md` | **tutorial** |

One mode per file; where a topic needs two modes, the set splits it (e.g. the state machine has an explanation and a reference companion).

## Authority hierarchy

When documents disagree, the higher authority wins; the lower document is wrong, not the higher one.

| Rank | Authority | Role |
|---|---|---|
| 1 | `VISION.md` | canonical product definition; governs product behavior |
| 2 | `docs/plans/2026-08-06-003-miah-implementation-plan.md` | approved design authority for implementation (R1-R90, D6-D8, KTD1-18); supersedes-reconciles both brainstorm artifacts and the D1/D2 ADR |
| 3 | `docs/decisions/2026-08-06-d1-d2-runtime-and-agent-invocation.md` | historical decision record (D1/D2 carried forward into the plan as R1-R21) |
| 4 | `src/` (the code) | the current design as enforced; when this set and the code disagree, the set is wrong |
| 5 | This documentation set | lowest authority; carries citations so disputes resolve quickly |

`CONCEPTS.md` is the **vocabulary** authority: this set uses its terms exactly (`Run-phase FSM`, `AwaitingApproval`, `Approval package`, `Config snapshot`, `Kill drill`, `G-criteria`, `Cross-family verifier`, `Gap`, `Custody chain`, `dispatch.default_workspace`) and never invents terms.

## Boundary table — relationship to other documentation

| Documentation | Location | Boundary rule |
|---|---|---|
| **Current design** (this set) | `docs/architecture/` | States how the system is now; the lookup surface for design |
| **Problem history** (patterns store) | `docs/solutions/patterns/` | Incidents, root causes, and fixes; this set states the current design and **links** to the history, never re-narrates it |
| **Design origin** (plan + ADR) | `docs/plans/`, `docs/decisions/` | Approved intent; this set distills decisions and cites `PLAN:`/`ADR:` anchors rather than restating requirements |
| **Frozen authority** | `VISION.md`, `STRATEGY.md`, `CONCEPTS.md` | Product definition, derived strategy, and vocabulary; this set never restates product behavior or introduces scope |
| **Operator-facing usage** | [`OPERATOR.md`](../../OPERATOR.md) (repo root) | The operator manual starting point: prerequisites, plan format, command sequence, operator decisions; this set states the current design, the manual is the usage entry point |
| **Session records** | `docs/session-digests/` | Prior-session narrative; out of scope for this set |

## Last-verified convention

Every file's frontmatter carries `verified: YYYY-MM-DD`. When a maintainer re-verifies citations against the tree, update the date. A `verified` date older than the last tree change means the file needs re-verification. Procedure: [maintenance-guide](./maintenance-guide.md#how-to-re-verify-this-documentation-set).

## Maintenance rules

The set stays current only if maintainers know what to touch. When a change lands, update:

| Change | Touch | Also check |
|---|---|---|
| A dated operator decision changes a design value (path, cap, rule, term) | `design-decisions.md` — update the affected decision's status line | Record the supersession **first** per the repo governance convention (dated decision digest before edits; name what is superseded; leave historical records historical); link the digest in `design-decisions.md` §Supersessions |
| The state machine changes | `state-machine.md` + `state-machine-reference.md` | `system-overview.md` (invariants 1/4/8), `design-decisions.md` §23, `data-and-security.md` (event types) |
| The schema / data model changes | `data-and-security.md` | `design-decisions.md` (versioning/bounds decisions); a frozen surface (packet, envelope, custody) requires a new surface version, not an edit, per the plan |
| New commands/flows land | `system-overview.md` (flow + layer descriptions) | `state-machine-reference.md` (exit codes/outcomes); README scope table |
| Config thresholds change | `data-and-security.md` (config table) | `design-decisions.md` §24; `maintenance-guide.md` if defaults shifted |
| A new journal event type is added | `state-machine-reference.md` (event table) | `maintenance-guide.md` procedure; `replay.ts` if it folds derived state |
| Tests change around a documented invariant | verify the invariant's citation still resolves | update `verified` dates in every file citing it |

## Conflict log

Rows are added here whenever a genuine contract/plan/code disagreement surfaces during maintenance. Documenting a conflict is a maintenance task; **resolving** it is a separate, operator-gated decision.

| Date | Conflict | Resolution task |
|---|---|---|
| — | (none recorded) | — |

## Scope boundary

This set documents the current design of Miah v1 (`docs/architecture/`). It does not propose redesigns, flag code-quality issues (unless they contradict a documented decision — that is a conflict-log entry), or duplicate operator-facing guides. When in doubt about whether a topic belongs here, ask the operator.
