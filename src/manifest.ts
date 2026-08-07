/**
 * Run manifest (`manifest.json`) (R31, R80).
 *
 * Written at admission and never mutated after. It records the run id, the
 * plan snapshot hash (R23), the path of the immutable plan snapshot, and a
 * snapshot of the config read at admission time (R80) so a run in progress
 * keeps using the config it was admitted with. `probe_verdicts` is a
 * placeholder for the substrate-probe findings recorded in U4 (R57, R86-R87).
 */
import * as fs from "fs";
import { Config } from "./types";
import { RunStoreLayout } from "./run-store";

export const MANIFEST_FILENAME = "manifest.json";

export interface Manifest {
  schema_version: 1;
  run_id: string;
  /** SHA-256 content hash of the canonicalized plan snapshot (R23, R85). */
  plan_hash: string;
  /** Filename (not path) of the immutable plan snapshot (R32). */
  plan_snapshot_file: string;
  /** ISO timestamp of admission. */
  created_at: string;
  /** Config as read at admission (R80). */
  config_snapshot: Config;
  /** Substrate probe verdicts; populated in U4 (R57, R86-R87). */
  probe_verdicts: Record<string, unknown>;
}

export function writeManifest(layout: RunStoreLayout, manifest: Manifest): void {
  fs.mkdirSync(layout.root, { recursive: true });
  fs.writeFileSync(
    layout.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

/** Read the manifest; null when absent or unparseable. */
export function readManifest(layout: RunStoreLayout): Manifest | null {
  if (!fs.existsSync(layout.manifestPath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(layout.manifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const manifest = parsed as Record<string, unknown>;
    if (typeof manifest.run_id !== "string" || typeof manifest.plan_hash !== "string") {
      return null;
    }
    return parsed as unknown as Manifest;
  } catch {
    return null;
  }
}
