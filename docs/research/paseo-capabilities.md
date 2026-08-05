# Paseo Capabilities — Research Notes for Miah Brainstorming

> What Paseo offers that could serve Miah, gathered from the live docs on 2026-08-05.
> Sources: `paseo.sh/docs/orchestration.md`, `orchestration-workflows.md`, `skills.md`, `cli.md`, `mcp.md`.
> This is input for Phase 2 brainstorming (feeds planning-brief decisions D1, D2, D4, D5, D6, D7).
> It decides nothing — it reports capabilities and flags where Paseo maps to (or misses) Miah's requirements.

## What Paseo is (mental model)

- A **daemon** that supervises AI coding-agent processes (Claude, Codex, OpenCode, Copilot). All clients — desktop app, mobile, CLI, web UI — talk to the daemon over HTTP/WS on `127.0.0.1:6767`.
- The daemon persists agent state (`~/.paseo/agents/<id>.json`), survives agent death, and **restart keeps running agents alive**.
- It exposes an **MCP server** (and CLI, same surface) that lets *an agent* orchestrate *other agents*. Tool catalog below.
- Paseo is a general **agent supervisor**, not a plan supervisor. Miah's plan validation, journal, acceptance gates, and escalation logic would be Miah's own; Paseo is the substrate for agent lifecycle + visibility.

## Key orchestration capabilities

### Cross-provider subagents (role independence)
- An orchestrator agent can spawn workers on **any configured provider/model** — one model plans, another implements, another reviews. Native subagents can't do this (they stay inside one provider).
- Agent creation default: `create_agent` without `workspaceId` → subagent in the caller's workspace. Passing a `workspaceId` places it elsewhere *without* changing parentage.
- Workspace decides *where* work happens; parentage decides *who owns* it.
- Independent review is achievable: docs show a pattern where a reviewer is launched in the **same workspace** after a builder finishes — it "sees the worker's files without sharing its conversation context, which makes the review more independent." (Matters for VISION: testers/reviewers independent of builders.)
- Detach (subagent → top-level) exists in app/CLI (`paseo agent detach`) but is **not** an MCP creation mode and there is **no MCP detach tool**.

### Agent lifecycle tools (MCP/CLI)
- `create_agent`, `send_agent_prompt` (follow-ups), `get_agent_status`, `list_agents`, `get_agent_activity` (curated timeline summary), `cancel_agent` (abort current run, keep agent alive), `archive_agent`, `kill_agent`, `update_agent` (name, labels, mode/model/thinking/features), `set_agent_mode` (e.g. plan/bypass).
- CLI equivalents: `paseo run`, `paseo send <id>`, `paseo ls [-a -g --json]`, `paseo attach <id>` (live stream), `paseo logs <id> [--tail N] [--filter tools] [-f]`, `paseo wait <id> [--timeout N]`, `paseo stop <id>`, `paseo agent mode <id>`, `paseo agent detach <id>`.
- `paseo send <id> --image` supports attaching a screenshot to a follow-up.
- Daemon tracks which agent is calling, so CLI-created workers get the same workspace/parent defaults as MCP-created ones.

### Workspaces and isolation
- `create_workspace` supports `local` or `worktree` isolation; worktree modes: `branch-off` (with `--new-branch`/`--base`), `checkout-branch`, `checkout-pr` (with `--forge`).
- Pattern for **parallel implementation without collisions**: one worktree-isolated workspace per independent unit, all off `main`.
- Pattern for **fan-out research/read-only work**: share one workspace, no edits.
- Workspace scripts (`paseo.json`): Paseo manages a launcher + supervised terminal per script, with port/proxy/health reporting — could host long-running services the run needs.

### Structured, scriptable agent output
- `paseo run --output-schema <json-schema>` returns **only** output matching the schema (file path or inline). Docs demonstrate an implement-then-verify loop that parses a boolean verdict from a verifier agent. **Cannot be combined with `--background`.**
- Most commands accept `--json`, `--format yaml`, `-q/--quiet` for scripting.

### Schedules vs heartbeats (both cron-backed, different semantics)
- **Schedules** start a *new agent per run* — standalone cron jobs (daily triage). Full CRUD: `create/list/inspect/pause/resume/update/delete_schedule`, `schedule_logs`, `run_schedule_once`. CLI: `paseo schedule create --every 30m "..."`, `ls`, `pause`.
- **Heartbeats** send a *prompt back into the same agent* on a cadence — self-waking loops (babysit CI, continue a refactor, watch a deploy, retry). MCP heartbeats are ephemeral (create/delete only; to change, delete + recreate).
- Heartbeat semantics matter for Miah's resumability: a heartbeat continues *that agent's own conversation*, so it only resumes Miah if Miah itself is the agent carrying the heartbeat.

### Permissions (operator gate hook)
- `list_pending_permissions`, `respond_to_permission` (approve/deny). CLI: `paseo permit ls / allow <id> / deny <id> --all`.
- Paseo's app/mobile/web UI already lets the operator see agents, workspaces, the Subagents track, respond to permission prompts, and manage settings remotely via pairing offer URLs (end-to-end encrypted relay).

### Providers and models
- `list_providers`, `list_models`, `inspect_provider` — discover available provider/model IDs at runtime (no hardcoding).

## CLI patterns directly relevant to Miah's run loop

From `cli.md`, the documented **hierarchical decomposition** pattern (lead agent spawns workers, waits, synthesizes):

```bash
agent_id=$(paseo run --background --quiet --title api-agent "implement the API")
paseo wait "$agent_id"
paseo logs "$agent_id" --tail 5
```

Documented **implement + verify loop** (verifier returns a schema-checked boolean verdict):

```bash
while true; do
  paseo run --provider codex "make the tests pass" >/dev/null
  verdict=$(paseo run --provider claude --output-schema '{"type":"object","properties":{"criteria_met":{"type":"boolean"}},"required":["criteria_met"],"additionalProperties":false}' "ensure tests all pass")
  if echo "$verdict" | jq -e '.criteria_met == true' >/dev/null; then
    echo "criteria met"
    break
  fi
done
```

These are the building blocks Miah could compose: spawn specialist → wait → collect structured result → decide.

## Bundled orchestration skills (packaged workflows)

Installed via `npx skills add getpaseo/paseo` or desktop Settings → Integrations. Paseo tool injection is a per-host toggle (Settings → Agents → **Enable Paseo tools**, or `daemon.mcp.injectIntoAgents: true`).

- `/paseo` — foundational reference for creating agents/workspaces; dependency of the others.
- `/paseo-handoff` — hands a task to another agent with a self-contained briefing (task, context, files, state, tried, decisions, acceptance criteria, constraints); supports worktree-isolated workspaces; provider from orchestration preferences.
- `/paseo-loop` — worker/verifier cycle until an exit condition; shell check and/or verifier prompt; `--max-iterations` / `--max-time` bounds.
- `/paseo-committee` — two analysis-only agents produce plans; orchestrator implements, sends diff back for review.
- `/paseo-advisor` — single analysis-only second-opinion agent.

These are user-facing slash-command skills. Miah may use the *tools* behind them rather than the skills themselves.

## Where Paseo maps to Miah's requirements (and where it doesn't)

| Miah requirement (VISION) | Paseo capability | Gap / caveat |
| --- | --- | --- |
| Resumable across crashes | Daemon owns agent lifecycle; agent state persisted in `~/.paseo/`; daemon restart keeps agents alive; schedules are daemon-level | Paseo resumes *agents*, not Miah's run workflow. Miah's journal + run-state reconstruction (D4) is still Miah's job. |
| Specialist roles, independent testing/review (D2) | Cross-provider subagents; review agent in same workspace with fresh context; `set_agent_mode` | Independence is by *context*, not enforced structurally — Miah must still enforce role discipline and evidence rules (D5). |
| Parallel independent units (D2) | One worktree-isolated workspace per unit; parallel `paseo run --background` + `wait` | Miah must map units→workspaces and track dependencies. |
| Durable evidence (D5) | `--output-schema` enforces structured agent output; `get_agent_activity` / `logs --filter` are inspectable; supervised terminals can capture test output | Evidence *contract* (formats, location, sufficiency) is Miah's to define. Paseo gives raw material + one structured-output lever. |
| Observable (D6) | App/mobile/web UI show agents, workspaces, Subagents track; CLI `ls`/`logs`/`attach`; remote pairing (encrypted relay) | Operator still needs a Miah-level status view (which unit, which gate, cost). |
| Operator approval gates (D6) | `permit` flow (approve/deny) is the closest built-in gate | Gates are binary approve/deny on permission prompts, not Miah's escalate/approve/rework gates. Miah likely needs its own gate mechanism (or reuse permit where applicable). |
| Cost/time/retry limits (D7) | `/paseo-loop` `--max-iterations`/`--max-time`; schedule limits | No general per-agent cost/time budget in the core catalog; Miah's threshold logic (D7) is Miah's own. |
| Append-only journal (D4) | `paseo logs`/agent state are durable, but mutable/owned by Paseo | Miah's own append-only journal + immutable plan snapshot (D3) is Miah's responsibility. |
| One active plan, immutable snapshot | Workspaces are per-repo and reusable; no plan concept | Entirely Miah's layer. |

## Operational gotchas to remember

- **Restarting the daemon kills all running agents** — never restart without operator approval.
- Provider not found: Paseo's PATH differs from your terminal's (asdf/mise/nvm). Fix login-shell env, then restart daemon. Test with `which <cmd>` in a fresh terminal.
- `config.json` is read at daemon startup only — edit then restart.
- Shell aliases/functions don't work as provider commands; Paseo runs binaries directly.
- `--output-schema` cannot combine with `--background`.
- MCP has no detach tool; detach is app/CLI only.
- Agent-created subagents inherit the calling agent's env (PATH issues propagate).

## Open questions Paseo raises for brainstorming

1. **D1**: Could Miah run as *an agent that drives Paseo* (via injected Paseo tools/CLI), with the daemon as the durable substrate that outlives any single session? Or does Miah need its own supervisor process?
2. **D2**: Use Paseo subagents for builders/testers/reviewers? Which roles on which providers/models? Does Miah spawn all specialists itself, or does a lead agent delegate?
3. **D4**: Consume Paseo's `get_agent_activity`/`logs`/`--output-schema` results as journal entries, or keep journal fully independent of Paseo?
4. **D5**: Enforce the evidence contract with `--output-schema` (schema-validated agent output) + supervised terminals for test runs?
5. **D6**: Ride Paseo's `permit` flow for some operator gates, or build a Miah-native gate (watched journal + prompt)? Use pairing/relay for remote operator access?
6. **D7**: Any Paseo-native limits worth reusing, or are Miah's thresholds purely custom?
