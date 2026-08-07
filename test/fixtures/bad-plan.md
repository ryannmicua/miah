---
title: Bad Miah Test Plan
type: feat
date: 2026-08-07
topic: miah-u2-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Bad Miah Test Plan

## Goal Capsule

- **Objective:** Exercise the Miah plan parser and preflight against a plan
  with deliberate violations across all three check classes (R56).

## Implementation Units

### Unit Index

| U-ID | Title | depends-on |
| --- | --- | --- |
| U1 | Shared source | — |
| U2 | Missing creates | U1 |
| U3 | Conflicting creates | — |
| U4 | Cycle partner A | U5 |
| U5 | Cycle partner B | U4 |

### U1. Shared source

- **Goal:** Create the shared source module.
- **Requirements:** R1.
- **Files:** `src/shared.ts`
- **creates:** `src/shared.ts`
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - `src/shared.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.

### U2. Missing creates

- **Goal:** Create a consumer module but omit the `creates:` declaration.
- **Requirements:** R2.
- **Files:** `src/consumer.ts`
- **inputs:** `src/foo.py`
- **depends-on:** U1
- **Acceptance:**
  - The consumer works — `tier: deterministic`
- **Verification:** `npm test` passes.

### U3. Conflicting creates

- **Goal:** Create a module that claims the same path as U1.
- **Requirements:** R3.
- **Files:** `src/shared.ts`
- **creates:** `src/shared.ts`
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - The shared module works
- **Verification:** `npm test` passes.

### U4. Cycle partner A

- **Goal:** Create a module in a dependency cycle.
- **Requirements:** R4.
- **Files:** `src/a.ts`
- **creates:** `src/a.ts`
- **inputs:** none
- **depends-on:** U5
- **Acceptance:**
  - `src/a.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.

### U5. Cycle partner B

- **Goal:** Create a module in a dependency cycle.
- **Requirements:** R5.
- **Files:** `src/b.ts`
- **creates:** `src/b.ts`
- **inputs:** none
- **depends-on:** U4
- **Acceptance:**
  - `src/b.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
