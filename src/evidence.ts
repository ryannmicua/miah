/**
 * Evidence harvest, custody integration, and T2-T3 continuity (R43-R46, R52,
 * R53, R61, R85, U6).
 *
 * After a specialist terminates, Miah alone harvests the artifacts that carry
 * evidence authority (R45): the git diff of the specialist's worktree against
 * its base commit, the exit code / stdout / stderr of the verification
 * contract commands Miah itself runs, the adapter usage delta taken between
 * the pre-dispatch and post-termination snapshots, and the result envelope
 * (the producer's self-report — an input, never authority). The envelope's
 * self-reported file hashes are navigation hints only (R43).
 *
 * Every harvested artifact is SHA-256 content-hashed and appended to the
 * run's hash-chained custody sequence (R85) in harvest order. Evidence is
 * written to the run store's `evidence/<unit>/<take>/<role>/` directory.
 * Test code the plan did not declare in `creates:` is partitioned as
 * evidence-only and is never a deliverable (R53).
 *
 * The harvest also runs the per-unit postflight assertion (R61): a declared
 * `creates:` path that does not exist in the worktree is recorded as a
 * `gap_recorded: missing-declared-output`. The T2-T3 continuity check (R46)
 * pairs a workspace hash taken after harvest with one taken just before
 * integration; a divergence is `gap_recorded: T2-T3-continuity`. A broken
 * custody chain is an evidence gap (R45) via `verifyCustodyChain`.
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { PaseoUsage } from "./adapter/paseo";
import {
  appendToChain,
  computeArtifactHash,
  custodyChainPath,
  readChainFile,
  unitFromArtifact,
  verifyChain,
  writeChainFile,
  type CustodyHeader,
} from "./custody";
import type { ResultEnvelope } from "./envelope";
import { normalizeRelPath, runPostflight, type PostflightResult } from "./postflight";
import type { RunStore } from "./run-store";
import type { JournalEvent, PlanUnit, SpecialistRole } from "./types";

/** Adapter usage telemetry snapshot (PascalCase deltas mapped here). */
export type UsageSnapshot = PaseoUsage;

/** Delta between a pre-dispatch and post-termination usage snapshot. */
export interface UsageDelta {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
}

/**
 * Compute the usage delta from the pre-dispatch to the post-termination
 * adapter snapshot. A field is `null` when either side lacks the value (an
 * honest "cannot compute"), never a fabricated zero.
 */
export function computeUsageDelta(pre: UsageSnapshot, post: UsageSnapshot): UsageDelta {
  const diff = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : b - a;
  return {
    inputTokens: diff(pre.inputTokens, post.inputTokens),
    outputTokens: diff(pre.outputTokens, post.outputTokens),
    cachedTokens: diff(pre.cachedTokens, post.cachedTokens),
    costUsd: diff(pre.costUsd, post.costUsd),
  };
}

/** One verification-contract command result (R45: exit code + stdout/stderr). */
export interface CommandResult {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one verification-contract command. Injectable so tests never depend on
 * the host shell; the default runs `child_process.exec` (R45, U6 approach).
 */
export type CommandRunner = (command: string, cwd: string) => Promise<CommandResult>;

/** Default verification runner: `child_process.exec`, exit code captured. */
export function createExecCommandRunner(): CommandRunner {
  return (command, cwd) =>
    new Promise<CommandResult>((resolve) => {
      cp.exec(
        command,
        { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error !== null && typeof error.code === "number"
              ? error.code
              : error !== null
                ? 1
                : 0;
          resolve({
            command,
            exit_code: code,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
}

/** The worktree diff Miah harvests (R45) plus the changed-file listing. */
export interface WorktreeDiff {
  /** Unified diff of the worktree against its base commit. */
  diff: string;
  /** Changed tracked paths (`git diff --name-only <base>`). */
  changedFiles: string[];
  /** Untracked paths present in the worktree (`git status --porcelain`). */
  untrackedFiles: string[];
  /** The git commands that produced this diff (for audit). */
  commands: string[];
}

/** Reads the worktree diff. Injectable for tests; default uses git. */
export type DiffRunner = (
  worktreeRoot: string,
  baseCommit: string | null,
) => Promise<WorktreeDiff>;

function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error !== null && typeof error.code === "number"
            ? error.code
            : error !== null
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Default diff runner: `git -C <worktree> diff <baseCommit>` nets the worktree
 * against the recorded base commit (A6), `--name-only` lists changed tracked
 * paths, and `git status --porcelain` lists untracked files. Untracked files
 * are reported separately so the harvest record can partition deliverables
 * from evidence-only test code (R53). A missing base commit degrades to
 * `git diff HEAD` (best effort, honest empty on failure).
 */
export function createGitDiffRunner(): DiffRunner {
  return async (worktreeRoot, baseCommit) => {
    const base = baseCommit !== null && baseCommit.length > 0 ? baseCommit : "HEAD";
    const commands = [
      ["-C", worktreeRoot, "diff", base],
      ["-C", worktreeRoot, "diff", "--name-only", base],
      ["-C", worktreeRoot, "status", "--porcelain"],
    ];
    const [diffResult, nameResult, statusResult] = await Promise.all([
      runGit(commands[0], worktreeRoot),
      runGit(commands[1], worktreeRoot),
      runGit(commands[2], worktreeRoot),
    ]);
    const changedFiles = nameResult.stdout
      .split(/\r?\n/)
      .map((line) => normalizeRelPath(line.trim()))
      .filter((line) => line.length > 0);
    const untrackedFiles = statusResult.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("?? "))
      .map((line) => normalizeRelPath(line.slice(3).trim()))
      .filter((line) => line.length > 0);
    return {
      diff: diffResult.stdout,
      changedFiles,
      untrackedFiles,
      commands: commands.map((args) => `git ${args.join(" ")}`),
    };
  };
}

/**
 * Content hash of a workspace's file state (R46, KTD3): every file under the
 * root (excluding `.git/` and `.miah/`) contributes
 * `relpath\0sha256(content)`, sorted by path, hashed together. Deterministic
 * across platforms. `.miah/` is excluded alongside `.git/` because it carries
 * Miah's own transport files (verifier packages, envelopes) — infrastructure
 * output that must never create a false continuity failure (KTD3); the
 * custody chain seals those artifacts individually.
 */
export function workspaceHash(worktreeRoot: string): string {
  const entries: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of children) {
      const entryRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entryRel === ".git" || entryRel.startsWith(".git/")) {
        continue;
      }
      if (entryRel === ".miah" || entryRel.startsWith(".miah/")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, entryRel);
      } else if (entry.isFile()) {
        try {
          entries.push(`${entryRel}\0${computeArtifactHash(fs.readFileSync(full))}`);
        } catch {
          // best effort: a file that cannot be read is not part of the hash.
        }
      }
    }
  };
  walk(worktreeRoot, "");
  entries.sort();
  return computeArtifactHash(entries.join("\n"));
}

/** One harvested artifact on disk inside an evidence dir. */
export interface HarvestArtifactRef {
  /** Filename relative to the evidence dir. */
  file: string;
  /** SHA-256 content hash of the artifact (R85). */
  sha256: string;
}

/** Machine-readable harvest record (R45): what was harvested and its hashes. */
export interface EvidenceRecord {
  schema: "miah/evidence-record/v1";
  unit_id: string;
  role: string;
  take: number;
  attempt: string;
  agent_id: string;
  harvest_ts: number;
  worktree_root: string;
  base_commit: string | null;
  /** Artifact key -> {file, sha256}. Keys: envelope, diff, verification, usage_delta, record. */
  artifacts: Record<string, HarvestArtifactRef>;
  usage_delta: UsageDelta;
  verification: { commands: number; failed: number; all_passed: boolean };
  postflight: PostflightResult;
  /** `creates:` paths that exist — the only files eligible for integration (R53). */
  deliverables: string[];
  /** Changed/untracked files NOT in `creates:` — harvested evidence, not deliverables (R53). */
  evidence_only_files: string[];
  untracked_files: string[];
  /** Workspace hash taken right after harvest (R46, T2-T3 hash 1). */
  harvest_workspace_hash: string;
}

/** Everything the harvest needs for one specialist dispatch (U6 approach). */
export interface HarvestContext {
  store: RunStore;
  unit: PlanUnit;
  role: SpecialistRole;
  take: number;
  /** Idempotency key (R36) — the envelope's `attempt_id`. */
  attempt: string;
  /** Observed agent id from `dispatch_created` (A6). */
  agentId: string;
  /** The specialist's worktree root. */
  worktreeRoot: string;
  /** Base commit recorded at `dispatch_created` (A6). */
  baseCommit: string | null;
  /** The result envelope U5 read, or null when absent (R43). */
  envelope: ResultEnvelope | null;
  /** Verification-contract commands from the unit (R45). */
  verificationCommands: string[];
  /** Usage snapshot taken before dispatch. */
  preDispatchUsage: UsageSnapshot;
  /** Usage snapshot taken after termination. */
  postTerminationUsage: UsageSnapshot;
  diffRunner?: DiffRunner;
  runCommand?: CommandRunner;
  harvestTs?: number;
  now?: () => number;
}

/** Outcome of one harvest. */
export interface HarvestOutcome {
  /** Absolute evidence dir: `<evidence>/<unit>/<take>/<role>/`. */
  evidenceDir: string;
  /** The persisted harvest record. */
  record: EvidenceRecord;
  /** The run custody chain after this harvest (persisted). */
  chain: CustodyHeader[];
  /** The `evidence_harvested` journal event (derived refs/hashes only, R41). */
  event: JournalEvent;
  postflight: PostflightResult;
  /** `gap_recorded` events for missing `creates:` paths (R61). */
  gaps: JournalEvent[];
  /** T2-T3 hash 1: workspace hash taken after harvest (R46). */
  harvestWorkspaceHash: string;
}

export function writeArtifact(evidenceDir: string, filename: string, content: string): HarvestArtifactRef {
  fs.writeFileSync(path.join(evidenceDir, filename), content, "utf8");
  return { file: filename, sha256: computeArtifactHash(content) };
}

export function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

/** Normalize a changed path for partitioning; drop infra noise. */
function significantChangedPath(p: string): string | null {
  const normalized = normalizeRelPath(p);
  if (normalized.length === 0) {
    return null;
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    return null;
  }
  if (normalized === ".miah" || normalized.startsWith(".miah/")) {
    return null;
  }
  return normalized;
}

/**
 * Harvest evidence for one terminated specialist (R45, F9, U6 approach):
 *
 *   1. read the result envelope (already read by U5; absent is an R43 gap,
 *      not a crash) -> `envelope.json`
 *   2. `git diff` the worktree against its base commit -> `diff.patch`
 *   3. run the verification-contract commands via `child_process.exec`,
 *      capturing exit code + stdout/stderr -> `verification.json`
 *   4. compute the usage delta from pre/post adapter snapshots -> `usage-delta.json`
 *   5. SHA-256 content-hash every artifact and append custody headers (R85)
 *   6. write the harvest record -> `evidence.json`
 *   7. run the postflight assertion (R61); missing `creates:` -> gaps
 *   8. take the post-harvest workspace hash (T2-T3 hash 1, R46)
 *
 * Evidence is written to `evidence/<unit>/<take>/<role>/`; the custody chain
 * lives at the run's `evidence/custody-chain.json`.
 */
export async function harvestEvidence(ctx: HarvestContext): Promise<HarvestOutcome> {
  const now = ctx.now ? ctx.now() : Date.now();
  const harvestTs = ctx.harvestTs !== undefined ? ctx.harvestTs : now;
  const unitId = ctx.unit.id;
  const creates = ctx.unit.creates ?? [];
  const role = ctx.role;
  const take = ctx.take;

  const evidenceDir = path.join(ctx.store.layout.evidenceDir, unitId, String(take), role);
  fs.mkdirSync(evidenceDir, { recursive: true });

  // 1. Envelope (R43): the producer's self-report is harvested as an input,
  // never as authority. Absent -> no artifact (the U5 gap already recorded it).
  const envelopeRef =
    ctx.envelope !== null
      ? writeArtifact(evidenceDir, "envelope.json", `${JSON.stringify(ctx.envelope, null, 2)}\n`)
      : null;

  // 2. Git diff of the worktree against its base commit (R45).
  const diffRunner = ctx.diffRunner ?? createGitDiffRunner();
  const worktreeDiff = await diffRunner(ctx.worktreeRoot, ctx.baseCommit);
  const diffRef = writeArtifact(evidenceDir, "diff.patch", worktreeDiff.diff);

  // 3. Verification-contract commands run by Miah itself (R45).
  const runCommand = ctx.runCommand ?? createExecCommandRunner();
  const results: CommandResult[] = [];
  for (const command of ctx.verificationCommands) {
    results.push(await runCommand(command, ctx.worktreeRoot));
  }
  const verification = {
    unit_id: unitId,
    role,
    take,
    harvest_ts: harvestTs,
    commands: results,
    all_passed: results.every((result) => result.exit_code === 0),
  };
  const verificationRef = writeArtifact(
    evidenceDir,
    "verification.json",
    `${JSON.stringify(verification, null, 2)}\n`,
  );

  // 4. Usage delta between the pre-dispatch and post-termination snapshots.
  const usageDelta = computeUsageDelta(ctx.preDispatchUsage, ctx.postTerminationUsage);
  const usageRef = writeArtifact(
    evidenceDir,
    "usage-delta.json",
    `${JSON.stringify(
      {
        unit_id: unitId,
        role,
        take,
        pre: ctx.preDispatchUsage,
        post: ctx.postTerminationUsage,
        delta: usageDelta,
      },
      null,
      2,
    )}\n`,
  );

  // Postflight assertion (R61).
  const postflight = runPostflight(unitId, ctx.worktreeRoot, creates);

  // Partition changed files into deliverables (`creates:` present) vs
  // evidence-only (test code etc., R53).
  const changed = [...worktreeDiff.changedFiles, ...worktreeDiff.untrackedFiles]
    .map(significantChangedPath)
    .filter((p): p is string => p !== null);
  const deliverableSet = new Set(postflight.present);
  const evidenceOnly = [...new Set(changed)].filter((p) => !deliverableSet.has(p));

  // 8 (record first): post-harvest workspace hash (T2-T3 hash 1, R46).
  const harvestWorkspaceHash = workspaceHash(ctx.worktreeRoot);

  // The harvested artifacts in a fixed, deterministic custody order. The
  // `record` (evidence.json) is written after the other four so the record's
  // own artifacts map can seal their hashes.
  const artifactOrder: Array<[string, HarvestArtifactRef | null]> = [
    ["envelope", envelopeRef],
    ["diff", diffRef],
    ["verification", verificationRef],
    ["usage_delta", usageRef],
    ["record", null],
  ];

  const record: EvidenceRecord = {
    schema: "miah/evidence-record/v1",
    unit_id: unitId,
    role,
    take,
    attempt: ctx.attempt,
    agent_id: ctx.agentId,
    harvest_ts: harvestTs,
    worktree_root: ctx.worktreeRoot,
    base_commit: ctx.baseCommit,
    artifacts: Object.fromEntries(
      artifactOrder.filter(([, ref]) => ref !== null).map(([key, ref]) => [key, ref as HarvestArtifactRef]),
    ),
    usage_delta: usageDelta,
    verification: {
      commands: results.length,
      failed: results.filter((r) => r.exit_code !== 0).length,
      all_passed: verification.all_passed,
    },
    postflight,
    deliverables: postflight.present,
    evidence_only_files: evidenceOnly,
    untracked_files: worktreeDiff.untrackedFiles.map(normalizeRelPath),
    harvest_workspace_hash: harvestWorkspaceHash,
  };
  const recordRef = writeArtifact(evidenceDir, "evidence.json", `${JSON.stringify(record, null, 2)}\n`);
  record.artifacts.record = recordRef;

  // 5-6. Custody chain (R85): append one header per artifact in harvest order,
  // then persist. The prev_hash of the first new header is the prior chain tail.
  const chainPath = custodyChainPath(ctx.store.layout.evidenceDir);
  const existingChain = readChainFile(chainPath);
  const prevChainTail = existingChain.length > 0 ? existingChain[existingChain.length - 1].content_hash : null;
  const chainWithRecord: Array<[string, HarvestArtifactRef | null]> = artifactOrder.slice();
  chainWithRecord[4] = ["record", recordRef];
  let chain = existingChain;
  for (const [, ref] of chainWithRecord) {
    if (ref === null) {
      continue;
    }
    const artifact = `${unitId}/${take}/${role}/${ref.file}`;
    chain = appendToChain(chain, {
      artifact,
      role,
      agent_id: ctx.agentId,
      attempt: ctx.attempt,
      take,
      harvest_ts: harvestTs,
      content_hash: ref.sha256,
    });
  }
  writeChainFile(chainPath, chain);

  const event = ctx.store.append("evidence_harvested", {
    unit_id: unitId,
    role,
    take,
    attempt: ctx.attempt,
    agent_id: ctx.agentId,
    evidence_path: toPosix(path.relative(ctx.store.layout.root, evidenceDir)),
    artifacts: Object.fromEntries(
      chainWithRecord.filter(([, ref]) => ref !== null).map(([key, ref]) => [key, (ref as HarvestArtifactRef).file]),
    ),
    artifact_hashes: Object.fromEntries(
      chainWithRecord.filter(([, ref]) => ref !== null).map(([key, ref]) => [key, (ref as HarvestArtifactRef).sha256]),
    ),
    custody_prev_hash: prevChainTail,
    custody_last_hash: chain[chain.length - 1].content_hash,
    harvest_workspace_hash: harvestWorkspaceHash,
    postflight: { present: postflight.present, missing: postflight.missing },
  });

  // 7. Postflight gaps (R61): a missing declared output is a deterministic
  // mechanical failure and blocks acceptance.
  const gaps: JournalEvent[] = [];
  for (const missing of postflight.missing) {
    gaps.push(
      ctx.store.append("gap_recorded", {
        unit_id: unitId,
        criterion: missing,
        reason: "missing-declared-output",
      }),
    );
  }

  return { evidenceDir, record, chain, event, postflight, gaps, harvestWorkspaceHash };
}

/**
 * Verify the run's custody chain and journal an evidence gap for every broken
 * link (R45, R52). A broken or missing chain link must not support acceptance;
 * this is called before grading/acceptance on the affected unit.
 */
export function verifyCustodyChain(
  store: RunStore,
  chain: CustodyHeader[],
): { ok: boolean; gaps: JournalEvent[] } {
  const verdict = verifyChain(chain);
  if (verdict.ok) {
    return { ok: true, gaps: [] };
  }
  const gaps: JournalEvent[] = [];
  for (const link of verdict.brokenLinks) {
    gaps.push(
      store.append("gap_recorded", {
        unit_id: unitFromArtifact(link.artifact),
        criterion: "custody-chain",
        reason: `broken custody chain at header ${link.index} (${link.artifact}): expected prev_hash ${link.expectedPrevHash}, found ${link.actualPrevHash}`,
      }),
    );
  }
  return { ok: false, gaps };
}

/** Input to the T2-T3 continuity check (R46). */
export interface ContinuityInput {
  unit_id: string;
  role: string;
  take: number;
  /** Workspace hash taken after harvest (T2-T3 hash 1). */
  harvestHash: string;
  /** Workspace hash taken just before integration (T2-T3 hash 2). */
  integrationHash: string;
  now?: () => number;
}

/** Outcome of the T2-T3 continuity check. */
export interface ContinuityOutcome {
  /** The `custody_continuity_record` journal event recording both hashes (R46). */
  record: JournalEvent;
  /** `gap_recorded: T2-T3-continuity` when the hashes differ, else null. */
  gap: JournalEvent | null;
  continuous: boolean;
}

/**
 * Record the T2-T3 continuity check (R46): pairs the workspace hash taken
 * after harvest with the one taken just before integration. A divergence means
 * the workspace was not frozen post-termination — the harvest is recorded as
 * an evidence gap (`gap_recorded: T2-T3-continuity`) and cannot support
 * acceptance.
 */
export function takeContinuityRecord(
  store: RunStore,
  input: ContinuityInput,
): ContinuityOutcome {
  const continuous = input.harvestHash === input.integrationHash;
  const record = store.append("custody_continuity_record", {
    unit_id: input.unit_id,
    role: input.role,
    take: input.take,
    harvest_workspace_hash: input.harvestHash,
    integration_workspace_hash: input.integrationHash,
    continuous,
  });
  let gap: JournalEvent | null = null;
  if (!continuous) {
    gap = store.append("gap_recorded", {
      unit_id: input.unit_id,
      criterion: "t2-t3-continuity",
      reason: "T2-T3-continuity",
    });
  }
  return { record, gap, continuous };
}
