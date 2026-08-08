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
  referential (an unresolved input).

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
  - `src/a.ts` exists (no `tier:` declared — a verifiability failure)
- **Verification:** `npm test` passes.

### U2. Missing creates

- **Goal:** Create the `src/b.ts` module but omit the `creates:` declaration.
- **Requirements:** R2.
- **Files:** `src/b.ts`
- **inputs:** none
- **depends-on:** U1
- **Acceptance:**
  - `src/b.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.

### U3. Unresolved input

- **Goal:** Create the `src/c.ts` module that consumes a path nothing creates.
- **Requirements:** R3.
- **Files:** `src/c.ts`
- **creates:** `src/c.ts`
- **inputs:** `src/not-created-by-anyone.ts`
- **depends-on:** none
- **Acceptance:**
  - `src/c.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.

### U4. Cycle partner A

- **Goal:** Create the `src/d.ts` module in a dependency cycle.
- **Requirements:** R4.
- **Files:** `src/d.ts`
- **creates:** `src/d.ts`
- **inputs:** none
- **depends-on:** U5
- **Acceptance:**
  - `src/d.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.

### U5. Cycle partner B

- **Goal:** Create the `src/e.ts` module in a dependency cycle.
- **Requirements:** R5.
- **Files:** `src/e.ts`
- **creates:** `src/e.ts`
- **inputs:** none
- **depends-on:** U4
- **Acceptance:**
  - `src/e.ts` exists — `tier: deterministic`
- **Verification:** `npm test` passes.
