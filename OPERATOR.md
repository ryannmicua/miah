# OPERATOR.md — Miah operator manual (starting point)

> This is the first doc to hand to anyone who will **drive or operate Miah** — a human operator or an agent acting for one. It covers prerequisites, the plan format, the exact command sequence, and what Miah will ask *you* to decide. It deliberately stays practical; every claim below carries a pointer deeper into the documentation set when you need the detail.

## What Miah is (one paragraph)

Miah is a **resumable plan supervisor** CLI. It directs one approved plan at a time from executable plan to verified completion: it validates the plan, locks it to an immutable snapshot, hands each unit to an independently dispatched specialist agent (builder), runs completed work past an independent verifier specialist, grades the harvested evidence against tiered acceptance criteria, and refuses to call a step done until the criteria pass — or you sign off. Every decision, dispatch, and transition is appended to a durable journal, so a crashed session never loses progress: the next `miah run` picks up exactly where the last one left off. Miah itself never implements, tests, or verifies grades — it orchestrates, journals, senses, custody-chains evidence, and gates.

Sources: [`VISION.md`](./VISION.md), [`README.md`](./README.md), [`docs/architecture/system-overview.md`](./docs/architecture/system-overview.md).

## Who drives Miah

- **The operator** (a person, or an agent acting for them) runs the CLI commands: `miah start`, `miah run`, `miah status`, `miah resolve`, `miah approve`, `miah reject`, `miah stop`, `miah amend`. Every one of these is journaled as an `operator_decision` with identity — your authority is explicit and auditable.
- **Miah (the CLI)** supervises only. It decides routine sequencing, bounded rework, and ordinary disagreements among specialists.
- **Specialists** are the actual workers — planner, builder, tester, verifier — each an independently dispatched Paseo agent session in its own worktree.
- Because supervisor state lives on disk (journal + snapshot + lease), the *driver* doesn't have to be any specific process: a terminal, a cron job, a Paseo schedule, or another agent session may pick the run up. A run nobody is driving is **paused, not lost** (ADR:D1-b).

## Before you start (prerequisites)

1. **Install Miah** (once, not per project). In this repo: `npm ci && npm run build`, then make `miah` available (e.g. `npm link`). Config auto-creates at `~/.miah/config.json` (override with `MIAH_CONFIG_HOME`); runs live in `~/.miah/runs/`.
2. **Check the substrate.** Miah dispatches specialists through the **Paseo daemon**, so it must be running with providers configured. Two fail-closed traps the admission probe will catch:
   - If `daemon.mcp.injectIntoAgents` is globally enabled in `~/.paseo/config.json`, admission **refuses** (MCP scoping is not yet per-agent) — disable global injection.
   - If your Paseo lacks a per-agent `--max-duration` flag (the version documented at v1, v0.3.0-beta.2, exposes only `--wait-timeout`), admission **refuses** outright — `miah start` will name exactly what is missing. This is deliberate: Miah fails closed rather than run on hope.
3. **Have an approved plan in CE format** (see below). `execution: knowledge-work` plans are refused — v1 is code-only.

Sources: [`docs/architecture/admission-and-preflight.md`](./docs/architecture/admission-and-preflight.md), [`docs/architecture/data-and-security.md`](./docs/architecture/data-and-security.md).

## The plan format

Miah admits **CE `ce-unified-plan/v1`** markdown documents:

- Frontmatter: `artifact_contract`, `execution` (must be `code`), `title`.
- A `## Implementation Units` section containing one `### U<n>. <title>` section per unit, each with `Goal`, `Requirements`, `creates:` (backtick-quoted paths), `inputs:`, `depends-on` (U-ID tokens), and an indented `Acceptance` block.
- Every acceptance criterion declares a **tier** from the D5 ladder: `deterministic` (machine-checkable), `calibrated-judge` (independent verifier verdict, requires a calibration corpus), or `human` (your judgment).

Preflight is pure and block-only: structural (U-IDs, acyclic deps, required fields, recognized tiers), referential (`inputs:` resolve; no cross-unit `creates:` conflicts), and verifiability (every criterion has a tier). A plan that fails any check is refused with structured findings.

Working example: [`test/fixtures/valid-plan.md`](./test/fixtures/valid-plan.md).

## What instructions agents receive

Every specialist gets exactly one **dispatch packet** (`miah-dispatch-packet/v1`), rendered as the initial prompt of its Paseo session (`src/packet.ts`). The packet contains, in order:

1. **Header** — role, unit, take, idempotency key, deadline, provider/model, packet hash.
2. **Objective** — the unit's `Goal` (fallback: its title).
3. **Authority bounds** — planner/verifier are **read-only** (the verifier may write only its declared result envelope); a builder may write only inside its own worktree and only its declared `creates:` paths; scope/requirement/acceptance changes, recursive agents, and run-store writes are all prohibited.
4. **Deliverables (`creates:`)** and **inputs (`inputs:`)** — the unit's declared paths.
5. **Result-envelope output schema** — the single JSON file it must write (`.miah/envelope-<role>-<unit>-t<take>.json`), whose `self_claim` and self-reported hashes carry no evidence authority.
6. **Plan snapshot excerpt** — the unit's own `### U<n>` section verbatim (builder/tester/verifier) or the full snapshot (planner).

**Where the instructions come from:** the packet is composed from the plan's parsed-once machine view (`units.json`, R24) plus the immutable snapshot, the role's fixed authority bounds (`src/packet.ts:42`), the envelope schema (`src/envelope.ts`), the provider/model for the role (`src/types.ts` D8-i defaults, overridden by `~/.paseo/orchestration-preferences.json`), and the deadline (config `dispatch.max_duration`, default 15m).

**Who gives it to them:** Miah itself. The driver hashes the packet (canonical JSON → SHA-256) and journals `dispatch_intent` with that hash **before** the adapter launches the session — intent-before-launch (R17/R36) — so the journal records exactly what was sent, and the specialist also reads the target repo's own `AGENTS.md` on top of the packet.

**How to modify the instructions:**

| Change | Where | Requires |
|---|---|---|
| What the agent is asked to do (objective, deliverables, inputs, acceptance) | The plan document — immutable once admitted | `miah amend <run-id> <new-plan.md>` (versioned snapshot, affected units re-dispatched) |
| Which model/provider each role uses | `~/.paseo/orchestration-preferences.json` | Nothing — wins over code defaults at dispatch |
| Deadline / dispatch bounds | `~/.miah/config.json` (`dispatch.max_duration` etc.) | Nothing — but a run keeps the config it was admitted with |
| The prompt template itself (wording, layout) | `src/packet.ts` (`renderPacketPrompt`) | Code change + rebuild; bump `PACKET_SCHEMA_VERSION` if the shape changes |
| The envelope contract | `src/envelope.ts` | Code change; bump `RESULT_ENVELOPE_SCHEMA_VERSION` |
| Role → paseo-role mapping | `src/types.ts` (`D8I_ROLE_DEFAULTS`) or the preferences file | Code change, or nothing via preferences |

The operator-only levers are the two JSON files — preferences and config. Anything deeper (packet wording, new sections, envelope fields) is a code change with a schema-version bump, because the packet hash must stay deterministic for the audit trail.

## The command sequence

| # | Command | What it does | When |
|---|---|---|---|
| 1 | `miah preflight <plan.md>` | Pure structural/referential/verifiability checks, no side effects | Any time, as a cheap first gate |
| 2 | `miah start <plan.md>` | **The admission gate**: preflight + live substrate probe + lease + run store + immutable snapshot + journal `run_start`. Prints the verdict; exits 1 on refusal | The first command that matters |
| 3 | `miah run [--once]` | The looping driver: replay journal, dispatch eligible units, poll specialists, harvest evidence, grade, accept or rework, escalate | Once admitted; repeat as needed |
| 4 | `miah status` | Render run state from the journal, no lease needed | Anytime, to see where the run stands |
| 5 | `miah stop <run-id>` | Journaled stop: terminate in-flight, release lease | Anytime you want to halt |
| 6 | `miah resolve <run-id> <esc-id> --decision approve\|deny\|rework` | Close an escalation with your decision; run resumes | When the run parks in `Attention` |
| 7 | `miah approve <run-id>` | Final gate: run → `Complete` (terminal) | When parked in `AwaitingApproval` |
| 8 | `miah reject <run-id> --rework <ids> \| --end` | Reject final result: bounded rework, or terminal `rejected` | When parked in `AwaitingApproval` |
| 9 | `miah amend <run-id> <new-plan.md>` | Change order: new versioned snapshot, scoped re-preflight, affected units re-dispatched; never mutates the original | Scope/requirements change mid-run |
| 10 | `miah list` | List all runs | Anytime |

The run-phase cycle: `Admitting → Ready → Implementing → Reviewing → AwaitingApproval` (success path), with `Attention` (escalation) and `Stopping` reachable from anywhere, and `Complete`/`rejected` as the terminal outcomes. Exact phases, event types, and exit codes: [`docs/architecture/state-machine-reference.md`](./docs/architecture/state-machine-reference.md).

## What Miah will ask *you* to decide

- **Escalations** — the run pauses in `Attention` and `miah resolve` is your call. Triggers: repeated failure, no progress, rework caps exceeded, scope change needed, security risk, destructive side effect, unresolved high-severity failure, missing access/judgment, cost ceiling exceeded, no calibrated checker available, no eligible work left.
- **Final approval** — when all units are accepted, Miah parks in `AwaitingApproval` with the evidence package. You `miah approve`, `miah reject --end`, or `miah reject --rework <units>`.
- **Stop** — any time, journaled.
- **Amend** — the only path that changes approved intent, and it never touches the original snapshot.

Routine decisions (sequencing, bounded rework, specialist disagreements) stay with Miah — it only escalates what exceeds its authority.

## Steering agents mid-run

You do **not** steer specialist agents directly — there is no channel into a running session. Specialists receive one immutable, content-hashed dispatch packet (role, objective, authority bounds: builders may write only their declared `creates:` paths; planners/verifiers are read-only), and Miah never reaches into a session mid-task. Steering happens through journaled operator commands that change what the run does next; the control loop is always *pause → decide → resume* at a step boundary.

| Command | What it steers | When |
|---|---|---|
| `miah resolve <run-id> <esc-id> --decision approve\|deny\|rework` | **The designed steering channel.** The run parks in `Attention`; your decision is journaled (`operator_decision`), gaps are closed explicitly, and the run resumes | Any time Miah raises an escalation — including proactively on no-progress (3 unchanged fingerprints) or repeated failure |
| `miah stop <run-id>` | Terminates in-flight specialists (bounded 25s), releases the lease. The stop flag is durable — honored on the next `miah run` even if no driver was alive | Anytime you want to halt |
| `miah amend <run-id> <new-plan.md>` | Change order: new versioned snapshot, scoped re-preflight, affected units re-dispatched; never mutates the original snapshot | Scope/requirements change mid-run |
| `miah reject <run-id> --rework <units>` | At the final gate, routes specific units back into bounded rework | When the approval package isn't acceptable, but the run should continue |

Miah also steers automatically within its authority: deadline refusal terminates work past its bound, bounded rework re-dispatches failed units, and escalations pause the run when a decision exceeds it. If an in-flight agent is going the wrong way, don't correct it mid-task — stop (or answer the escalation), then re-dispatch with a changed packet via rework or amend.

See [`docs/architecture/dispatch-and-isolation.md`](./docs/architecture/dispatch-and-isolation.md) (packet, deadline, reconciliation) and [`docs/architecture/state-machine-reference.md`](./docs/architecture/state-machine-reference.md) (phases, `operator_decision` events).

## Resuming after a crash

Kill the machine, close the terminal, lose the session — nothing is lost. The next `miah run` replays the journal, reconciles any in-flight dispatches, and continues from the reconstructed state. This is the kill-drill-verified core invariant: **resume is the only implementation** (there is no separate resume code path). See [`docs/architecture/journal-and-recovery.md`](./docs/architecture/journal-and-recovery.md).

## Where to go deeper (reading order)

For an **operator** or **agent driving Miah**:

1. [`README.md`](./README.md) — orientation, install/build, layout.
2. [`docs/architecture/README.md`](./docs/architecture/README.md) — index of the verified architecture doc set.
3. [`docs/architecture/system-overview.md`](./docs/architecture/system-overview.md) — layered architecture, primary flow, core invariants.
4. [`docs/architecture/state-machine-reference.md`](./docs/architecture/state-machine-reference.md) — exact command surface, phases, journal events, exit codes.
5. [`docs/architecture/admission-and-preflight.md`](./docs/architecture/admission-and-preflight.md) + [`docs/architecture/journal-and-recovery.md`](./docs/architecture/journal-and-recovery.md) — what a plan must look like, what resumption means.
6. [`VISION.md`](./VISION.md) — canonical product definition; read before making judgment calls about scope.

For an **agent working inside this repo** (maintaining Miah itself), also: [`AGENTS.md`](./AGENTS.md) (phase-aware working rules), [`CONCEPTS.md`](./CONCEPTS.md) (vocabulary), [`docs/architecture/maintenance-guide.md`](./docs/architecture/maintenance-guide.md) (how to change the system), and the problem-history store [`docs/solutions/patterns/`](./docs/solutions/patterns/).

Prefer a visual explainer over raw docs? [`output-html/miah-how-it-works-2026-08-09.html`](./output-html/miah-how-it-works-2026-08-09.html) is an interactive, self-contained walkthrough.
