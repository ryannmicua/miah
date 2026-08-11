/**
 * Per-unit postflight assertion (R61, R62, F9).
 *
 * On each unit's completion Miah runs a scoped postflight of the same
 * referential logic as R56(b), limited to that unit: every repo-relative path
 * the unit declared in `creates:` must now exist in the specialist's worktree.
 * A missing declared output is a deterministic mechanical failure (the artifact
 * is not there) — it is recorded as an evidence gap by the evidence layer and
 * blocks acceptance without spending verifier budget on the more expensive "the
 * artifact is wrong" question (R61).
 *
 * Test code the plan did not declare in `creates:` is never a deliverable
 * (R53): only declared `creates:` paths count for integration. The evidence
 * layer partitions harvested files into deliverables (present `creates:`) and
 * evidence-only (everything else) from this module's verdict.
 */
import * as fs from "fs";
import * as path from "path";

/** Verdict of the scoped postflight assertion (R61). */
export interface PostflightResult {
  /** The unit the assertion ran for. */
  unit_id: string;
  /** The repo-relative `creates:` declarations (empty when none declared). */
  declared: string[];
  /** Declared paths that exist in the worktree. */
  present: string[];
  /** Declared paths that are missing from the worktree. */
  missing: string[];
  /** True when every declared path exists (`missing` is empty). */
  ok: boolean;
}

/**
 * Run the postflight assertion for one unit against its worktree (R61).
 * `creates` may be null (an undeclared field — a plan admission failure per
 * R26) or empty; both are treated as "no declared outputs" and pass.
 */
export function runPostflight(
  unitId: string,
  worktreeRoot: string,
  creates: string[] | null,
): PostflightResult {
  const declared = (creates ?? []).map(normalizeRelPath);
  const present: string[] = [];
  const missing: string[] = [];
  for (const declaredPath of declared) {
    const full = path.join(worktreeRoot, ...declaredPath.split("/"));
    if (fs.existsSync(full)) {
      present.push(declaredPath);
    } else {
      missing.push(declaredPath);
    }
  }
  return {
    unit_id: unitId,
    declared,
    present,
    missing,
    ok: missing.length === 0,
  };
}

/**
 * The deliverable set for a unit: the `creates:` paths that exist in the
 * worktree. Only these are integrated when the unit is accepted (R53, R89);
 * anything else — test code the plan did not declare — is harvested evidence,
 * never a deliverable.
 */
export function deliverableFiles(worktreeRoot: string, creates: string[] | null): string[] {
  return runPostflight("", worktreeRoot, creates).present;
}

/** Normalize a repo-relative path to forward slashes, stripping a leading `./`. */
export function normalizeRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized;
}
