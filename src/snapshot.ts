/**
 * Plan snapshot mechanics (R23).
 *
 * At admission Miah canonicalizes the plan and copies it verbatim into an
 * out-of-tree, owner-only run directory, then computes a SHA-256 content hash
 * of the canonicalized content. The snapshot is never mutated in place; a
 * change order creates a new snapshot version.
 *
 * The write path is injectable (a caller passes the target directory), which
 * keeps the module testable against a temp dir and lets the run store place
 * snapshots wherever the run layout requires.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Default snapshot filename for the first plan version (R23). */
export const DEFAULT_SNAPSHOT_FILENAME = "plan-snapshot.v1.md";

/** Result of writing a plan snapshot. */
export interface SnapshotResult {
  /** Absolute path the canonicalized content was written to. */
  filePath: string;
  /** SHA-256 content hash (hex) of the canonicalized content (R23, R85). */
  hash: string;
  /** The canonicalized content that was written and hashed. */
  canonicalContent: string;
}

/**
 * Canonicalize plan content for hashing and storage. Normalizes line endings
 * (CRLF -> LF) and trailing blank lines so the same document hashes
 * identically regardless of editor line-ending choices, while otherwise
 * preserving the content verbatim.
 */
export function canonicalizePlan(planText: string): string {
  const normalized = planText.replace(/\r\n?/g, "\n");
  const trimmed = normalized.replace(/\n+$/, "\n");
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

/** SHA-256 content hash (hex) of a string (R85). */
export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Canonicalize a plan, write it to `targetDir` (out-of-tree, created if
 * absent), and return the write path plus the content hash.
 */
export function writeSnapshot(planText: string, targetDir: string): SnapshotResult {
  const canonicalContent = canonicalizePlan(planText);
  const hash = computeContentHash(canonicalContent);
  const filePath = path.join(targetDir, DEFAULT_SNAPSHOT_FILENAME);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(filePath, canonicalContent, "utf8");
  return { filePath, hash, canonicalContent };
}
