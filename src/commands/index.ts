import { Command } from "commander";
import { runPreflight } from "./preflight";
import { runStart } from "./start";
import { runCommand } from "./run";
import { runStatus } from "./status";
import { runStop } from "./stop";
import { runResolve, type ResolveDecision } from "./resolve";
import { runApprove } from "./approve";
import { runReject } from "./reject";
import { runAmend } from "./amend";
import { runList } from "./list";

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

/**
 * Wrap a command body so its numeric exit code becomes `process.exitCode` and
 * any thrown error becomes a non-zero exit with a message on stderr. A
 * synchronous body (status, list) sets the exit code synchronously; an async
 * body is awaited and sets it on completion. `errorPrefix` names the command
 * in the stderr message. Works for both.
 */
function runGuarded(action: () => number | Promise<number>, errorPrefix = "miah"): void {
  let code: number | Promise<number>;
  try {
    code = action();
  } catch (error) {
    console.error(`${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  if (typeof code === "number") {
    if (code !== 0) {
      process.exitCode = code;
    }
    return;
  }
  code
    .then((resolved) => {
      if (resolved !== 0) {
        process.exitCode = resolved;
      }
    })
    .catch((error: unknown) => {
      console.error(`${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

export function registerCommands(program: Command): void {
  program
    .command("preflight")
    .description("Run preflight on a plan")
    .argument("<plan>", "path to the CE unified plan markdown file")
    .action((plan: string) => {
      runGuarded(() => runPreflight(plan), "miah preflight");
    });

  program
    .command("start")
    .description("Admit a plan: preflight + substrate probe + lease + first step")
    .argument("<plan>", "path to the CE unified plan markdown file")
    .action((plan: string) => {
      runGuarded(() => runStart(plan), "miah start");
    });

  program
    .command("run")
    .description("Run the looping driver (--once = one step and exit)")
    .argument("[run-id]", "run id to drive (defaults to the current run)")
    .option("--once", "run one step and exit")
    .action((runId: string | undefined, opts: { once?: boolean }) => {
      runGuarded(() => runCommand(runId, { once: opts.once ?? false }), "miah run");
    });

  program
    .command("status")
    .description("Render the run state read from the journal without launching a driver")
    .argument("[run-id]", "run id (defaults to the current run)")
    .action((runId: string | undefined) => {
      runGuarded(() => runStatus(runId), "miah status");
    });

  program
    .command("stop")
    .description("Request a stop: journal operator_decision stop and set the stop-requested flag")
    .argument("<run-id>", "run id")
    .action((runId: string) => {
      runGuarded(() => runStop(runId), "miah stop");
    });

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
    .action((runId: string, escalationId: string, opts: { decision: string; note?: string }) => {
      runGuarded(() =>
        runResolve(runId, escalationId, opts.decision.toLowerCase() as ResolveDecision, opts.note),
        "miah resolve",
      );
    });

  program
    .command("approve")
    .description("Approve a completed run (terminal: complete)")
    .argument("<run-id>", "run id")
    .action((runId: string) => {
      runGuarded(() => runApprove(runId), "miah approve");
    });

  program
    .command("reject")
    .description("Reject a completed run (--rework or --end)")
    .argument("<run-id>", "run id")
    .option("--rework <unit-ids>", "comma-separated unit ids to route back to rework")
    .option("--end", "end the run without completion approval")
    .action((runId: string, opts: { rework?: string; end?: boolean }) => {
      const rework =
        opts.rework !== undefined
          ? opts.rework
              .split(",")
              .map((id) => id.trim())
              .filter((id) => id.length > 0)
          : [];
      runGuarded(() => runReject(runId, { rework, end: opts.end ?? false }), "miah reject");
    });

  program
    .command("amend")
    .description("Apply a change order: new snapshot, scoped re-preflight, affected units re-dispatched")
    .argument("<run-id>", "run id")
    .argument("<new-plan>", "path to the replacement CE unified plan markdown file")
    .action((runId: string, newPlan: string) => {
      runGuarded(() => runAmend(runId, newPlan), "miah amend");
    });

  program
    .command("list")
    .description("List all runs in ~/.miah/runs/")
    .action(() => {
      runGuarded(() => runList(), "miah list");
    });
}
