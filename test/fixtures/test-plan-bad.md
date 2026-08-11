---
title: Bad Miah E2E Test Plan
type: feat
date: 2026-08-07
topic: miah-u10-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Bad Miah E2E Test Plan

## Goal Capsule

- **Objective:** Exercise `miah preflight` against a plan with deliberate
  violations in all three check classes (R56): verifiability (a missing tier),
  structural (a missing `creates:` field and a dependency cycle), and
  referential (an unresolved input). Every unit carries a valid verification
  contract (KTD1) so only the intended violations fire.

## Implementation Units

### Unit Index

| U-ID | Title | depends-on |
| --- | --- | --- |
| U1 | Missing tier | — |
| U2 | Missing creates | U1 |
| U3 | Unresolved input | — |
| U4 | Cycle partner A | U5 |
| U5 | Cycle partner B | U4 |

### U1. Missing tier

- **Goal:** Create the `src/a.ts` module.
- **Requirements:** R1.
- **Files:** `src/a.ts`
- **creates:** `src/a.ts`
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - U1.AC1. `src/a.ts` exists (no `tier:` declared — a verifiability failure)
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U1.CMD1` = `npm test`
  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`
  - **Evidence sources:** `verification`

### U2. Missing creates

- **Goal:** Create the `src/b.ts` module but omit the `creates:` declaration.
- **Requirements:** R2.
- **Files:** `src/b.ts`
- **inputs:** none
- **depends-on:** U1
- **Acceptance:**
  - U2.AC1. `src/b.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U2.CMD1` = `npm test`
  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`
  - **Evidence sources:** `verification`

### U3. Unresolved input

- **Goal:** Create the `src/c.ts` module that consumes a path nothing creates.
- **Requirements:** R3.
- **Files:** `src/c.ts`
- **creates:** `src/c.ts`
- **inputs:** `src/not-created-by-anyone.ts`
- **depends-on:** none
- **Acceptance:**
  - U3.AC1. `src/c.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U3.CMD1` = `npm test`
  - **Criterion mapping:** `U3.AC1` -> `U3.CMD1`
  - **Evidence sources:** `verification`

### U4. Cycle partner A

- **Goal:** Create the `src/d.ts` module in a dependency cycle.
- **Requirements:** R4.
- **Files:** `src/d.ts`
- **creates:** `src/d.ts`
- **inputs:** none
- **depends-on:** U5
- **Acceptance:**
  - U4.AC1. `src/d.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U4.CMD1` = `npm test`
  - **Criterion mapping:** `U4.AC1` -> `U4.CMD1`
  - **Evidence sources:** `verification`

### U5. Cycle partner B

- **Goal:** Create the `src/e.ts` module in a dependency cycle.
- **Requirements:** R5.
- **Files:** `src/e.ts`
- **creates:** `src/e.ts`
- **inputs:** none
- **depends-on:** U4
- **Acceptance:**
  - U5.AC1. `src/e.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U5.CMD1` = `npm test`
  - **Criterion mapping:** `U5.AC1` -> `U5.CMD1`
  - **Evidence sources:** `verification`
