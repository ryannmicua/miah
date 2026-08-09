---
title: "A problem cannot disappear silently — journal explicit close events before the superseding acceptance"
date: 2026-08-08
category: patterns
problem_type: knowledge
component: gap-journal
tags: [miah, gap, journal, r50, gap-closed, acceptance, approval-package, supersede, derived-state, cross-project]
applies_when: "An append-only journal derives downstream artifacts (an approval package, a status report, a custody chain) from typed events — and an accept/override event would supersede open items (gaps, escalations) without recording per-item close events, silently dropping them from the derived view."
---

# A problem cannot disappear silently — journal explicit close events before the superseding acceptance

> **Cross-project knowledge.** This pattern is staged in the Miah repo because the validating incident happened here, but it applies to any append-only event journal whose derived state feeds downstream artifacts — an approval package, a status report, a custody chain, a compliance record. The operator will synthesize it into other projects.

## Context

Miah's journal is append-only JSONL. Gaps are first-class typed events: `gap_recorded(unit, criterion, reason)` opens a gap; `gap_closed(unit, criterion, close_reason)` closes it. The acceptance predicate (`src/acceptance.ts`) holds only when every criterion passes at or above its declared tier **with no open gap** on the unit. When the operator accepts a unit (via `miah resolve --decision approve` after an escalation), the journal writes `acceptance_decision: accept` and the replay's derived state drops the unit's open gaps — the acceptance supersedes them.

The bug (M1 in the final code review, `docs/reviews/2026-08-08-final-code-review.md` §2): `acceptance_decision: accept` silently dropped **every** remaining open gap on the unit from derived state without a paired `gap_closed` event. The journal itself was honest — the original `gap_recorded` events were still there — but the approval package's `gap_close_reasons` list (`src/driver.ts:277-284`, which filters on `gap_closed` type) would omit any gap the accept decision implicitly closed. This is a soft violation of R50: *"a problem cannot disappear silently."*

The bug was reachable today: `miah resolve --decision approve` when the unit has more than one open gap. The resolve path closes only the escalation's criterion (`src/commands/resolve.ts:100-106`), then accepts the unit regardless. The other open gaps vanish from the approval package — the operator's final audit trail is incomplete.

The review also noted: no test covers an open gap surviving to `run_terminal` — the acceptance predicate was unit-tested for the "all-criteria-pass + no-blocking-gap" happy path and the "blocking gap present" rejection path, but never the "operator accepts with a different gap still open" path (§4, gap 1).

The fix (the `fix(M1): journal gap_closed for implicitly-closed gaps on operator approval` commit; shipped in PR #1, squash `d7eac30`) added a loop in `src/commands/resolve.ts` that journals a `gap_closed` event **per remaining open gap** BEFORE the `acceptance_decision: accept`:

```ts
for (const gap of store.stateSnapshot().open_gaps) {
  if (gap.unit_id === unitId) {
    store.append("gap_closed", {
      unit_id: unitId,
      criterion: gap.criterion,
      close_reason: "operator-approval",
    });
  }
}
store.append("acceptance_decision", { unit_id: unitId, decision: "accept" });
```

The close events are written before the superseding event, so a downstream derivation that filters on `gap_closed` (the approval package) sees the close records in the journal prefix it reads — the gaps appear as closed-by-operator-approval, not as silently-dropped.

## Guidance

Four rules keep a "cannot disappear silently" invariant honest in an append-only journal. Each is independent.

**1. When an accept/override event supersedes open items, journal a per-item close event BEFORE the superseding event.**
The superseding event (`acceptance_decision: accept`) is the authority — it says "this unit is accepted." But the open items (gaps) it supersedes need their own close events, with a close_reason that names who closed them and why (`operator-approval`). The close events go into the journal **before** the superseding event, so any downstream derivation that reads a prefix ending at (or before) the superseding event still sees the close records. A derivation that filters on `gap_closed` to build the approval package's `gap_close_reasons` list will include them; without the close events, the gaps are invisible in the derived view even though the raw journal still carries their `gap_recorded` events.

**2. The close_reason must name the authority and the mechanism.**
`close_reason: "operator-approval"` tells the reader: the operator's approval closed this gap, not the builder's fix. This distinguishes "the gap was resolved by fixing the problem" from "the gap was superseded by the operator accepting despite the problem." The approval package's reader (an auditor, a reviewer, the operator themselves) can tell which gaps were fixed and which were overridden — the distinction is load-bearing for trust.

**3. The loop must read derived state, not re-derive from raw events.**
The fix reads `store.stateSnapshot().open_gaps` — the derived view, not a raw replay of `gap_recorded` minus `gap_closed`. The derived view is already maintained by the replay path; re-deriving in the accept path risks divergence between the two computations. The disk-first invariant (sibling `disk-first-paseo-loop.md`) holds: the derived state is the state of record for decisions; the raw journal is the audit trail.

**4. Test the implicitly-closed path explicitly — the happy path does not cover it.**
The acceptance predicate's test suite covered: all-criteria-pass + no-blocking-gap → accept; blocking-gap-present → reject. It did not cover: operator-accepts-with-other-gap-still-open → gap appears as `operator-approval` in the approval package. The review called this gap out (§4, gap 1); the fix commit added `test/resolve.command.test.ts` coverage for the implicitly-closed path. A "cannot disappear silently" invariant that is untested for the supersede path is an invariant on paper, not in code.

## Why This Matters

An approval package is the operator's final audit trail — it tells the operator and any downstream reviewer what was accepted, what gaps were found, and how each gap was closed. A gap that was open at acceptance and silently dropped from the approval package is a gap that "disappeared" — the operator cannot tell whether it was fixed, overridden, or lost. R50 ("a problem cannot disappear silently") is the invariant that prevents this; the M1 bug is the case where the invariant held in the raw journal but was violated in the derived view.

The fix is small: one loop, N close events, one close_reason field. The cost of the bug is trust: an operator who discovers a gap in the approval package after the run is complete cannot tell whether the gap was fixed, overridden, or silently dropped — and must investigate the raw journal to find out. The fix makes the derived view as honest as the raw journal, so the operator never has to investigate.

This is the same honesty discipline Miah itself institutionalizes one level down: evidence is harvested artifacts, the acceptance predicate is decidable, and every transition is journaled. The gap-close-before-supersede rule is the mechanism that keeps the derived artifacts (approval package) as honest as the raw journal when an override event would otherwise silently supersede open items.

## When to Apply

- Any append-only journal whose derived state feeds downstream artifacts (approval package, status report, custody chain, compliance record).
- Any accept/override event that would supersede open items without recording per-item close events.
- Any "cannot disappear silently" invariant (R50 or equivalent) — the derived view must be as honest as the raw journal.
- Any acceptance predicate whose test suite covers the happy path and the reject path but not the "operator accepts with other items still open" path.

## Examples

**Wrong way (the bug, before the M1 fix):**
- `src/commands/resolve.ts` accepts the unit after closing only the escalation's criterion. Other open gaps on the unit are dropped from derived state by `acceptance_decision: accept` with no `gap_closed` events. The approval package's `gap_close_reasons` list omits them. The journal is honest; the derived view is not.
- No test covers the implicitly-closed path — the acceptance predicate's suite covers accept-happy and reject-blocking, not accept-with-other-gap-open.

**Right way (the fix, `fix(M1)` commit in PR #1, squash `d7eac30`):**
```ts
// src/commands/resolve.ts — journal close events BEFORE the acceptance
for (const gap of store.stateSnapshot().open_gaps) {
  if (gap.unit_id === unitId) {
    store.append("gap_closed", {
      unit_id: unitId, criterion: gap.criterion,
      close_reason: "operator-approval",
    });
  }
}
store.append("acceptance_decision", { unit_id: unitId, decision: "accept" });
```
- `test/resolve.command.test.ts` (PR #1, squash `d7eac30`, +67 lines): unit with two open gaps → `miah resolve --decision approve` → both gaps appear as `gap_closed` with `close_reason: "operator-approval"` → approval package's `gap_close_reasons` list includes both.
- Code review §2 M1 finding: "acceptance_decision: accept silently drops every open gap on the unit from derived state without a paired gap_closed event. Soft violation of R50 'a problem cannot disappear silently'."
- Code review §4 gap 1: "Open gap surviving to run_terminal is untested" — the fix commit added the test.