/**
 * `miah start <plan>` command (D6-a, R63): admission + lease + first step.
 *
 * Replaces the U1 stub with the real admission gate: read the plan, run
 * preflight ∧ the live substrate probe, and on pass write the run store and
 * acquire the lease. On refusal it prints the fail-closed message(s) and exits
 * non-zero. Kept minimal for U4 — the looping driver (`miah run`) lands in U8.
 */
import * as fs from "fs";
import { loadConfig, resolveConfigBasePath } from "../config";
import { admitPlan, type AdmissionResult } from "../admission";
import { RunStore } from "../run-store";
import { PaseoSubstrateProbe, type SubstrateProbe } from "../substrate-probe";
import { collectWorkspacePaths } from "./preflight";

/** Exit code used when admission refuses (fail closed). */
export const ADMISSION_FAILURE_EXIT_CODE = 1;

export interface RunStartOptions {
  probe?: SubstrateProbe;
  config?: ReturnType<typeof loadConfig>;
  basePath?: string;
  workspaceRoot?: string;
  holderId?: string;
}

/** Render an admission result to stdout. */
export function printAdmission(result: AdmissionResult): void {
  if (result.ok && result.run !== null) {
    console.log("admission: PASS");
    console.log(`  run id: ${result.run.runId}`);
    console.log(`  plan hash: ${result.run.planHash}`);
    console.log(`  run store: ${result.run.layout.root}`);
    console.log(
      `  substrate probe: max-duration=${result.probe?.max_duration.status} ` +
        `mcp=${result.probe?.mcp_injection.status} ` +
        `immutability=${result.probe?.immutability.status}`,
    );
    for (const caveat of result.caveats) {
      console.log(`  caveat: ${caveat}`);
    }
    return;
  }

  console.log("admission: FAIL");
  for (const failure of result.failures) {
    console.log(`  [${failure.kind}] ${failure.message}`);
  }
  for (const caveat of result.caveats) {
    console.log(`  caveat: ${caveat}`);
  }
}

/**
 * Run `miah start` on a plan file. Returns the process exit code (0 pass,
 * ADMISSION_FAILURE_EXIT_CODE on refusal or unreadable plan).
 */
export async function runStart(planPath: string, opts: RunStartOptions = {}): Promise<number> {
  let planText: string;
  try {
    planText = fs.readFileSync(planPath, "utf8");
  } catch (error) {
    console.error(`miah start: cannot read plan file: ${planPath}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    return ADMISSION_FAILURE_EXIT_CODE;
  }

  const basePath = opts.basePath ?? resolveConfigBasePath();
  const config = opts.config ?? loadConfig();
  const holderId = opts.holderId ?? `miah-${process.pid}`;
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const workspacePaths = collectWorkspacePaths(workspaceRoot);
  const probe = opts.probe ?? new PaseoSubstrateProbe();

  const result = await admitPlan(planText, {
    probe,
    config,
    basePath,
    holderId,
    workspacePaths,
  });
  printAdmission(result);
  if (!result.ok || result.run === null) {
    return ADMISSION_FAILURE_EXIT_CODE;
  }

  const store = new RunStore({ basePath, runId: result.run.runId, config, holderId });
  store.lease.release(holderId);
  return 0;
}
