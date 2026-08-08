/**
 * `miah preflight <plan>` command (R55-R60, D6-a).
 *
 * Reads the plan file, collects the workspace's current repo-relative path
 * set, and runs the pure preflight (structural/referential/verifiability).
 * Prints a green verdict on success or structured failures grouped by class
 * with the offending unit ID, and exits non-zero when any finding blocks
 * (R58: block-only severity).
 */
import * as fs from "fs";
import * as path from "path";
import { PreflightVerdict, preflightPlan } from "../preflight";
import { PLAN_LEVEL } from "../preflight";

/** Directories skipped when collecting the workspace path set. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/** Exit code used when the plan fails preflight (block-only, R58). */
export const PREFLIGHT_FAILURE_EXIT_CODE = 1;

/**
 * Recursively collect repo-relative paths present in the workspace at
 * preflight time (R56(b)). The workspace root defaults to the current working
 * directory, matching "run from any directory containing or referencing a
 * target repo worktree" (R70).
 */
export function collectWorkspacePaths(workspaceRoot: string): string[] {
  const paths: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      paths.push(relative);
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), relative);
      }
    }
  };
  visit(workspaceRoot, "");
  return paths;
}

/** Render a single finding line, naming the offending unit (or plan-level). */
function formatFinding(finding: { unitId: string; code: string; message: string }): string {
  const where = finding.unitId === PLAN_LEVEL ? PLAN_LEVEL : `[${finding.unitId}]`;
  return `  - ${where} (${finding.code}): ${finding.message}`;
}

/** Render a verdict to stdout. */
export function printVerdict(verdict: PreflightVerdict): void {
  if (verdict.ok) {
    console.log("preflight: PASS");
    console.log(`  plan: ${verdict.title ?? "(untitled)"}`);
    console.log(`  artifact_contract: ${verdict.artifactContract ?? "absent"}`);
    console.log(`  execution: ${verdict.execution ?? "absent"}`);
    console.log("  no structural, referential, or verifiability findings");
    for (const flag of verdict.flags) {
      console.log(`  flag: ${flag.code}: ${flag.message}`);
    }
    return;
  }

  console.log("preflight: FAIL");
  console.log(`  plan: ${verdict.title ?? "(untitled)"}`);

  const classes: Array<[string, keyof PreflightVerdict]> = [
    ["structural", "structural"],
    ["referential", "referential"],
    ["verifiability", "verifiability"],
  ];
  let reported = 0;
  for (const [label, key] of classes) {
    const findings = verdict[key] as unknown as Array<{
      unitId: string;
      code: string;
      message: string;
    }>;
    if (findings.length === 0) {
      continue;
    }
    console.log(`  ${label} failures (${findings.length}):`);
    for (const finding_ of findings) {
      console.log(formatFinding(finding_));
    }
    reported += findings.length;
  }
  if (reported === 0) {
    console.log("  (no findings; plan could not be parsed)");
  }
  for (const flag of verdict.flags) {
    console.log(`  flag: ${flag.code}: ${flag.message}`);
  }
}

/**
 * Run `miah preflight` on a plan file path. Reads the file, collects the
 * workspace path set, runs the pure preflight, prints the verdict, and returns
 * the process exit code (0 pass, 1 fail).
 */
export function runPreflight(planPath: string, workspaceRoot?: string): number {
  let planText: string;
  try {
    planText = fs.readFileSync(planPath, "utf8");
  } catch (error) {
    console.error(`miah preflight: cannot read plan file: ${planPath}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    return PREFLIGHT_FAILURE_EXIT_CODE;
  }

  const root = workspaceRoot ?? process.cwd();
  const workspacePaths = collectWorkspacePaths(root);
  const verdict = preflightPlan(planText, workspacePaths);
  printVerdict(verdict);
  return verdict.ok ? 0 : PREFLIGHT_FAILURE_EXIT_CODE;
}
