/**
 * Kill-drill child: drives `miah run` for a scenario read from a JSON file, in a
 * separate process, so the parent can force-kill it mid-run to simulate a
 * supervisor death (R42, R37). Uses the REAL adapter, the real git diff runner,
 * and the verification commands injected via the scenario. Not a vitest test
 * file.
 *
 * The child is a dud-aware driver: a dispatch that the live provider launches
 * but which closes immediately having produced no envelope (the "Model is
 * unavailable" flake) is re-worked via `miah resolve --decision rework` so the
 * unit re-dispatches, exactly as the parent's harness does. It stops (exits
 * non-zero) only on a non-dud Attention pause or an unexpected error — the
 * parent kills it mid-run at the target dispatch.
 */
import * as fs from "fs";
import { runCommand } from "../../../src/commands/run";
import { runResolve } from "../../../src/commands/resolve";
import { unresolvedEscalations } from "../../../src/escalation";
import { readUnitsFromStore } from "../../../src/step";
import { deriveState } from "../../../src/replay";
import { resolveRunLayout, RunStore } from "../../../src/run-store";
import type { Config, PlanUnit } from "../../../src/types";

interface DriveRunScenario {
  runId: string;
  basePath: string;
  config: Config;
  workspaceRoot: string;
  verificationCommands: Record<string, string[]>;
  once?: boolean;
}

const HOLDER_ID = "miah-kd-child";

async function main(): Promise<void> {
  const scenarioPath = process.argv[2];
  const markerPath = process.argv[3];
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as DriveRunScenario;

  const store = new RunStore({
    basePath: scenario.basePath,
    runId: scenario.runId,
    config: scenario.config,
    holderId: HOLDER_ID,
  });
  const layout = resolveRunLayout(scenario.basePath, scenario.runId);

  const verificationCommandsFor = (unit: PlanUnit) => scenario.verificationCommands?.[unit.id] ?? [];
  const runOpts = {
    basePath: scenario.basePath,
    config: scenario.config,
    workspaceRoot: scenario.workspaceRoot,
    once: true,
    verificationCommandsFor,
  };

  for (let i = 0; i < 2000; i++) {
    const units = readUnitsFromStore(store) ?? {};
    const state = deriveState(store.journal.readEvents(), { units });
    if (state.phase === "Attention") {
      const escalations = unresolvedEscalations(store);
      const duds = escalations.filter((escalation) =>
        state.open_gaps.some(
          (gap) =>
            gap.unit_id === escalation.unit_id && gap.criterion === "result-envelope",
        ),
      );
      if (duds.length > 0) {
        let reworked = true;
        for (const escalation of duds) {
          const code = await runResolve(
            scenario.runId,
            escalation.escalation_id,
            "rework",
            "e2e child provider-dud retry",
            { basePath: scenario.basePath, config: scenario.config },
          );
          reworked = reworked && code === 0;
        }
        if (reworked) {
          continue;
        }
      }
      writeMarker(markerPath, { code: 1, reason: "attention-non-dud" });
      process.exit(1);
    }
    const code = await runCommand(scenario.runId, runOpts);
    if (code !== 0 && code !== 1) {
      // RUN_BLOCKED_EXIT_CODE (1) is the Attention pause — loop and reconcile
      // again; anything else is an unexpected error.
      writeMarker(markerPath, { code });
      process.exit(code);
    }
  }

  writeMarker(markerPath, { code: 1, reason: "iterations-exhausted" });
  process.exit(1);
}

function writeMarker(markerPath: string, value: { code: number; reason?: string }): void {
  try {
    fs.writeFileSync(markerPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    // best effort
  }
}

main().catch((error: unknown) => {
  try {
    fs.writeFileSync(
      process.argv[3],
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
      "utf8",
    );
  } catch {
    // best effort
  }
  process.exit(1);
});
