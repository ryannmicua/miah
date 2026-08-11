---
title: Valid Miah Test Plan
type: feat
date: 2026-08-07
topic: miah-u2-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Valid Miah Test Plan

## Goal Capsule

- **Objective:** Exercise the Miah plan parser and preflight against a valid three-unit CE plan.

## Product Contract

### Summary

A minimal CE `ce-unified-plan/v1` fixture modeled on the Miah plan's own U1/U2/U3
structure: U1 creates a source module, U2 consumes it (depends-on U1), and U3 is
an independent config unit. Every unit carries the Miah admission fields
(`creates:`, `inputs:`, `depends-on`, and an `Acceptance` block with per-criterion
tiers per R24-R28) plus a frozen verification contract (KTD1, R8-R10).

## Implementation Units

### Unit Index

| U-ID | Title | depends-on |
| --- | --- | --- |
| U1 | Source module | — |
| U2 | Consumer module | U1 |
| U3 | Config module | — |

### U1. Source module

- **Goal:** Create the `src/hello.ts` source module.
- **Requirements:** R1.
- **Files:** `src/hello.ts`
- **creates:** `src/hello.ts`
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - U1.AC1. `src/hello.ts` exists and exports a greeting — `tier: deterministic`
  - U1.AC2. The module compiles under `tsc` — `tier: deterministic`
- **Approach:** Write a single exported greeting function.
- **Test Scenarios:**
  - Importing the module resolves.
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U1.CMD1` = `npm test -- test/parser.test.ts`
  - **Criterion mapping:** `U1.AC1` -> `U1.CMD1`; `U1.AC2` -> `U1.CMD1`
  - **Evidence sources:** `verification`

### U2. Consumer module

- **Goal:** Create the `src/greeter.ts` consumer module.
- **Requirements:** R2.
- **Files:** `src/greeter.ts`
- **creates:** `src/greeter.ts`
- **inputs:** `src/hello.ts`
- **depends-on:** U1
- **Acceptance:**
  - U2.AC1. `src/greeter.ts` imports `src/hello.ts` — `tier: deterministic`
  - U2.AC2. A verifier confirms the module meets the intended interface — `tier: calibrated-judge`
- **Approach:** Import and reuse U1's export.
- **Test Scenarios:**
  - Greeting output is correct.
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U2.CMD1` = `npm test -- test/greeter.test.ts`
  - **Criterion mapping:** `U2.AC1` -> `U2.CMD1`; `U2.AC2` ->
  - **Evidence sources:** `verification`

### U3. Config module

- **Goal:** Create the `config/app.json` config file.
- **Requirements:** R3.
- **Files:** `config/app.json`
- **creates:** `config/app.json`
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - U3.AC1. `config/app.json` is valid JSON — `tier: deterministic`
- **Approach:** Add a static application config.
- **Test Scenarios:**
  - Config parses.
- **Verification:** `npm test` passes.
- **Verification Contract:**
  - **Commands:** `U3.CMD1` = `npm test -- test/config.test.ts`
  - **Criterion mapping:** `U3.AC1` -> `U3.CMD1`
  - **Evidence sources:** `verification`

## Verification Contract

- `npm test` runs the unit test suite.

## Definition of Done

- All three units are accepted.
