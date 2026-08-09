---
title: "dispatch.default_workspace config field — wire attach-to-project into the adapter layer, not just the CLI"
date: 2026-08-08
category: patterns
problem_type: knowledge
component: paseo-adapter
tags: [miah, paseo, adapter, dispatch, default-workspace, attach-to-project, config-snapshot, cross-project]
applies_when: "An adapter dispatches agents via `paseo run --new-workspace worktree` and you want to route some or all dispatches through an existing Paseo workspace/project instead of auto-deriving a new one — especially when the dispatch is driven by the run's config, not by a one-off CLI flag the operator passes per dispatch."
---

# dispatch.default_workspace config field — wire attach-to-project into the adapter layer

> **Cross-project knowledge.** This pattern is staged in the Miah repo because the validating implementation happened here, but it applies to any adapter that dispatches Paseo agents and wants to control workspace attachment from the config layer rather than the CLI. The operator will synthesize it into other projects.

## Context

The sibling pattern `attach-workspace-to-existing-project.md` documents the CLI-level rule: create the workspace once with `paseo workspace create --project <id> --isolation local --path <dir>`, then target it by id on every dispatch with `paseo run --workspace <id>`, and never let `paseo run --new-workspace worktree` auto-derive a project from an unrooted cwd (the 19-orphan-project incident).

That pattern lives at the workspace-management layer — the operator creates the workspace by hand and passes the id. It does not answer: **how does the adapter, driven by the run's config, know which workspace to attach to?** The Miah v1 implementation answered this in the `fix(U4): adapter workspace binding and dispatch.default_workspace` commit, shipped in PR #1 (squash commit `d7eac30`; session `ses_01effaed5ffeUd5QX1vg3YQPva`, 2026-08-08) by adding a `dispatch.default_workspace` field to the run config and a `defaultWorkspaceOf()` resolver in `src/dispatch.ts` that the adapter reads on every dispatch.

The fix touched three files:

1. **`src/types.ts`** — `DispatchConfig.default_workspace?: string`. A single optional field. Absent/undefined means the U4 `--new-workspace worktree --worktree-mode branch-off` contract applies (the default for fresh runs that want their own worktrees). Present means every dispatch attaches to the named workspace via `--workspace <id>` and does NOT pass `--new-workspace`.

2. **`src/dispatch.ts`** — `defaultWorkspaceOf(ctx: DispatchContext): string | undefined`. Priority: the caller-provided `ctx.config` (`dispatch.default_workspace`), then the run's admission-time config snapshot (manifest `config_snapshot`, R80 — so a run in progress keeps the config it was admitted with). Absent everywhere → `undefined`, and the U4 new-worktree contract applies.

3. **`src/adapter/paseo.ts`** — `PaseoLaunchOptions.workspaceId?: string`. When set, the launch uses `--workspace <id>` and skips `--new-workspace` / `--worktree-mode`. The adapter's `launch()` function becomes: if `opts.workspaceId` → `args.push("--workspace", opts.workspaceId)`; else → `args.push("--new-workspace", opts.workspace ?? "worktree")` plus `--worktree-mode`. One branch, two dispatch paths.

The resolver reads the config snapshot for a run in progress (R80) so a config change after admission does not silently re-route dispatches — the run keeps the config it was admitted with, matching the disk-first invariant (sibling `disk-first-paseo-loop.md`): the manifest is the state of record, not the live config file.

## Guidance

Four rules keep the adapter-level attach-to-project honest. Each is independent.

**1. Put the workspace id in the run config, not in the adapter's own state.**
The adapter is a dispatch mechanism; it does not own policy. The workspace id lives in `dispatch.default_workspace` on the `DispatchConfig`, which is part of the run's config (`~/.miah/config.json` or run-manifest overrides). The adapter reads it; it does not store it. This keeps the config the single source of truth — an operator who changes `dispatch.default_workspace` changes where dispatches attach, without touching the adapter.

**2. Read the admission-time config snapshot for a run in progress — not the live config file.**
A run is admitted with a config; that config is snapshotted into the manifest (R80). A dispatch during the run reads the snapshot, not the live file — so a config change after admission does not silently re-route dispatches. The resolver's priority is: caller-provided `ctx.config` (for tests and overrides), then `manifest.config_snapshot.dispatch.default_workspace`, then absent. A run that was admitted with `default_workspace: undefined` keeps creating new worktrees even if the operator later sets `default_workspace` in the live config — the run's contract was fixed at admission.

**3. The adapter's `launch()` branches on the option, not on a heuristic.**
`workspaceId` is present → `--workspace <id>` (attach). Absent → `--new-workspace worktree --worktree-mode branch-off` (create). One branch, two dispatch paths. Do not infer "the cwd is unrooted, so auto-attach" — that's exactly the heuristic the sibling pattern refuses (auto-derive is the trap). The adapter is a switch, not a guesser.

**4. The field is optional and absent-by-default — the default contract is new-worktree.**
`default_workspace?: string` means absent is a valid, meaningful value: "this run wants its own worktrees per dispatch." The U4 new-worktree contract is the default; attaching to an existing workspace is the opt-in. An operator who never sets the field gets the same behavior as before the fix — no silent behavior change for existing runs.

## Why This Matters

The CLI-level attach-to-project pattern (sibling `attach-workspace-to-existing-project.md`) protects the project topology from orphan-project pollution — but it is a manual discipline: the operator must remember to create the workspace and pass the id on every dispatch. An adapter that always uses `--new-workspace worktree` auto-derives a project on every dispatch from an unrooted cwd, and the orphans accumulate silently.

The config field makes the discipline automatic: the operator sets `dispatch.default_workspace` once in the run config, and every dispatch from that run attaches to the named workspace. The resolver reads the config snapshot (R80) so the run's workspace policy is fixed at admission — no mid-run re-routing. The adapter's branch is explicit — one path for attach, one path for create — so the operator can audit which dispatches attached and which created.

This is the same topology-discipline principle the sibling pattern institutionalizes at the CLI level, now wired into the adapter so it is automatic, not manual. The project topology stays honest: one project, workspaces under it, dispatches scoped to it — by config, not by operator memory.

## When to Apply

- Any adapter that dispatches Paseo agents and wants to route dispatches through an existing workspace from the config layer.
- Any run whose dispatch policy should be fixed at admission (read the config snapshot, not the live file) — R80 or equivalent.
- Any adapter that today always uses `--new-workspace worktree` and needs an opt-in attach path that does not change the default behavior for existing runs.

## Examples

**Wrong way (before the fix):**
- `src/adapter/paseo.ts` `launch()` unconditionally pushes `--new-workspace worktree --worktree-mode branch-off`. Every dispatch from an unrooted cwd auto-derives a project. Orphans accumulate.
- The operator must pass a per-dispatch CLI flag to attach to an existing workspace — there is no config-level mechanism, so the operator must remember every time.

**Right way (fix commit in PR #1, squash `d7eac30`):**
```ts
// src/types.ts — one optional field
export interface DispatchConfig {
  // ... existing fields ...
  default_workspace?: string;
}

// src/dispatch.ts — resolver reads config then manifest snapshot
function defaultWorkspaceOf(ctx: DispatchContext): string | undefined {
  const fromCtx = ctx.config?.dispatch?.default_workspace;
  if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
  const manifest = readManifest(ctx.store.layout);
  const fromSnapshot = manifest?.config_snapshot?.dispatch?.default_workspace;
  return typeof fromSnapshot === "string" && fromSnapshot.length > 0
    ? fromSnapshot : undefined;
}

// src/adapter/paseo.ts — explicit branch, not a heuristic
if (opts.workspaceId !== undefined) {
  args.push("--workspace", opts.workspaceId);
} else {
  args.push("--new-workspace", opts.workspace ?? "worktree");
  args.push("--worktree-mode", opts.worktreeMode ?? "branch-off");
}
```
- `test/adapter.paseo.test.ts` (PR #1, squash `d7eac30`, +14 lines): `workspaceId` set → args contain `--workspace <id>`, not `--new-workspace`.
- `test/dispatch.test.ts` (PR #1, squash `d7eac30`, +84 lines): `defaultWorkspaceOf` reads from `ctx.config`, then from `manifest.config_snapshot`, then absent; dispatch passes `workspaceId` to the adapter accordingly.
- Sibling pattern `attach-workspace-to-existing-project.md` covers the CLI-level workspace-creation discipline; this pattern covers the adapter-level config-driven attachment. Together they make the topology honest end-to-end.