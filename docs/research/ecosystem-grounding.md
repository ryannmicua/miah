# Ecosystem Grounding Notes

> Grounding collected 2026-08-05 for Miah Phase 2 brainstorming. Complements `research/paseo-capabilities.md` (Paseo docs) and `research/agent-orchestration-research.md` (field state of the art). This file adds: the CE unified-plan format (D3), the operator's actual Paseo environment (D2/D8), the prior-art effort that Miah likely supersedes, and the evidence conventions already in use (D5).
>
> **Security note:** `~/.paseo/config.json` contains a plaintext OpenAI API key and the daemon password hash. Never copy these into planning artifacts; treat `~/.paseo/` as secrets-bearing.

## 1. CE unified-plan convention — the plan input format (D3)

Source: `heypogi/external/compound-engineering/skills/ce-plan/references/plan-sections.md` (459 lines) and `ce-work/SKILL.md`. `AGENTS.md` already mandates plans in `docs/plans/` using this convention.

**Artifact contract (`ce-unified-plan/v1`):**
- Metadata (frontmatter, stable names): `title`, `type`, `date` (required); `artifact_contract: ce-unified-plan/v1`, `artifact_readiness: requirements-only|implementation-ready`, `product_contract_source`, `execution: code|knowledge-work`, `origin`, `deepened` (optional). **Plans carry no `status` field** — readiness is document completeness, not work progress. Whether a plan shipped is derived from git.
- `implementation-ready` = all five sections complete AND no launch-blocking open question. Blocking vs deferred questions are marked explicitly.

**Stable section registry** (consumers wayfind by heading/anchor scan before reading long bodies):

| Section | Contents |
|---|---|
| Goal Capsule | Objective, authority hierarchy, stop conditions, execution profile, tail ownership |
| Product Contract | Summary, Problem Frame, Requirements (R-IDs), Actors (A-IDs), Flows (F-IDs), Acceptance Examples (AE-IDs), Scope Boundaries |
| Planning Contract | KTDs (numbered KTD-IDs), design, assumptions, sequencing; `session-settled: user-directed|user-approved` annotations record decision provenance |
| Implementation Units | U-ID work packets: Goal, Requirements, Files, Approach, Test Scenarios, Verification; Unit Index for ~10+ units; `depends-on` |
| Verification Contract | Repo-specific test commands and quality gates; measurable thresholds for optimization-shaped goals |
| Definition of Done | Global + per-unit done criteria, including cleanup of abandoned-attempt code |
| Appendix (optional) | Research/raw notes |

**ID rules:** stable R/U/KTD/A/F/AE-IDs, never renumbered. Plain prefixes (`R1.`, `U1.`). Repo-relative paths only. Rules live at one owning entry; other layers cite IDs (R wins on behavior, KTD wins on mechanism).

**Execution protocol precedent (`ce-work`):** refuses `requirements-only`; executes via **bounded unit packets** — the worker receives Goal Capsule, DoD, the unit's section, its Verification Contract entries, and cited R/F/AE/KTD excerpts — *never* "read the whole plan". A downstream worker may narrow authority, never broaden it.

**Implication for Miah:** the "immutable plan snapshot" (VISION) has a natural target format: a `ce-unified-plan/v1` artifact. The prior-art effort (below) already designed a **Step Extraction Contract**: parse `## Implementation Units` H3 headings matching `U<number>. <title>`, numeric ascending, gaps accepted; required fields Goal/Files/Approach; deferred units excluded by title; store as `steps.json` at admission, never re-parse mid-run.

## 2. Paseo runtime inventory (D2/D8) — this machine, live 2026-08-05

**Daemon:** running, v0.3.0-beta.1, listen `0.0.0.0:6767`, relay enabled (`wss://relay.paseo.sh:443`), password auth set, web UI enabled, browser tools enabled, `daemon.mcp.injectIntoAgents: true` (Paseo tools injected into every agent Paseo launches), CORS for `app.paseo.sh`. `~/.paseo/worktrees/` has 3 managed worktrees. About a dozen idle agents exist; recent idle agents used claude-opus-5, codex/gpt-5.6-sol, and opencode-go/deepseek-v4-flash.

**Providers installed (resolved paths + versions):**
- Claude: `~/.local/bin/claude.exe` (2.1.222)
- Codex: `AppData/Roaming/npm/codex.CMD` (codex-cli 0.144.6)
- OpenCode: `AppData/Roaming/npm/opencode.CMD` (1.18.13)
- Copilot and Pi: disabled in config.

**Orchestration preferences (`~/.paseo/orchestration-preferences.json`) — role → provider/model mapping already established:**

| Role | Provider/Model |
|---|---|
| impl | opencode-go/deepseek-v4-flash (auto_accept, fast_mode, mode=build) |
| planning | codex/gpt-5.6-sol |
| research | opencode-go/deepseek-v4-pro (thinking=max) |
| audit | opencode-go/glm-5.2 (deliberate cross-family contrast from impl) |
| ui | opencode-go/kimi-k3 |

Plus standing rules: committees/second opinions use a different model family than the primary; scheduled agents use impl unless task needs research/audit reasoning; prefer async workflows with `notifyOnFinish=true`, no polling; use worktree isolation when running multiple agents in parallel on the same repo.

**Implication for Miah:** a ready-made D2 candidate exists — role→model map, async-first, worktree isolation, cross-family audit (all operator-authored preferences, not prior-art decisions).

## 3. Prior art: the "Paseo Plan Execution Supervisor" effort (heypogi, July–Aug 2026)

**Staged out of brainstorming context by operator decision.** A direct predecessor of Miah was planned (implementation-ready) but never implemented. Its decisions and designs live in `research/prior-art-paseo-supervisor.md`, which carries a **DO NOT READ** marker and is opened only at the brainstorm's cross-check phase (protocol in `docs/planning-brief.md` → "Prior art handling").

Location pointers only (nothing here anchors decisions):
- Plan (merged to heypogi main): `heypogi/docs/plans/2026-07-28-001-feat-paseo-plan-execution-supervisor-plan.md`
- Open Items Register (main): `heypogi/docs/open_items_register.md` (OIR-001..004)
- Unmerged designs (worktree exists): `heypogi/.worktrees/feat-paseo-plan-exec-supervisor/docs/` — `specs/` (observer sidecar, delegated-work result contract), `findings/` (readiness review)
- One factual note kept here because it is Paseo API reference, not design: usage telemetry via `paseo agent inspect --json <id>` exposes PascalCase `LastUsage` (`InputTokens`, `OutputTokens`, `CachedTokens`, `CostUsd`), accounting must use deltas, and lifecycle JSON ≠ work-result JSON. (Verified 2026-07-29 vs Paseo v0.2.3; daemon now v0.3.0-beta.1 — re-verify.)

## 4. Evidence conventions already in use (D5 precedents)

What "durable evidence" means in this operator's ecosystem today:

- **`docs/solutions/<category>/<slug>.md`** — ce-debug/ce-compound solution docs. Structured YAML frontmatter: `title`, `date`, `category` (e.g. `runtime-errors`), `module`, `problem_type`, `root_cause`, `resolution_type`, `severity`, `related_components`, `tags`, `symptoms`. Example: `heypogi/docs/solutions/runtime-errors/paseo-daemon-inherits-opencode-server-password.md` (a real Paseo/OpenCode integration bug: daemon inherited `OPENCODE_SERVER_PASSWORD`, every spawned opencode server 401'd — relevant ops knowledge for Miah's environment).
- **`docs/findings/`** — review outputs (adversarial review JSON, readiness findings md).
- **`docs/specs/`** — design inputs (sidecar, result contract).
- **`docs/open_items_register.md`** — canonical register of blockers/risks/issues with status lifecycle (`open → in progress → monitoring → resolved → closed`) and OIR-IDs. **Miah's escalation/resume state could mirror this pattern.**
- **`docs/session_digests/`** — structured session digests.
- **`docs/testing-runbook.md`** — mandated by the `testing-runbook-creator` skill (last-tested date, step-by-step recipe, safe/destructive actions, verification commands with expected output, gotchas) but **not yet present** in heypogi.
- **`CONCEPTS.md`** — ce-compound glossary of project vocabulary (e.g., "Supervisor", "Intended State", "Session-Scoped Environment") with a "not to be confused with" discipline for ambiguous terms.

**Implication for Miah:** D5 can compose from existing conventions: structured-frontmatter evidence docs, an OIR-style register, runbook-style verification commands with expected output, and the prior effort's JSON-manifest + dedicated-files result contract. No new conventions need inventing from scratch.

## 5. Gaps and loose ends

- **Session-history probe bug:** `opencode-session-history` probe.py crashes (`AttributeError: 'bool' object has no attribute 'get'` in `message_summary_files`) on some sessions' malformed summary — worth fixing if we want deeper history mining.
- `docs/findings/` is empty on heypogi main; the rich findings/specs live only in the worktree (unmerged). If Miah supersedes the prior plan, consider absorbing these designs into the Miah plan rather than losing them.
- No `docs/testing-runbook.md` yet anywhere — evidence conventions are partially exercised.
- The prior effort pinned Paseo v0.2.3; daemon is now v0.3.0-beta.1 — **verify CLI contracts again during planning** (e.g., usage telemetry shape may have changed).
- OpenBrain has essentially no Miah-related captured thoughts (one weak match) — no constraint there.
