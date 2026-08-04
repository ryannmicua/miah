---
name: Miah
last_updated: 2026-08-03
---

# Miah Strategy

> Derived from `VISION.md`, the canonical product definition. If the documents conflict, `VISION.md` governs.

## Target problem

Operators directing multiple specialist agents cannot keep up with the supervision needed to ensure work is faithful, reviewable, and acceptable. Agents can drift, lose progress, accept weak results, stall, or fail without leaving enough trustworthy evidence for the operator to judge the outcome.

## Our approach

Miah wins by narrowly supervising one immutable approved plan through role-separated agents, durable evidence, and explicit authority gates, rather than becoming another implementation agent or general-purpose orchestrator.

## Who it's for

**Primary:** Engineers, technical leads, and operators who direct AI agents to perform real work and remain accountable for the outcome. The operator responsible for an approved plan uses Miah to produce reviewable, auditable, evidence-based output and judges whether the result is acceptable.

## Key metrics

- **First-pass approval rate** - The share of completed runs the operator accepts without sending the whole plan back for rework; measured from final approval decisions in the run journal.
- **Operator touch time** - The operator's active supervision time per approved run; measured from approval and escalation interactions.
- **Plan drift rate** - The share of implementation units that attempt or exhibit unauthorized changes to scope, requirements, or acceptance criteria; measured from escalations and review findings in the run journal.
- **Proof completeness rate** - The share of completion claims backed by the required implementation records, independent test results, and review findings; measured from run evidence.

## Tracks

### Plan-faithful orchestration

Turn an approved plan into bounded work while preventing drift from its scope, requirements, and acceptance criteria.

_Why it serves the approach:_ It makes the immutable approved plan the controlling authority for execution.

### Durable execution and recovery

Preserve workflow state, evidence, decisions, and completed progress across interruptions.

_Why it serves the approach:_ It makes supervised work resumable and prevents progress or accountability from disappearing.

### Independent assurance

Keep building, testing, and review responsibilities separate so acceptance rests on credible proof.

_Why it serves the approach:_ It prevents implementation claims from being treated as sufficient evidence of correctness.

### Operator control and visibility

Make status, escalations, resource use, and approval decisions clear without requiring constant supervision.

_Why it serves the approach:_ It reduces the operator's workload while preserving their authority over consequential decisions.

## Not working on

- Exploring ideas or authoring the source plan.
- Performing implementation, testing, or review work itself.
- Becoming a general-purpose multi-project or multi-run orchestration platform.

## Marketing

**One-liner:** Miah directs one approved plan at a time from executable plan to verified completion, coordinating specialist agents while preserving operator control and a durable record of the work.
