/**
 * Verifier evidence package and result harvest (KTD2-KTD3, R2-R3, R13, R15).
 *
 * The verifier package is a versioned manifest over Miah-harvested evidence
 * (`miah/verifier-package/v1`). Miah composes it only after builder harvest,
 * from hashed artifact files and the applicable custody slice, and copies the
 * package files under the frozen candidate's `.miah/verifier/<unit>/<attempt>/`
 * transport directory (KTD3). The workspace-hash exclusion set covers `.miah/`
 * alongside `.git/`, so package and envelope transport writes never create a
 * false T2-T3 continuity failure while source mutation still opens a gap.
 *
 * Every entry in the package manifest carries a package-relative path and a
 * SHA-256 hash. Raw, uncustodied specialist output is never copied: tester
 * records are included only when Miah has harvested them (a custody header
 * exists for the artifact), and the builder envelope is tagged
 * `producer-self-report` so it cannot satisfy an evidence pointer by itself.
 *
 * The verifier-result harvest (U3.AC5) is role-specific: it custodies the v2
 * envelope, the usage delta, and a result record WITHOUT running the unit's
 * verification-contract commands and never reports a vacuous zero-command
 * `all_passed`.
 */
import * as fs from "fs";
import * as path from "path";
import {
  appendToChain,
  computeArtifactHash,
  custodyChainPath,
  readChainFile,
  verifyChain,
  writeChainFile,
  type CustodyHeader,
} from "./custody";
import { computeUsageDelta, toPosix, workspaceHash, writeArtifact, type UsageSnapshot } from "./evidence";
import type { RunStore } from "./run-store";
import type {
  AwaitingCandidate,
  CriterionMapping,
  PlanUnit,
  VerificationCommand,
} from "./types";

/** Package schema (KTD2). */
export const VERIFIER_PACKAGE_SCHEMA = "miah/verifier-package/v1";

/** Verifier-result record schema (U3.AC5). */
export const VERIFIER_RESULT_SCHEMA = "miah/verifier-result/v1";

/** One entry in the package manifest: package-relative path + SHA-256 (KTD2). */
export interface PackageEntry {
  path: string;
  sha256: string;
}

/** A harvested tester evidence record included in the package (KTD2). */
export interface TesterRecordRef {
  /** Package-relative copy of the tester `evidence.json`. */
  path: string;
  sha256: string;
  /** Custody header sealing the harvested tester record. */
  custody: CustodyHeader;
}

/** The composed verifier package manifest (`miah/verifier-package/v1`, KTD2). */
export interface VerifierPackageManifest {
  schema: typeof VERIFIER_PACKAGE_SCHEMA;
  unit_id: string;
  /** Builder candidate identity (KTD2/KTD5). */
  candidate: {
    take: number;
    attempt: string;
    agent_id: string | null;
    workspace_id: string | null;
    base_commit: string | null;
    deadline: string;
    envelope_path: string;
  };
  /** Candidate workspace identity + content hash at compose time (KTD2/KTD3). */
  workspace: {
    workspace_id: string | null;
    content_hash: string;
  };
  /** Frozen criterion data (KTD2: the unit's Acceptance owns tiers, KTD1). */
  criteria: Array<{ id: string | null; text: string; tier: string | null }>;
  /** Frozen verification contract (KTD1, R15). */
  contract: {
    commands: VerificationCommand[];
    criterion_map: Record<string, CriterionMapping>;
  };
  /**
   * Builder artifacts: `key` mirrors the harvested evidence-record artifact
   * keys (`evidence`, `diff`, `verification`, `usage_delta`, `record`).
   */
  builder_artifacts: Array<{ key: string; path: string; sha256: string }>;
  /** The builder envelope, tagged as a self-report (KTD2: never authority). */
  producer_self_report: { path: string; sha256: string } | null;
  /** Harvested tester records; empty when none exist (KTD2). */
  tester_records: TesterRecordRef[];
  /** Relevant custody slice (prior + last hashes, headers, KTD2/KTD3). */
  custody: {
    prior_hash: string | null;
    last_hash: string;
    slice: CustodyHeader[];
  };
  /** Every file in the package: package-relative path + SHA-256 (KTD2). */
  entries: PackageEntry[];
  /** SHA-256 over the canonical entry list — the verifier envelope binds this (KTD4). */
  package_sha256: string;
}

export interface ComposePackageContext {
  store: RunStore;
  unit: PlanUnit;
  candidate: AwaitingCandidate;
  /** The frozen candidate worktree root (builder workspace). */
  worktreeRoot: string;
  /** Workspace content hash to seal; defaults to the caller-provided value. */
  workspaceContentHash?: string;
}

/** The composed package on disk. */
export interface ComposedPackage {
  /** Package directory (`.miah/verifier/<unit>/<attempt>/` under the worktree). */
  packageDir: string;
  manifest: VerifierPackageManifest;
  /** `manifest.package_sha256` (hash of the canonical entry list). */
  packageSha256: string;
}

/** Read the builder's harvested evidence record (`evidence/<unit>/<take>/builder/`). */export function readBuilderEvidenceRecord(
  store: RunStore,
  unitId: string,
  take: number,
): {
  evidenceDir: string;
  record: {
    artifacts: Record<string, { file: string; sha256: string }>;
    base_commit: string | null;
  };
} | null {
  const evidenceDir = path.join(store.layout.evidenceDir, unitId, String(take), "builder");
  const recordPath = path.join(evidenceDir, "evidence.json");
  if (!fs.existsSync(recordPath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.artifacts !== "object" || record.artifacts === null) {
      return null;
    }
    return {
      evidenceDir,
      record: record as {
        artifacts: Record<string, { file: string; sha256: string }>;
        base_commit: string | null;
      },
    };
  } catch {
    return null;
  }
}

/** The custody headers sealing a unit's builder harvest (`<unit>/<take>/builder/`). */
function builderCustodySlice(
  chain: CustodyHeader[],
  unitId: string,
  take: number,
): { slice: CustodyHeader[]; priorHash: string | null } {
  const prefix = `${unitId}/${take}/builder/`;
  const slice: CustodyHeader[] = [];
  let priorHash: string | null = null;
  for (const header of chain) {
    if (header.artifact.startsWith(prefix)) {
      slice.push(header);
    } else {
      priorHash = header.content_hash;
    }
  }
  return { slice, priorHash };
}

/** Locate harvested tester `evidence.json` records for a unit (KTD2). */
function harvestedTesterRecords(
  store: RunStore,
  chain: CustodyHeader[],
  unitId: string,
): Array<{ recordPath: string; header: CustodyHeader }> {
  const records: Array<{ recordPath: string; header: CustodyHeader }> = [];
  const unitDir = path.join(store.layout.evidenceDir, unitId);
  if (!fs.existsSync(unitDir)) {
    return records;
  }
  const byArtifact = new Map(chain.map((header) => [header.artifact, header]));
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "evidence.json") {
        const rel = toPosix(path.relative(store.layout.evidenceDir, full));
        const header = byArtifact.get(rel);
        // KTD2: only harvested (custody-referenced) tester records are trusted;
        // a raw tester file Miah never harvested is never copied.
        if (header !== undefined && header.role === "tester") {
          records.push({ recordPath: full, header });
        }
      }
    }
  };
  walk(unitDir);
  return records.sort((a, b) => a.header.artifact.localeCompare(b.header.artifact));
}

/**
 * Compose the verifier evidence package for a frozen builder candidate
 * (KTD2-KTD3). Copies the harvested builder artifacts (evidence record, diff,
 * verification, usage delta, envelope) plus the relevant custody slice into
 * the candidate's `.miah/verifier/<unit>/<attempt>/` transport directory and
 * writes the package manifest sealing every entry.
 *
 * Throws when the builder harvest record is absent or the custody chain is
 * broken — a candidate without harvested, custody-referenced evidence cannot
 * be packaged (KTD2/R3).
 */
export function composeVerifierPackage(ctx: ComposePackageContext): ComposedPackage {
  const { store, unit, candidate } = ctx;
  const harvest = readBuilderEvidenceRecord(store, unit.id, candidate.take);
  if (harvest === null) {
    throw new Error(
      `cannot compose verifier package: no harvested builder evidence for ${unit.id} take ${candidate.take}`,
    );
  }

  const chain = readChainFile(custodyChainPath(store.layout.evidenceDir));
  if (chain.length === 0) {
    throw new Error("cannot compose verifier package: custody chain is empty");
  }
  const { slice, priorHash } = builderCustodySlice(chain, unit.id, candidate.take);
  if (slice.length === 0) {
    throw new Error(
      `cannot compose verifier package: no custody headers for ${unit.id} take ${candidate.take} builder harvest`,
    );
  }
  if (!verifyChain(chain).ok) {
    throw new Error("cannot compose verifier package: custody chain is broken");
  }

  const packageDir = path.join(
    ctx.worktreeRoot,
    ".miah",
    "verifier",
    unit.id,
    candidate.attempt,
  );
  fs.mkdirSync(path.join(packageDir, "builder"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "tester"), { recursive: true });

  const entries: PackageEntry[] = [];
  const addFile = (relPath: string, sourcePath: string): PackageEntry => {
    const content = fs.readFileSync(sourcePath);
    const entry: PackageEntry = { path: toPosix(relPath), sha256: computeArtifactHash(content) };
    const dest = path.join(packageDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    entries.push(entry);
    return entry;
  };

  // Builder artifacts in the harvested order (KTD2). The harvested record
  // cannot reference its own file (evidence.json), so it is added explicitly.
  const builderArtifacts: Array<{ key: string; path: string; sha256: string }> = [];
  for (const [key, artifact] of Object.entries(harvest.record.artifacts)) {
    const entry = addFile(`builder/${artifact.file}`, path.join(harvest.evidenceDir, artifact.file));
    builderArtifacts.push({ key, path: entry.path, sha256: entry.sha256 });
  }
  const recordEntry = addFile(
    "builder/evidence.json",
    path.join(harvest.evidenceDir, "evidence.json"),
  );
  builderArtifacts.push({ key: "record", path: recordEntry.path, sha256: recordEntry.sha256 });

  // Tester records: harvested and custody-referenced only (KTD2).
  const testerRecords: TesterRecordRef[] = [];
  for (const { recordPath, header } of harvestedTesterRecords(store, chain, unit.id)) {
    const entry = addFile(`tester/${header.artifact}`, recordPath);
    testerRecords.push({ path: entry.path, sha256: entry.sha256, custody: header });
  }

  // The custody slice rides in the package so the verifier can check pointers
  // against the chain without touching the run store (KTD2/KTD3).
  const sliceJson = `${JSON.stringify(
    { schema: "miah/custody-slice/v1", prior_hash: priorHash, last_hash: chain[chain.length - 1].content_hash, slice },
    null,
    2,
  )}\n`;
  const sliceEntry: PackageEntry = {
    path: "custody-slice.json",
    sha256: computeArtifactHash(sliceJson),
  };
  fs.writeFileSync(path.join(packageDir, "custody-slice.json"), sliceJson, "utf8");
  entries.push(sliceEntry);

  const producerSelfReport = builderArtifacts.find((artifact) => artifact.key === "envelope");

  const manifest: VerifierPackageManifest = {
    schema: VERIFIER_PACKAGE_SCHEMA,
    unit_id: unit.id,
    candidate: {
      take: candidate.take,
      attempt: candidate.attempt,
      agent_id: candidate.agent_id,
      workspace_id: candidate.workspace_id,
      base_commit: candidate.base_commit ?? harvest.record.base_commit,
      deadline: candidate.deadline,
      envelope_path: candidate.envelope_path,
    },
    workspace: {
      workspace_id: candidate.workspace_id,
      // KTD3: the content hash seals the frozen candidate's file state at
      // compose time; `.miah/` transport writes are excluded from it.
      content_hash: ctx.workspaceContentHash ?? workspaceHash(ctx.worktreeRoot),
    },
    criteria: (unit.acceptance ?? []).map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      tier: criterion.tier,
    })),
    contract: {
      commands: unit.verificationContract?.commands ?? [],
      criterion_map: unit.verificationContract?.criterion_map ?? {},
    },
    builder_artifacts: builderArtifacts,
    producer_self_report: producerSelfReport
      ? { path: producerSelfReport.path, sha256: producerSelfReport.sha256 }
      : null,
    tester_records: testerRecords,
    custody: {
      prior_hash: priorHash,
      last_hash: chain[chain.length - 1].content_hash,
      slice,
    },
    entries,
    package_sha256: "",
  };

  manifest.package_sha256 = packageSha256(manifest);

  // Write the manifest last so the entry list seals every other file (KTD2).
  // The manifest deliberately does not list itself: `packageSha256` seals the
  // entries the manifest describes, so the manifest can carry its own seal.
  const manifestRel = path.join(packageDir, "manifest.json");
  fs.writeFileSync(manifestRel, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { packageDir, manifest, packageSha256: manifest.package_sha256 };
}

/** SHA-256 over the canonical (sorted) entry list — the package hash (KTD2). */
export function packageSha256(manifest: Pick<VerifierPackageManifest, "entries">): string {
  // The manifest's own entry is excluded: the seal is over the files the
  // manifest describes, so the manifest can carry its own seal hash.
  const sealed = manifest.entries.filter((entry) => entry.path !== "manifest.json");
  const canonical = JSON.stringify([...sealed].sort((a, b) => a.path.localeCompare(b.path)));
  return computeArtifactHash(canonical);
}

/** Structural chain check for compose-time fail-closed (R45). */
export interface PackageValidationResult {
  ok: boolean;
  /** Package-relative path of the first offending entry, when any. */
  badPath: string | null;
  message: string;
}

/**
 * Validate a composed package on disk (tamper detection): the manifest parses
 * with schema `miah/verifier-package/v1`, every declared entry exists with the
 * declared SHA-256, the entry list re-hashes to `package_sha256`, and the
 * custody slice chains to the declared prior/last hashes. A missing or
 * mismatched file fails closed (KTD2/KTD3).
 */
export function validateVerifierPackage(packageDir: string): PackageValidationResult {
  const manifestPath = path.join(packageDir, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, badPath: "manifest.json", message: "manifest missing or unparseable" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, badPath: "manifest.json", message: "manifest is not an object" };
  }
  const manifest = parsed as VerifierPackageManifest;
  if (manifest.schema !== VERIFIER_PACKAGE_SCHEMA) {
    return { ok: false, badPath: "manifest.json", message: `unexpected schema ${manifest.schema}` };
  }
  if (!Array.isArray(manifest.entries)) {
    return { ok: false, badPath: "manifest.json", message: "entries missing" };
  }
  for (const entry of manifest.entries) {
    const full = path.join(packageDir, entry.path);
    let content: Buffer;
    try {
      content = fs.readFileSync(full);
    } catch {
      return { ok: false, badPath: entry.path, message: "declared entry missing on disk" };
    }
    if (computeArtifactHash(content) !== entry.sha256) {
      return { ok: false, badPath: entry.path, message: "entry content hash mismatch (tampered)" };
    }
  }
  const expectedHash = packageSha256(manifest);
  if (manifest.package_sha256 !== expectedHash) {
    return { ok: false, badPath: "manifest.json", message: "package_sha256 does not seal the entry list" };
  }
  const { slice, prior_hash: priorHash } = manifest.custody;
  for (let i = 0; i < slice.length; i++) {
    const expected = i === 0 ? priorHash : slice[i - 1].content_hash;
    if (slice[i].prev_hash !== expected) {
      return { ok: false, badPath: "custody-slice.json", message: "custody slice does not chain" };
    }
  }
  if (slice.length > 0 && manifest.custody.last_hash !== slice[slice.length - 1].content_hash) {
    return { ok: false, badPath: "custody-slice.json", message: "last_hash does not match the slice tail" };
  }
  return { ok: true, badPath: null, message: "ok" };
}

// ---------------------------------------------------------------------------
// Verifier-result harvest (U3.AC5)
// ---------------------------------------------------------------------------

export interface VerifierResultInput {
  store: RunStore;
  unitId: string;
  /** The frozen candidate (builder identity, KTD5). */
  candidate: AwaitingCandidate;
  /** The verifier's dispatch identity (observed). */
  verifierAttempt: string;
  verifierAgentId: string;
  /** The verifier's worktree root (the frozen candidate workspace). */
  worktreeRoot: string;
  /** The validated v2 result envelope (U4) or null when absent/invalid. */
  envelope: unknown | null;
  /** Usage snapshots for the delta (pre-dispatch / post-termination). */
  preDispatchUsage: UsageSnapshot;
  postTerminationUsage: UsageSnapshot;
  now?: () => number;
}

/** One role-specific verifier-result harvest outcome (U3.AC5). */
export interface VerifierResultOutcome {
  evidenceDir: string;
  /** The persisted verifier-result record. */
  record: VerifierResultRecord;
  /** Custody chain after this harvest. */
  chain: CustodyHeader[];
}

/**
 * The verifier-result record: custodies the envelope, usage delta, and the
 * record itself. It deliberately has NO `all_passed` and NO command results:
 * the unit's verification-contract commands were already run once by the
 * sensor (R2/R15), and a zero-command harvest must never report vacuous
 * success (KTD5/R13, U3.AC5).
 */
export interface VerifierResultRecord {
  schema: typeof VERIFIER_RESULT_SCHEMA;
  unit_id: string;
  role: "verifier";
  take: number;
  attempt: string;
  agent_id: string;
  harvest_ts: number;
  envelope: { file: string; sha256: string } | null;
  usage_delta: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; costUsd: number | null };
  /** Always 0 with all_passed null: commands are never re-run here. */
  verification: { commands: 0; all_passed: null };
}

/**
 * Harvest the verifier's result (U3.AC5): writes `envelope.json` (the v2
 * envelope), `usage-delta.json`, and `verifier-result.json` under
 * `evidence/<unit>/<take>/verifier/`, custodies each artifact, and journals
 * `evidence_harvested` with role `verifier`. Never runs the unit's contract
 * commands and never reports `all_passed`.
 */
export function harvestVerifierResult(ctx: VerifierResultInput): VerifierResultOutcome {
  const now = ctx.now ? ctx.now() : Date.now();
  const unitId = ctx.unitId;
  const take = ctx.candidate.take;
  const evidenceDir = path.join(ctx.store.layout.evidenceDir, unitId, String(take), "verifier");
  fs.mkdirSync(evidenceDir, { recursive: true });

  const envelopeRef =
    ctx.envelope !== null
      ? writeArtifact(evidenceDir, "envelope.json", `${JSON.stringify(ctx.envelope, null, 2)}\n`)
      : null;
  const usageDelta = computeUsageDelta(ctx.preDispatchUsage, ctx.postTerminationUsage);
  const usageRef = writeArtifact(
    evidenceDir,
    "usage-delta.json",
    `${JSON.stringify(
      {
        unit_id: unitId,
        role: "verifier",
        take,
        pre: ctx.preDispatchUsage,
        post: ctx.postTerminationUsage,
        delta: usageDelta,
      },
      null,
      2,
    )}\n`,
  );

  const record: VerifierResultRecord = {
    schema: VERIFIER_RESULT_SCHEMA,
    unit_id: unitId,
    role: "verifier",
    take,
    attempt: ctx.verifierAttempt,
    agent_id: ctx.verifierAgentId,
    harvest_ts: now,
    envelope: envelopeRef,
    usage_delta: usageDelta,
    verification: { commands: 0, all_passed: null },
  };
  const recordRef = writeArtifact(
    evidenceDir,
    "verifier-result.json",
    `${JSON.stringify(record, null, 2)}\n`,
  );

  const chainPath = custodyChainPath(ctx.store.layout.evidenceDir);
  const existingChain = readChainFile(chainPath);
  const prevChainTail =
    existingChain.length > 0 ? existingChain[existingChain.length - 1].content_hash : null;
  let chain = existingChain;
  const order: Array<{ file: string; sha256: string } | null> = [envelopeRef, usageRef, recordRef];
  const harvestedRefs = order.filter(
    (ref): ref is { file: string; sha256: string } => ref !== null,
  );
  for (const ref of harvestedRefs) {
    chain = appendToChain(chain, {
      artifact: `${unitId}/${take}/verifier/${ref.file}`,
      role: "verifier",
      agent_id: ctx.verifierAgentId,
      attempt: ctx.verifierAttempt,
      take,
      harvest_ts: now,
      content_hash: ref.sha256,
    });
  }
  writeChainFile(chainPath, chain);

  ctx.store.append("evidence_harvested", {
    unit_id: unitId,
    role: "verifier",
    take,
    attempt: ctx.verifierAttempt,
    agent_id: ctx.verifierAgentId,
    evidence_path: toPosix(path.relative(ctx.store.layout.root, evidenceDir)),
    artifacts: harvestedRefs.map((ref) => ref.file),
    artifact_hashes: harvestedRefs.map((ref) => ref.sha256),
    custody_prev_hash: prevChainTail,
    custody_last_hash: chain[chain.length - 1].content_hash,
    verification_commands_rerun: false,
  });

  return { evidenceDir, record, chain };
}

// ---------------------------------------------------------------------------
// Envelope binding validation (KTD4, U5 ingestion)
// ---------------------------------------------------------------------------

export interface BindingVerdict {
  ok: boolean;
  reason: string | null;
}

/** Read the package manifest from the package dir; null when unreadable. */
export function readPackageManifest(packageDir: string): VerifierPackageManifest | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(packageDir, "manifest.json"), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as VerifierPackageManifest;
  } catch {
    return null;
  }
}

/**
 * KTD4 binding checks: the envelope must grade the exact frozen candidate
 * (attempt/take) and cite the exact composed package hash. A mismatch means a
 * stale or foreign result — fail closed as a failed verifier attempt.
 */
export function verifyEnvelopeBinding(
  envelope: { candidate_attempt: string; candidate_take: number; evidence_package_sha256: string },
  packageDir: string,
  candidate: AwaitingCandidate,
  manifest?: VerifierPackageManifest | null,
): BindingVerdict {
  if (envelope.candidate_attempt !== candidate.attempt) {
    return { ok: false, reason: `candidate attempt mismatch: envelope ${envelope.candidate_attempt}, candidate ${candidate.attempt}` };
  }
  if (envelope.candidate_take !== candidate.take) {
    return { ok: false, reason: `candidate take mismatch: envelope ${envelope.candidate_take}, candidate ${candidate.take}` };
  }
  const resolved = manifest ?? readPackageManifest(packageDir);
  if (resolved === null) {
    return { ok: false, reason: "package manifest unreadable" };
  }
  if (envelope.evidence_package_sha256 !== resolved.package_sha256) {
    return { ok: false, reason: "evidence package hash mismatch (wrong package)" };
  }
  return { ok: true, reason: null };
}

/**
 * KTD4 coverage checks: exactly one grade per non-human criterion, no grades
 * for human-tier criteria, no unknown criterion IDs, and each grade's
 * declared tier matches the plan's criterion tier (tiers live in Acceptance,
 * KTD1).
 */
export function verifyGradeCoverage(
  envelope: { grades: Array<{ criterion_id: string; declared_tier: string }> },
  unit: PlanUnit,
): BindingVerdict {
  const criteria = unit.acceptance ?? [];
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const nonHuman = criteria.filter((c) => c.tier !== "human");
  const graded = new Set<string>();
  for (const entry of envelope.grades) {
    const criterion = byId.get(entry.criterion_id);
    if (criterion === undefined) {
      return { ok: false, reason: `grade for unknown criterion ${entry.criterion_id}` };
    }
    if (criterion.tier === "human") {
      return { ok: false, reason: `grade for human-tier criterion ${entry.criterion_id} must be omitted` };
    }
    if (entry.declared_tier !== criterion.tier) {
      return { ok: false, reason: `tier mismatch for ${entry.criterion_id}: envelope ${entry.declared_tier}, plan ${criterion.tier}` };
    }
    graded.add(entry.criterion_id);
  }
  for (const criterion of nonHuman) {
    if (criterion.id !== null && !graded.has(criterion.id)) {
      return { ok: false, reason: `missing grade for criterion ${criterion.id}` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * KTD4 pointer checks: every evidence pointer resolves to a package entry
 * whose SHA-256 matches the pointer's and appears in the package's custody
 * slice. Pointers into the producer self-report (the builder envelope) are
 * rejected: a self-claim is never evidence (KTD2, U3.AC3). Unknown or
 * non-custodied pointers fail closed as ungraded evidence.
 */
export function verifyEvidencePointers(
  envelope: { grades: Array<{ evidence: Array<{ artifact: string; sha256: string }> }> },
  packageDir: string,
  manifest?: VerifierPackageManifest | null,
): BindingVerdict {
  const resolved = manifest ?? readPackageManifest(packageDir);
  if (resolved === null) {
    return { ok: false, reason: "package manifest unreadable" };
  }
  const entriesByPath = new Map(resolved.entries.map((entry) => [entry.path, entry.sha256]));
  const custodied = new Set(resolved.custody.slice.map((header) => header.content_hash));
  const selfReport = resolved.producer_self_report;
  for (const grade of envelope.grades) {
    for (const pointer of grade.evidence) {
      if (selfReport !== null && pointer.artifact === selfReport.path) {
        return { ok: false, reason: `pointer into producer self-report ${pointer.artifact} is not evidence (KTD2)` };
      }
      const entryHash = entriesByPath.get(pointer.artifact);
      if (entryHash === undefined) {
        return { ok: false, reason: `pointer artifact ${pointer.artifact} is not a package entry` };
      }
      if (entryHash !== pointer.sha256) {
        return { ok: false, reason: `pointer hash mismatch for ${pointer.artifact}` };
      }
      if (!custodied.has(pointer.sha256)) {
        return { ok: false, reason: `pointer artifact ${pointer.artifact} is not custodied` };
      }
    }
  }
  return { ok: true, reason: null };
}
