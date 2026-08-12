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
  with deliberate violations across all three check classes (R56). Every unit
  carries a valid verification contract (KTD1) so only the intended violations
  fire.

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
  - U1.AC1. `src/shared.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U1.CMD1` = `npm test`
  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`
  - **Evidence sources:** `verification`

### U2. Missing creates

- **Goal:** Create a consumer module but omit the `creates:` declaration.
- **Requirements:** R2.
- **Files:** `src/consumer.ts`
- **inputs:** `src/foo.py`
- **depends-on:** U1
- **Acceptance:**
  - U2.AC1. The consumer works — `tier: deterministic`
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U2.CMD1` = `npm test`
  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`
  - **Evidence sources:** `verification`

### U3. Conflicting creates

- **Goal:** Create a module that claims the same path as U1.
- **Requirements:** R3.
- **Files:** `src/shared.ts`
- **creates:** `src/shared.ts`
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - U3.AC1. The shared module works
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U3.CMD1` = `npm test`
  - **Criterion mapping:** `U3.AC1` -> `U3.CMD1`
  - **Evidence sources:** `verification`

### U4. Cycle partner A

- **Goal:** Create a module in a dependency cycle.
- **Requirements:** R4.
- **Files:** `src/a.ts`
- **creates:** `src/a.ts`
- **inputs:** none
- **depends-on:** U5
- **Acceptance:**
  - U4.AC1. `src/a.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U4.CMD1` = `npm test`
  - **Criterion mapping:** `U4.AC1` -> `U4.CMD1`
  - **Evidence sources:** `verification`

### U5. Cycle partner B

- **Goal:** Create a module in a dependency cycle.
- **Requirements:** R5.
- **Files:** `src/b.ts`
- **creates:** `src/b.ts`
- **inputs:** none
- **depends-on:** U4
- **Acceptance:**
  - U5.AC1. `src/b.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U5.CMD1` = `npm test`
  - **Criterion mapping:** `U5.AC1` -> `U5.CMD1`
  - **Evidence sources:** `verification`
