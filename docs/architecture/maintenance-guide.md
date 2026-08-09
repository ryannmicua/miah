---
mode: how-to
verified: 2026-08-09
---

# Maintenance Guide

This is a **how-to** document: goal-oriented procedures for competent maintainers. It assumes you understand the system (see [system-overview](./system-overview.md) and the mechanism docs) and need to accomplish a specific task. For exact values and interfaces, see the reference docs ([state-machine-reference](./state-machine-reference.md), [data-and-security](./data-and-security.md)).

## How to add a new journal event type

The journal is append-only JSONL of typed events; adding a type touches four places.

1. **Declare the type name** in `JOURNAL_EVENT_TYPES` at `src/types.ts:198-225`. This is the canonical list; tests that enumerate event types read from it.
2. **Add the `applyEvent` case** in `src/replay.ts:90-288` if the event changes derived state. If it carries no derived state (like lease audit events), you do not need a case — unknown types are sequenced and replayed but fold nothing (`src/replay.ts:281-286`). If it does change derived state, follow the existing pattern: guard payload fields with `asString`/`asUnitId` so malformed payloads are treated as absent, never as corruption (`src/replay.ts:87-89`).
3. **Journal it from the right place under the lease** — appends go through `RunStore.append` (`src/run-store.ts:181-189`), which gates on the lease holder and applies the event to the running state. Never write to `journal.jsonl` directly from outside `Journal.append`.
4. **Add a test** in the matching `test/*.test.ts` (e.g. `test/replay.test.ts` for derivation). If the event is terminal or phase-affecting, check the state-machine tests (`test/fsm.test.ts`, `test/driver.test.ts`).

Verify: `npm run build` then the unit suite (below). If the event type is part of a stable contract (a new `dispatch_*` or `operator_*` type), record it in [state-machine-reference](./state-machine-reference.md#journal-event-types) and update the `verified` date in the file frontmatter.

## How to add a new CLI command

The command surface is exactly ten commands by design (`PLAN:R63`); adding one is an operator decision, not a routine change. If approved:

1. **Create `src/commands/<name>.ts`** following an existing command's shape: an options interface, a `run<Name>` body returning a numeric exit code, and an error constant. See `src/commands/stop.ts:24-46` for the minimal pattern (exit code constant + options + identity helper reuse).
2. **Register it** in `src/commands/index.ts` — add to the `COMMANDS` list (`src/commands/index.ts:17-28`) and register it in `registerCommands` (`src/commands/index.ts:64-164`) using `runGuarded` so thrown errors become exit 1 (`src/commands/index.ts:37-62`).
3. **Journal operator decisions** with identity via `operatorIdentity()` from `src/commands/stop.ts:32-46`, as an `operator_decision` event, per R69.
4. **Add command tests** in `test/<name>.command.test.ts` (see `test/stop.command.test.ts`, `test/reject.command.test.ts` for the lease-acquire/release pattern used by operator commands).
5. Update the CLI-surface documentation: [state-machine-reference](./state-machine-reference.md#driver-result-statuses-and-exit-codes) (exit codes) and [system-overview](./system-overview.md) (layer description) only if the new command changes a layer's responsibility.

## How to add a config field

1. **Extend the `Config` interface** in `src/types.ts:10-82` and the matching section of `DEFAULT_CONFIG` (`src/types.ts:164-187`). Field names must match the `config.json` schema keys (R80).
2. **Enforce the threshold** where it is read — budget predicates evaluate in `src/step.ts:414-452`; lease timing in `src/run-store.ts:131-135`; snapshot cadence in `src/run-store.ts:184-187`. Follow the existing pattern: a failing predicate routes to escalation or stop, never silent skip (`PLAN:D7-j`).
3. **Add config tests** in `test/*.test.ts` for the section (e.g. `test/step.test.ts` for run/dispatch thresholds).
4. Update [data-and-security](./data-and-security.md#config-schema-and-defaults) (the config table) and the `verified` date. If the field is a D7 threshold, it is a design-decision change: update the affected decision in [design-decisions](./design-decisions.md#24-bounded-autonomy-thresholds-operator-configurable) status line.

## How to run the test suite and the kill drill

Unit suite (no live daemon):

```bash
npm ci
npm run build
npx vitest run --pool=forks --poolOptions.forks.singleFork=true --exclude "test/e2e/**"
```

Baseline at last verification: 340 passed / 1 skipped. The portability scan (`test/portability/no-posix-only.test.ts`) and the kill-drill unit levels (`test/kill-drill-v1.test.ts`, `test/kill-drill-v2.test.ts`) run as part of this suite.

E2E suite (requires the `paseo` CLI and daemon; gates on `paseoCliAvailable()` and skips otherwise):

```bash
npx vitest run --pool=forks --poolOptions.forks.singleFork=true test/e2e/bin-smoke.test.ts
```

The full E2E (kill drill v3, full run, deadline refusal, substrate fail-closed) runs under `test/e2e/` — see `test/e2e/helpers/e2e-harness.ts` and the plan's U10 verification bar (`PLAN:R90`).

## How to run a manual kill drill

The kill drill is the proof that "resume is the only implementation" holds after a real crash. The automated E2E (`test/e2e/kill-drill.test.ts`) covers it end-to-end; to exercise it by hand:

1. `miah start <plan>` against a plan that dispatches (inject the fake substrate probe if the live daemon lacks `max-duration` — see [feature-gated-milestone-testability-seam pattern](../solutions/patterns/feature-gated-milestone-testability-seam.md)).
2. `miah run` in one terminal until a builder is in-flight.
3. Kill the `miah run` process mid-dispatch (SIGKILL/End task) and note the journal's last event.
4. `miah run --once` in a fresh terminal. Assert: the reconstructed phase and unit states match the pre-kill record; an intent-without-created is reconciled against the adapter; work past a recorded deadline is refused; the run continues.
5. Compare byte-identical derived state per `test/kill-drill-v1.test.ts:208-218` (independent artifacts: raw journal prefix vs. replay-derived serialization).

## How to re-verify this documentation set

The set is "verified, not remembered." When you change code or docs, run these gates before updating the `verified` dates:

1. **Anchor check** — every `src/...:NNN` citation resolves and names a real symbol near the cited line. Spot-check at least 30 anchors; grep for any symbol that moved.
2. **Link check** — every relative link between the set's files and to `CONCEPTS.md`, the plan, the ADR, and the patterns store resolves.
3. **Terminology grep gates** — zero stale/old paths; the pairing convention holds (concept and filename introduced in one breath on first mention); no forbidden terms.
4. **Duplication check** — no paragraph substantially re-narrates a pattern-store incident; reuse of history is a link, not a paragraph.
5. **Conflict scan** — a genuine contract/plan/code disagreement goes in the [README conflict log](./README.md#conflict-log), never a silent edit.
6. **Test suite** — run the unit suite (above); confirm the baseline.
7. Update each file's `verified: YYYY-MM-DD` frontmatter.

Full procedure and gates: see the [README maintenance rules](./README.md#maintenance-rules).
