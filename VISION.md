# Miah: A resumable plan supervisor

> Miah directs one approved plan at a time from executable plan to verified completion, coordinating specialist agents while preserving operator control and a durable record of the work.

## Problem

Planned work often requires several agents with different responsibilities: planning execution, building, testing, and reviewing. Without supervision, agents can drift from the approved plan, lose progress, accept weak results, stall, or fail without leaving a trustworthy account of what happened.

Miah exists to make agent-executed work controlled, resumable, observable, and verifiable.

## Who it's for

Miah is for engineers, technical leads, and operators who direct AI agents to perform real work and remain accountable for the outcome.

The operator approves the plan, handles decisions outside Miah's authority, and decides whether the final result is complete.

## What Miah does

Miah supervises the execution of an approved plan. It coordinates specialist agents but does not perform implementation work itself.

A run proceeds as follows:

1. **Validate the plan.** Miah reviews the approved plan for executability. If the plan cannot be executed, Miah stops and returns its findings without changing the plan.
2. **Prepare execution.** A planner derives sequencing, dependencies, and bounded implementation units. It identifies work that can safely run in parallel.
3. **Protect approved intent.** Derived execution details may clarify how the plan will be carried out, but changes to scope, requirements, or acceptance criteria require operator approval.
4. **Delegate implementation.** Builders execute scoped implementation units and continuously leave durable evidence of their work.
5. **Test independently.** Testers evaluate completed work independently from the builders.
6. **Review independently.** Reviewers or auditors assess the output, evidence, and conformity with the approved plan.
7. **Accept or rework.** Miah evaluates the available evidence and decides whether each unit is acceptable. It may direct bounded rework using planners and builders.
8. **Escalate without blocking unrelated work.** When a decision exceeds Miah's authority, it pauses the affected implementation unit and any work that depends on it. Independent units continue when they can proceed safely. Miah pauses the entire run only when the issue affects the plan as a whole or no executable work remains.
9. **Request final approval.** Miah presents a consolidated evidence package to the operator. If the operator rejects the result, Miah asks whether to end the run or begin bounded rework.

The operator approves execution before work begins, resolves escalated issues, and approves final completion. Routine intermediate decisions remain with Miah.

## Escalation boundaries

Miah must escalate when:

- Approved scope, requirements, or acceptance criteria would need to change.
- Evidence reveals a serious security, privacy, legal, or data-loss risk.
- An action would be destructive, irreversible, or produce an external side effect not authorized by the plan.
- Testing or review identifies an unresolved high-severity failure.
- Rework repeatedly fails or agents stop making meaningful progress.
- Required access, credentials, information, or operator judgment is missing.
- Continuing would exceed an operator-defined cost, time, or retry limit.

An escalation blocks only the affected work and its dependency chain. Miah must continue unrelated implementation units when doing so remains within the approved plan and does not create additional risk.

Miah may autonomously handle routine sequencing decisions, bounded rework, and ordinary disagreements among specialist agents.

## What success looks like

- **Executable:** Work begins only when the approved plan can be carried out without inventing missing requirements.
- **Faithful:** Execution remains within the approved scope, requirements, and acceptance criteria.
- **Evidence-based:** Claims of completion are supported by implementation records, independent tests, and review findings.
- **Observable:** The operator can see what is happening, where the run stands, and what resources have been used.
- **Auditable:** Decisions, handoffs, outputs, failures, and rework leave a durable trace.
- **Resumable:** A crash or interrupted session does not lose completed work or workflow state.
- **Controlled:** The operator can stop a run, resolve escalations, and approve or reject final completion.
- **Progress-preserving:** A blocked decision does not stop independent work unnecessarily; only affected work and its dependents are paused.
- **Failure-aware:** Problems cannot disappear silently; they are recorded, addressed, or escalated.

## Out of scope

For the first version, Miah is not:

- A tool for exploring ideas or authoring the source plan.
- An implementation, testing, or review agent.
- Authorized to change approved scope, requirements, or acceptance criteria.
- A general-purpose multi-project or multi-run orchestration platform.
- A black box that performs unrecorded work or silently accepts failures.

## Constraints

- Miah supervises one active approved plan at a time.
- Every run is locked to an immutable snapshot of that plan.
- Run history is recorded in an append-only journal.
- Workflow state, evidence, statuses, and handoffs are durable and filesystem-based.
- Builders, testers, and reviewers have distinct responsibilities.
- Testing and review are independent of implementation.
- Exact cost, time, retry, and severity thresholds are defined during implementation planning, not improvised during a run.
