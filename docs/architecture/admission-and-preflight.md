---
mode: explanation
verified: 2026-08-09
---

# Mechanism: Admission and Preflight — the Gate a Plan Must Pass

This is an **explanation** of how a plan becomes a run: plan parsing into the machine view, the pure preflight checks, the plan snapshot, the substrate probe, and the fail-closed admission gate. Exact data shapes live in [data-and-security](./data-and-security.md). The probe's honesty discipline is documented in the [paseo-per-agent-hard-bound-verification](../../docs/solutions/patterns/paseo-per-agent-hard-bound-verification.md) and [feature-gated-milestone-testability-seam](../../docs/solutions/patterns/feature-gated-milestone-testability-seam.md) patterns.

## The problem this mechanism solves

Miah supervises exactly one immutable approved plan. Before any work can start, three questions must be answered: *is the plan executable as written?* (preflight), *does the substrate actually provide what the run depends on?* (probe), and *can the run's durable record be created safely?* (admission writes the run store). Two of the three answers must **fail closed**: if the plan cannot be executed or the substrate is missing a required mechanism, admission refuses rather than proceeding on hope.

## Parsing: the plan becomes a machine view

The plan is a CE `ce-unified-plan/v1` markdown document (frontmatter `artifact_contract`, `execution`, `title`; then `## Implementation Units` with `### U<n>. <title>` sections). The parser (`src/parser.ts`) extracts the frontmatter via YAML and the units via regex patterns:

- Unit fields: `Goal`, `Requirements`, `creates:` (backtick-quoted paths), `inputs:`, `depends-on` (U-ID tokens), and the indented `Acceptance` block (`src/parser.ts:97-153`).
- Acceptance criteria may carry a trailing `tier: <name>` marker, parsed off the text (`src/parser.ts:160-171`).
- The result is `units.json`-shaped `ParsedPlan` keyed by U-ID, in document order, with duplicate U-IDs reported separately (`src/parser.ts:199-261`).

The parse is strict about the structural minimum: no `## Implementation Units` section → `PlanParseError`. It is **pure** — no I/O, no run state (`src/parser.ts:9-12`) — and it runs once: the parsed view is written to `units.json` at admission, and the journal, dispatcher, and acceptance predicate all read that cached view (parse-once-and-cache, `PLAN:R24`).

## Preflight: a pure function over plan + workspace

Preflight (`src/preflight.ts`) is a pure function over the plan artifact plus the workspace's current repo-relative path set — it performs no I/O, needs no lease, no run state, no journal (R55). Three check classes (`PLAN:R56`):

- **Structural** (`src/preflight.ts:84-186`): U-IDs present/unique/ascending; `depends-on` resolves to real units; the dependency graph is acyclic (cycle members named individually); every unit carries an `Acceptance` block, `creates:`, and `inputs:`; every criterion tier is from the D5 ladder.
- **Referential** (`src/preflight.ts:242-337`): each `inputs:` path resolves to a path present in the workspace *or* to a `creates:` path of a transitive ancestor; no two units may declare the same `creates:` path (the R30 cross-unit conflict).
- **Verifiability** (`src/preflight.ts:345-366`): every acceptance criterion declares a tier, so it is gradeable.

Severity is **block-only** (R58): any finding is a refusal, and the verdict is `ok: false` with failures grouped by class and offending unit id (`src/preflight.ts:373-417`). A plan that cannot be parsed yields a plan-level `unparseable-plan` structural finding.

## The plan snapshot: immutability by construction

At admission, the plan text is canonicalized (CRLF→LF, trailing-blank normalization) and written verbatim into the run store as `plan-snapshot.v1.md`, then SHA-256 content-hashed (`src/snapshot.ts:36-64`). The hash is the plan's identity in the manifest and the journal (`run_start` carries it; `src/admission.ts:203`). The snapshot is never mutated: amendments write versioned snapshots (`plan-snapshot.v<N>.md`) and never touch the original (`src/commands/amend.ts:204-206`). Because the canonicalization is deterministic, the same document hashes identically regardless of editor line endings.

## The substrate probe: honest reporting, fail-closed admission

The probe (`src/substrate-probe.ts`) is the admission gate's honesty mechanism: it queries the live Paseo substrate and reports what is *actually there*, never fabricating "present" for an unshipped feature. Three checks (`PLAN:KTD4`):

- **(a) Per-agent max-duration** — scan `paseo run --help` for a `--max-duration` / `--expires-at` / `--budget` flag. v0.3.0-beta.2 exposes only `--wait-timeout` (which bounds the waiter, not the agent), so the verdict is `absent` — and **admission fails closed** (`src/substrate-probe.ts:165-184`).
- **(b) MCP injection scoping** — read `~/.paseo/config.json` `daemon.mcp.injectIntoAgents`; when enabled, look for a per-agent MCP scoping flag in `paseo run --help` / `paseo agent update --help`. None exists in v0.3.0-beta.2 → `unscopable` → **admission fails closed**, naming the operator workaround (disable global injection) (`src/substrate-probe.ts:188-249`).
- **(c) Post-termination workspace immutability** — dispatch a throwaway agent to a worktree, terminate it, try to write to the worktree path, and record whether the write succeeds (`absent`) or is blocked (`present`). This is recorded honestly as a manifest caveat (R46) — admission does **not** fail on immutability absence (`src/substrate-probe.ts:253-335`).

The probe report — `paseo_version`, the three verdicts with evidence, and caveats — is stored in the manifest's `probe_verdicts` (`src/admission.ts:176-182`). Every verdict carries the evidence that supports it, so a future reader can see *why* a check reported what it did.

## The admission gate

`admitPlan` composes preflight **and** probe (`src/admission.ts:107-136`):

- preflight failure → structured failures, no run store;
- `execution: knowledge-work` → refused (v1 is code-only, `PLAN:R22`);
- `max_duration` absent → refused with a message naming the missing mechanism;
- MCP injection unscopable → refused with a message naming the issue and the operator workaround;
- immutability absent → recorded as a caveat, **not** a refusal.

When everything passes, admission writes the run store (`src/admission.ts:138-213`): the plan snapshot, `units.json`, the manifest (with the admission-time **config snapshot** — the R80 contract — and the probe verdicts), then acquires the lease and opens the journal with `run_start`. A fresh lease that cannot be acquired (another holder with a fresh heartbeat) is a refusal, not a steal (`src/admission.ts:187-202`).

The probe is injectable behind the `SubstrateProbe` interface (`src/substrate-probe.ts:82-84`) — this is the seam that lets the full pipeline run E2E against a test-only fake while real-probe tests keep asserting fail-closed behavior against the live daemon (see [feature-gated-milestone-testability-seam pattern](../../docs/solutions/patterns/feature-gated-milestone-testability-seam.md)).

## Config: the thresholds the run is admitted with

The config (`~/.miah/config.json`, or `MIAH_CONFIG_HOME`) carries the D7 thresholds — snapshot cadence, lease timing, dispatch bounds, concurrency, takes/rework caps, calibration bar, optional cost ceiling. Defaults live in `src/types.ts:164-187`; the loader deep-merges operator overrides onto them and creates the file with defaults when absent (`src/config.ts:48-88`). The config read at admission time is snapshotted into the manifest, and `miah run` drives the run with that snapshot, not the live file (`src/commands/run.ts:79`) — a run in progress keeps the limits it was admitted with.

## From admission to the first step

`miah start` is the CLI front of this gate: it reads the plan, collects the workspace path set, runs the real probe, calls `admitPlan`, prints the verdict (pass/fail with findings and caveats), and exits 1 on refusal (`src/commands/start.ts:58-89`). On success the lease is immediately released so the first `miah run` picks the run up (`src/commands/start.ts:87-88`). `miah preflight` runs the pure preflight alone, standalone, with the same block-only severity (`src/commands/preflight.ts:108-123`).

The driver then opens the run: acquire lease, replay, honor a recorded stop, and — for a fresh run — journal the `Admitting → Ready` transition (`src/driver.ts:378-384`), entering the loop described in [journal-and-recovery](./journal-and-recovery.md) and [dispatch-and-isolation](./dispatch-and-isolation.md).
