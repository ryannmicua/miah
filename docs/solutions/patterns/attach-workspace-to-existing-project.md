---
title: "Paseo workspaces must attach to an existing project — never auto-derive"
date: 2026-08-07
category: patterns
problem_type: knowledge
component: paseo-orchestration
tags: [paseo, workspace, project, attach, adoption, scratch, auto-derive, cross-project]
applies_when: "Any orchestration loop that creates Paseo workspaces — probe/test scratch, adopting external worktrees (OpenCode-created, manual), new implementation worktrees — and every time a `paseo run` would otherwise land in an unrooted directory (scratch/temp dirs outside any known repo root)."
---

# Paseo workspaces must attach to an existing project — never auto-derive

> **Cross-project knowledge.** This pattern is staged in the Miah repo because the validating incident happened here, but it is explicitly cross-project: it applies to any tool that orchestrates Paseo workspaces for scratch, probe, or adoption workflows — implementation loops, substrate probes, scheduled agents, external worktree adoption. The operator will synthesize it into other projects later.

## Context

During implementation of the Miah plan, an orchestrated build loop used Paseo agents with worktree isolation. The substrate probe — a test that dispatches a throwaway agent to a scratch repo to verify post-termination workspace immutability — created its scratch repos under `%TEMP%\miah-probe-repo-<random>` and dispatched with `paseo run --new-workspace worktree`. Each run auto-derived a **new Paseo project record** (19 orphans accumulated in `~/.paseo/projects/projects.json`) because the daemon's project resolution found no existing project rooted at the temp dir.

The immediate fix: one stable scratch path (`%TEMP%\miah-probe-scratch`) so at most one project ever derives, plus best-effort teardown. The cleaner long-term mechanism — the rule this doc captures — is to **attach the scratch workspace explicitly to an existing project** using the same call used to adopt real worktrees.

## Guidance

Five rules keep the project topology honest. Each is independent.

**1. Workspaces are created with an explicit project.**
`paseo workspace create --project <projectId> --isolation local --path <dir>` is the only creation path that pins the project. Pass the **opaque `projectId`** (e.g. `prj_dbfcd3c15cc04990` or `remote:github.com/owner/repo`) read from `~/.paseo/projects/projects.json` — never the display name. Display names can collide and are not the lookup key.

**2. Run agents with `--workspace <id>`.**
The run inherits the workspace's project. Avoid `paseo run --new-workspace worktree` with a fresh cwd — it auto-derives a project from the cwd root when none matches. Avoid bare `paseo run --cwd <new-dir>` for scratch work for the same reason. Create the workspace once (rule 1), then target it by id on every dispatch.

**3. Adopting an existing worktree uses `--isolation local` + existing path.**
The server detects worktree placement from the path and reports isolation `worktree` correctly. Do **not** pass `--isolation worktree` when adopting — that creates a brand-new Paseo-managed worktree under `~/.paseo/worktrees/` instead of wrapping the one you chose. Skip paths already under `~/.paseo/worktrees/` and paths already backed by a workspace (create-or-reuse, never double-wrap).

**4. For real product dispatches, root-matching usually attaches correctly.**
A dispatch with cwd inside a known repo root resolves to that repo's project automatically — no manual `--project` needed. The auto-derive trap is **specifically scratch/temp dirs outside any known repo root**. Do not over-correct real dispatches with manual project pins; do correct anything in `%TEMP%` or ad-hoc checkout dirs.

**5. Scratch work pattern: one workspace, reused, best-effort teardown.**
Pre-create one workspace attached to the target project (rule 1), then reuse it across runs (rule 2). Teardown = **archive the workspace**. Cleanup must run best-effort in a `finally`/teardown block so a probe failure does not skip it — a poisoned scratch workspace leaks across runs the same way an orphan project does, just one level down.

## Why This Matters

Auto-derived projects are inert metadata but they **pollute the project list, hide the real workspace topology, and accumulate silently** — one per run. A project list full of `miah-probe-repo-*` orphans obscures which projects are real and makes the topology a lie: the daemon reports nineteen projects where there is one real one.

Attaching to an existing project keeps the topology honest: **one project, workspaces under it, agents scoped to it.** The probe incident produced 19 orphan project records before the fix landed; each one is a permanent entry in `projects.json` that no `paseo project archive` command can remove (see limitation below). The cost compound — every future `paseo project list`, every human scanning for real projects, every tool that reasons over the project set pays for each auto-derive.

This is the same topology-discipline principle Miah institutionalizes one level down: the supervisor tracks one plan, units scoped to it, agents scoped to units. Letting the workspace substrate silently mint projects is the substrate leaking its own bookkeeping into the project namespace — the same class of drift the disk-first loop design (see sibling `disk-first-paseo-loop.md`) refuses to tolerate for work state.

## When to Apply

- Any orchestration loop that creates Paseo workspaces — probe/test scratch, adopting external worktrees (OpenCode-created, manual), new implementation worktrees.
- Any time a `paseo run` would otherwise land in an unrooted directory (`%TEMP%` dirs, ad-hoc checkouts, scratch sandboxes).
- When adopting a worktree created by another tool (git worktree, OpenCode, manual `git clone`) into the Paseo workspace set — use `--isolation local`, never `--isolation worktree`.

## Examples

**Wrong way (from the probe incident):**
- `paseo run --new-workspace worktree --worktree-mode branch-off` from a `%TEMP%\miah-probe-repo-<random>` cwd → auto-derives a new project record per run, 19 orphans accumulated.

**Right way (preferred — explicit attach, reusable scratch):**
- Once: `paseo workspace create --project prj_dbfcd3c15cc04990 --isolation local --path %TEMP%\miah-probe-scratch` → returns `<workspaceId>`.
- Every dispatch after: `paseo run --workspace <id> ...` — inherits the attached project, derives nothing.
- Teardown: archive `<id>` best-effort in a `finally` block.

**Right way (adopting an existing worktree):**
- `paseo workspace create --project remote:github.com/owner/repo --isolation local --path <existing-worktree-path> --title <branch>` — the server reports isolation `worktree` from path detection; the chosen worktree is wrapped, not duplicated.

**Known limitation:**
- No `paseo project archive` or delete command exists as of Paseo v0.3.0-beta.2. Orphan project records can only be removed by **editing `~/.paseo/projects/projects.json`** — risky while the daemon runs (it may rewrite the file); leave the orphans or edit only while the daemon is idle. A `--project` flag on `paseo run` / `--new-workspace` that pins the project without a prior `workspace create` is a legitimate feature request, since it would let scratch dispatches attach in one call instead of two.