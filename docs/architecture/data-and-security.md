---
mode: reference
verified: 2026-08-09
---

# Data Model and Security — Reference

This is a **reference** document: exact data shapes, paths, config fields, defaults, and security guarantees. For the concepts behind the data (derived state, custody, gaps), see the mechanism docs ([journal-and-recovery](./journal-and-recovery.md), [evidence-and-acceptance](./evidence-and-acceptance.md)). Vocabulary follows [`CONCEPTS.md`](../../CONCEPTS.md).

## Durable state locations

| Location | What it holds | Source |
|---|---|---|
| `~/.miah/config.json` (or `MIAH_CONFIG_HOME`) | operator thresholds (D7) | `src/config.ts:6-37`, `src/config.ts:68` |
| `~/.miah/calibration/<provider>-<model>.json` | operator calibration corpora | `src/calibration.ts:27-34`, `src/calibration.ts:90-101` |
| `~/.miah/runs/<run-id>/` | one directory per run | `src/run-store.ts:21-22` |
| `~/.paseo/orchestration-preferences.json` | per-role provider/model overrides (read-only) | `src/dispatch.ts:242-256` |
| `~/.paseo/config.json` | Paseo daemon config the probe reads (`daemon.mcp.injectIntoAgents`) | `src/substrate-probe.ts:87`, `src/substrate-probe.ts:188-200` |

The base path is resolved by priority: explicit option → `MIAH_CONFIG_HOME` env → `~/.miah` (`src/config.ts:29-38`).

## Run-store layout

Source: `src/run-store.ts:25-37` (`RunStoreLayout`), `src/run-store.ts:53-68` (`resolveRunLayout`).

> **Note on citations.** Every path below is a **runtime-generated** path inside `~/.miah/runs/<run-id>/` (created when a run is admitted or driven). None of them exist in the repository; a doc-claim validator that resolves repo paths will flag them as missing — that is a false positive for this table. The `calibration/` directory is created by `src/run-store.ts:75` but not written by v1 code; operator calibration corpora live under the config base path (`~/.miah/calibration/`), not here.

| Path (relative to `~/.miah/runs/<run-id>/`) | Content | Written by |
|---|---|---|
| `manifest.json` | run id, plan hash, plan snapshot filename, admission timestamp, admission-time config snapshot, probe verdicts | admission (`src/manifest.ts:16-38`, `src/admission.ts:169-184`) |
| `plan-snapshot.v1.md` | immutable canonicalized plan copy | admission (`src/snapshot.ts:53`) |
| `plan-snapshot.v<N>.md` | later versions on `miah amend` | `src/commands/amend.ts:204-206` |
| `units.json` | parsed-once machine view of the plan's units | admission (`src/admission.ts:165`); amended on `miah amend` (`src/commands/amend.ts:212`) |
| `journal.jsonl` | append-only typed event log | the lease-holding writer |
| `lease.lock` | `{holder_id, acquired_at, last_heartbeat_at, ttl_s, released?}` | the lease holder (`src/lease.ts:22-29`) |
| `snapshots/state-<seq>.json` | periodic derived-state snapshots (every K events) | `src/replay.ts:353` |
| `evidence/<unit>/<take>/<role>/` | harvested artifacts per attempt | `src/evidence.ts:350` |
| `evidence/custody-chain.json` | per-run hash-chained custody sequence | `src/custody.ts:44-49`, `src/evidence.ts:459-480` |
| `approval-package.json` | consolidated evidence summary at the gate | `src/driver.ts:258-312` |
| `stop-requested.json` | durable stop flag `{stop_requested: true, requested_at}` | `src/driver.ts:55-83` |

Run ids: `run-<planHash[:10]>-YYYYMMDDTHHMMSS` — deterministic for the same plan and admission time (`src/run-store.ts:43-50`).

## Config schema and defaults

Source: `src/types.ts:10-82` (interfaces), `src/types.ts:164-187` (`DEFAULT_CONFIG`). Governed by `PLAN:D7`, `PLAN:R71-R82`.

| Field | Default | Meaning | Plan |
|---|---|---|---|
| `journal.snapshot_cadence` | `50` | K events between state snapshots | R71, D7-a |
| `lease.heartbeat_interval_s` | `30` | lease heartbeat rewrite interval | R72, D7-b |
| `lease.ttl_s` | `60` | lease TTL before stale-takeover is allowed | R72, D7-b |
| `dispatch.max_duration` | `900` (15m) | per-dispatch deadline (unshipped substrate feature; deadline is Miah-enforced) | R73, D7-c |
| `dispatch.no_progress_polls` | `3` | consecutive unchanged polls before `no-progress` escalation | R76, D7-f |
| `dispatch.default_workspace` | absent | existing Paseo workspace id to attach dispatches to | adapter-default-workspace-config-field |
| `run.concurrency_cap` | `1` | max simultaneous in-flight units | R75, D7-e |
| `run.max_takes` | `3` | max builder dispatch attempts per unit | R77, D7-g |
| `run.max_rework_cycles` | `2` | max rework cycles per unit | R78, D7-g |
| `run.cost_ceiling_usd` | absent (inert) | run-level cost ceiling; when set, exceeding it escalates | R81-R82 |
| `calibration.min_corpus` | `15` | minimum pre-labeled corpus | R74, D7-d |
| `calibration.min_agreement` | `14/15` | strictly-greater agreement bar | R74, D7-d |
| `calibration.max_false_blocks` | `2` | max tolerated false-blocks | R74, D7-d |
| `calibration.zero_false_pass` | `true` | mandatory zero false-pass floor (not relaxable) | R74 |

Config is deep-merged onto defaults (`src/config.ts:48-61`, `src/config.ts:68-88`). A run in progress uses the admission-time snapshot (`manifest.config_snapshot`) read via `miah run` (`src/commands/run.ts:79`) — the R80 contract.

## Manifest shape

Source: `src/manifest.ts:16-29`.

```jsonc
{
  "schema_version": 1,
  "run_id": "run-<hash>-<stamp>",
  "plan_hash": "<sha256>",
  "plan_snapshot_file": "plan-snapshot.v1.md",
  "created_at": "<ISO>",
  "config_snapshot": { /* full Config */ },
  "probe_verdicts": { "paseo_version": null, "max_duration": {...}, "mcp_injection": {...}, "immutability": {...}, "caveats": [...] }
}
```

Written once at admission, never mutated (`src/admission.ts:169-184`). `readManifest` returns null for absent/unparseable (`src/manifest.ts:41-58`).

## Derived state

Source: `src/types.ts:284-295` (`DerivedState`), `src/types.ts:240-277` (per-unit state, in-flight intents, open gaps), `src/replay.ts:21-32` (`emptyDerivedState`).

```jsonc
{
  "seq": 0,            // highest journal seq applied
  "phase": "Admitting",  // latest phase_transition.to; admission journals not-started -> Admitting (issue #3)
  "run_id": null,
  "plan_hash": null,
  "terminal": null,    // "complete" | "rejected" | null
  "units": { "U1": { "status": "not_started", "takes": 0, "rework_cycles": 0, "last_acceptance": null } },
  "in_flight_intents": [ /* InFlightIntent */ ],
  "open_gaps": [ /* OpenGap */ ]
}
```

Derived state stores **derived data only** — never raw contexts, tool inputs, or specialist prose (`PLAN:D7-a`, `PLAN:R41`). Snapshots serialize this structure (`src/replay.ts:353-374`).

## Result envelope schema

Source: `src/envelope.ts:26-60` (`RESULT_ENVELOPE_SCHEMA`), `src/envelope.ts:51-60` (`ResultEnvelope`). Version 1; declared path `.miah/envelope-<role>-<unit>-t<take>.json` relative to the worktree root (`src/envelope.ts:142-148`).

| Field | Type | Notes |
|---|---|---|
| `schema_version` | integer | must be 1 |
| `producer_role` | string | required |
| `attempt_id` | string | the packet's idempotency key |
| `take` | integer | the take number |
| `unit_id` | string | the unit id |
| `self_claim` | string | free-form summary — **not evidence, no authority** |
| `produced_files` | array of `{path, sha256}` | self-reported hashes — **navigation hints only** |
| `wall_clock_estimate_s` | number \| null | best-effort |

`readEnvelope` returns null for absent/unparseable/schema-invalid; Miah treats that as a missing artifact (an R43 gap) (`src/envelope.ts:115-129`).

## Dispatch packet

Source: `src/packet.ts:57-76` (`DispatchPacket`), `src/packet.ts:27-54` (`AuthorityBounds`). Version 1 (`PACKET_SCHEMA_VERSION`, `src/packet.ts:19`); the packet is content-hashed for the journal (`src/packet.ts:135-137`).

| Field | Meaning |
|---|---|
| `schema_version`, `packet_type` (`miah-dispatch-packet/v1`) | packet identity |
| `unit_id`, `role`, `take`, `idempotency_key`, `deadline` | dispatch identity (R36) |
| `objective` | unit goal or title |
| `plan_excerpt` | immutable snapshot slice (planner gets the full snapshot, R8) |
| `output_schema` | the result-envelope schema |
| `authority_bounds` | see below |
| `creates`, `inputs` | unit declarations |
| `result_envelope_path` | envelope path relative to worktree root (R43) |
| `provider`, `model` | resolved profile (D8-i) |

Authority bounds per role (`src/packet.ts`): planner/verifier are read-only (the verifier may write only its declared result envelope); builder has code-writing authority for declared `creates:` paths only; scope/requirement/acceptance change is `prohibited`; recursive workers `prohibited`; run-store writes `prohibited`; worktree isolation `mandatory`; result contract `envelope-at-declared-path`.

## Custody chain

Source: `src/custody.ts:26-35` (`CustodyHeader`), `src/custody.ts:38-42` (chain file shape).

Each header: `{role, agent_id, attempt, take, harvest_ts, content_hash, prev_hash, artifact}` where `artifact` is the evidence-path relative to the evidence root (e.g. `U1/t1/builder/diff.patch` — a runtime path under `~/.miah/runs/<run-id>/evidence/`, not a repo file) and `prev_hash` is the previous header's `content_hash` (null for the first) (`src/custody.ts:67-73`). Persisted as `{version: 1, headers: [...]}` via temp-write-then-rename (`src/custody.ts:140-155`). Hash function: SHA-256 hex (`src/custody.ts:52-54`).

## Role→model defaults

Source: `src/types.ts:312-320`, `PLAN:D8-i`.

| Miah role | Paseo role | Provider/Model (default) |
|---|---|---|
| `planner` | `planning` | `codex` / `gpt-5.6-sol` |
| `builder` | `impl` | `opencode` / `opencode-go/deepseek-v4-flash` |
| `tester` | `audit` | `opencode` / `opencode-go/glm-5.2` |
| `verifier` | `audit` | `opencode` / `opencode-go/glm-5.2` |

Operator's `~/.paseo/orchestration-preferences.json` overrides per-role (paseo_role/provider/model) when present (`src/dispatch.ts:262-280`). Model ids legitimately contain slashes (e.g. `opencode-go/glm-5.2` is a model id, not a repo path); calibration profile filenames sanitize the slash to `_` (`src/calibration.ts:86-88`).

---

## Security guarantees

### What is untrusted input, and how it is bounded

| Input | Bounded by |
|---|---|
| The plan file (markdown) | parsed by a strict regex scanner into `units.json`; malformed plans fail preflight/parse (`src/parser.ts:199-261`, `src/preflight.ts:373-417`); no code is executed from the plan |
| The specialist result envelope | schema-validated; self-claims and self-reported hashes never carry authority (`src/envelope.ts:67-107`) |
| Adapter CLI output | defensively parsed: ANSI stripped, first complete JSON object extracted, errors surfaced as typed exceptions (`src/adapter/paseo.ts:336-422`) |
| Calibration profile files | schema-validated; absent/malformed treated as no authority (fail-closed) (`src/calibration.ts:157-231`) |
| Operator config `~/.miah/config.json` | deep-merged onto defaults; invalid JSON throws a named error (`src/config.ts:78-87`) |

### Guarantees — what may never happen

- **A specialist can never write the run store.** The run store is out-of-tree and owner-only (ADR:D1-g); the dispatch packet forbids run-store writes (`src/packet.ts:36`), and worktree isolation confines specialist writes to their own worktree.
- **Agent prose never becomes evidence.** Harvested artifacts (diffs, exit codes, usage deltas) are the only evidence; the envelope's `self_claim` and `produced_files` are inputs at most (`src/evidence.ts:5-11`, `src/envelope.ts:6-8`).
- **A problem cannot disappear silently.** Open gaps block acceptance; acceptance that supersedes open gaps journals `gap_closed` with a named reason first (`src/commands/resolve.ts:112-119`; see [explicit-gap-close pattern](../solutions/patterns/explicit-gap-close-before-supersede.md)).
- **A broken custody chain cannot support acceptance.** `verifyCustodyChain` journals gaps for broken links before grading/acceptance (`src/evidence.ts:522-541`, `src/custody.ts:95-110`).
- **Admission never proceeds on an unverifiable substrate.** `max_duration` absent or MCP injection unscopable → refusal with a named mechanism and workaround (`src/admission.ts:122-133`).
- **No POSIX-only primitives are load-bearing** (R84); the portability scan enforces it (`test/portability/no-posix-only.test.ts`).

### Known limitations (recorded, not silently accepted)

- **Worker env secret-scrubbing is not implemented.** Specialist processes inherit the daemon's environment (which may contain secrets like API keys). v1 mitigation is worktree isolation + Miah-controlled evidence harvesting; full scrubbing is deferred pending a Paseo `--clean-env` feature (`PLAN:R88`, `PLAN:KTD6`). The residual risk is documented in the manifest probe verdicts context (`src/substrate-probe.ts:139-149`).
- **Per-agent max-duration is not daemon-enforced** in Paseo v0.3.0-beta.2. Miah refuses work past a recorded deadline but cannot stop a runaway agent while Miah is dead (see [paseo-per-agent-hard-bound-verification pattern](../solutions/patterns/paseo-per-agent-hard-bound-verification.md)). Admission fails closed until the feature ships.
- **No per-agent MCP scoping** exists in the substrate; if global injection is enabled, admission refuses and the operator workaround is to disable `daemon.mcp.injectIntoAgents` during Miah runs (`PLAN:R87`, `PLAN:KTD5`).
- **Post-termination workspace immutability** is not guaranteed by the substrate; absence is recorded as a manifest caveat and mitigated by the T2-T3 dual-hash check (`PLAN:R46`).
