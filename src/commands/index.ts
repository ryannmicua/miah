import { Command } from "commander";
import { loadConfig } from "../config";

/**
 * The exact command surface (R63, KTD15): preflight, start, run, status, stop,
 * resolve, approve, reject, amend, list. Single source of truth for the names.
 */
export const COMMANDS = [
  "preflight",
  "start",
  "run",
  "status",
  "stop",
  "resolve",
  "approve",
  "reject",
  "amend",
  "list",
] as const;

const NOT_IMPLEMENTED = "not yet implemented";

/**
 * U1 shell: command bodies are stubs that read the config on startup (R80) and
 * report that the body is not yet implemented. Later units replace each stub.
 */
function stub(name: string): () => void {
  return () => {
    loadConfig();
    console.log(`miah ${name}: ${NOT_IMPLEMENTED}`);
  };
}

export function registerCommands(program: Command): void {
  program
    .command("preflight")
    .description("Run preflight on a plan")
    .argument("<plan>", "path to the CE unified plan markdown file")
    .action(stub("preflight"));

  program
    .command("start")
    .description("Admit a plan: preflight + substrate probe + lease + first step")
    .argument("<plan>", "path to the CE unified plan markdown file")
    .action(stub("start"));

  program
    .command("run")
    .description("Run the looping driver (--once = one step and exit)")
    .argument("[run-id]", "run id to drive (defaults to the current run)")
    .option("--once", "run one step and exit")
    .action(stub("run"));

  program
    .command("status")
    .description("Render the run state read from the journal without launching a driver")
    .argument("[run-id]", "run id (defaults to the current run)")
    .action(stub("status"));

  program
    .command("stop")
    .description("Request a stop: journal operator_decision stop and set the stop-requested flag")
    .argument("<run-id>", "run id")
    .action(stub("stop"));

  program
    .command("resolve")
    .description("Resolve an escalation with an operator decision")
    .argument("<run-id>", "run id")
    .argument("<escalation-id>", "escalation id")
    .requiredOption(
      "--decision <approve|deny|rework>",
      "operator decision",
      /^(approve|deny|rework)$/i,
    )
    .option("--note <text>", "optional note attached to the decision")
    .action(stub("resolve"));

  program
    .command("approve")
    .description("Approve a completed run (terminal: complete)")
    .argument("<run-id>", "run id")
    .action(stub("approve"));

  program
    .command("reject")
    .description("Reject a completed run (--rework or --end)")
    .argument("<run-id>", "run id")
    .option("--rework <unit-ids>", "comma-separated unit ids to route back to rework")
    .option("--end", "end the run without completion approval")
    .action(stub("reject"));

  program
    .command("amend")
    .description("Apply a change order: new snapshot, scoped re-preflight, affected units re-dispatched")
    .argument("<run-id>", "run id")
    .argument("<new-plan>", "path to the replacement CE unified plan markdown file")
    .action(stub("amend"));

  program
    .command("list")
    .description("List all runs in ~/.miah/runs/")
    .action(stub("list"));
}
