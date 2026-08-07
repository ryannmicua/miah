/**
 * `miah list` command (R63, KTD15).
 *
 * Scans `~/.miah/runs/` and prints one line per run: run id, plan title,
 * current phase, and last journal activity. Read-only — never acquires a
 * lease, repairs a journal, or launches a driver.
 */
import { loadConfig, resolveConfigBasePath } from "../config";
import { readJournalFile } from "../journal";
import { readManifest } from "../manifest";
import { listRunIds, resolveRunLayout, RunStore } from "../run-store";
import type { Config } from "../types";
import { findLatestPlanSnapshot, planTitleOf, readOnlyState } from "./status";

/** Exit code on unexpected list errors. */
export const LIST_ERROR_EXIT_CODE = 1;

export interface ListOptions {
  config?: Config;
  basePath?: string;
}

/** Timestamp of the newest journal event, or null when the journal is empty. */
function lastActivityTimestamp(journalPath: string): number | null {
  const { events } = readJournalFile(journalPath);
  let max = 0;
  for (const event of events) {
    if (typeof event.timestamp === "number" && event.timestamp > max) {
      max = event.timestamp;
    }
  }
  return max > 0 ? max : null;
}

/**
 * Run `miah list`. Prints every run under the run store and returns the
 * process exit code (always 0; an empty run store prints "no runs").
 */
export function runList(opts: ListOptions = {}): number {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const ids = listRunIds(basePath);
  if (ids.length === 0) {
    console.log("miah: no runs");
    return 0;
  }
  const config = opts.config ?? loadConfig();
  for (const runId of ids) {
    const layout = resolveRunLayout(basePath, runId);
    const manifest = readManifest(layout);
    const store = new RunStore({ basePath, runId, config, holderId: "list-reader" });
    const state = readOnlyState(store);
    const snapshot = findLatestPlanSnapshot(layout);
    const title = snapshot !== null ? planTitleOf(snapshot.filePath) : null;
    const last = lastActivityTimestamp(layout.journalPath);
    const lastText = last === null ? "never" : new Date(last).toISOString();
    console.log(`${runId}  ${title ?? "(untitled)"}  ${state.phase}  last activity: ${lastText}`);
  }
  return 0;
}
