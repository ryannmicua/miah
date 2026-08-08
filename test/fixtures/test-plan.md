---
title: Miah E2E Test Plan
type: feat
date: 2026-08-07
topic: miah-u10-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Miah E2E Test Plan

## Goal Capsule

- **Objective:** Exercise the full Miah pipeline against a minimal three-unit CE
  plan: U1 creates a TypeScript hello module, U2 consumes it (depends on U1),
  and U3 is an independent config unit. One `calibrated-judge` criterion on U2
  exercises the calibration gate (KTD10: empty default corpora).

## Implementation Units

### Unit Index

| U-ID | Title | depends-on |
| --- | --- | --- |
| U1 | Source module | — |
| U2 | Consumer module | U1 |
| U3 | Config module | — |

### U1. Source module

- **Goal:** Create the `src/hello.ts` TypeScript hello module.
- **Requirements:** R1.
- **Files:** `src/hello.ts`
- **creates:** `src/hello.ts`
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - `src/hello.ts` exists and exports a greeting — `tier: deterministic`
  - The module is valid Node-compatible TypeScript — `tier: deterministic`
- **Approach:** Write a single exported greeting function. Write the result
  envelope as a FLAT JSON object: the keys `schema_version`, `producer_role`,
  `attempt_id`, `take`, `unit_id`, `self_claim`, `produced_files`,
  `wall_clock_estimate_s` must all be TOP-LEVEL keys at the object's root — do
  NOT wrap them inside `schema` or `fields`, and do not include a `write_to`
  key.
- **Test Scenarios:**
  - Importing the module resolves.
- **Verification:** `npm test` passes.

### U2. Consumer module

- **Goal:** Create the `src/greeter.ts` consumer module that imports `hello.ts`.
- **Requirements:** R2.
- **Files:** `src/greeter.ts`
- **creates:** `src/greeter.ts`
- **inputs:** `src/hello.ts`
- **depends-on:** U1
- **Acceptance:**
  - `src/greeter.ts` imports `src/hello.ts` — `tier: deterministic`
  - A reviewer confirms the greeting API is used correctly — `tier: calibrated-judge`
- **Approach:** Import and reuse U1's export. Write the result envelope as a
  FLAT JSON object: `schema_version`, `producer_role`, `attempt_id`, `take`,
  `unit_id`, `self_claim`, `produced_files`, `wall_clock_estimate_s` must all
  be TOP-LEVEL keys — do NOT wrap them inside `schema` or `fields`, and do not
  include a `write_to` key.
- **Test Scenarios:**
  - Greeting output is correct.
- **Verification:** `npm test` passes.

### U3. Config module

- **Goal:** Create the `config/app.json` config file.
- **Requirements:** R3.
- **Files:** `config/app.json`
- **creates:** `config/app.json`
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - `config/app.json` is valid JSON — `tier: deterministic`
- **Approach:** Add a static application config. Write the result envelope as a
  FLAT JSON object: `schema_version`, `producer_role`, `attempt_id`, `take`,
  `unit_id`, `self_claim`, `produced_files`, `wall_clock_estimate_s` must all
  be TOP-LEVEL keys — do NOT wrap them inside `schema` or `fields`, and do not
  include a `write_to` key.
- **Test Scenarios:**
  - Config parses.
- **Verification:** `npm test` passes.

## Verification Contract

- `npm test` runs the unit test suite.

## Definition of Done

- All three units are accepted.
