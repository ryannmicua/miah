/**
 * Watchdog heartbeat artifact (U4, R19-R20, KD4).
 *
 * The heartbeat is a JSON file written on every tick to the run-store root
 * (NOT inside any single run). It proves the watchdog's poll loop is executing.
 * Admission checks freshness (R20): healthy when age <= 2x cadence.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Heartbeat file shape (R19). */
export interface HeartbeatFile {
  /** ISO timestamp of the tick. */
  timestamp: string;
  /** Watchdog version from package.json. */
  version: string;
  /** Configured cadence in seconds. */
  cadence_s: number;
}

/** Heartbeat filename under the run-store root. */
export const HEARTBEAT_FILENAME = "watchdog-heartbeat.json";

/** Absolute path of the heartbeat file given a run-store base path. */
export function heartbeatPath(basePath: string): string {
  return path.join(basePath, HEARTBEAT_FILENAME);
}

/**
 * Write the heartbeat atomically (temp-write-then-rename).
 * Called on every tick including ticks where nothing was reaped (R19).
 */
export function writeHeartbeat(
  basePath: string,
  version: string,
  cadenceS: number,
): void {
  const hb: HeartbeatFile = {
    timestamp: new Date().toISOString(),
    version,
    cadence_s: cadenceS,
  };
  const target = heartbeatPath(basePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, `${JSON.stringify(hb, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Read the heartbeat file tolerantly. Returns null when absent, unparseable,
 * or missing required fields (R20).
 */
export function readHeartbeat(basePath: string): HeartbeatFile | null {
  const p = heartbeatPath(basePath);
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text);
    if (
      typeof raw === "object" && raw !== null &&
      typeof raw.timestamp === "string" &&
      typeof raw.version === "string" &&
      typeof raw.cadence_s === "number"
    ) {
      return raw as HeartbeatFile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Freshness predicate (R20): healthy when heartbeat exists and age <= 2x cadence.
 * Returns `{ healthy: boolean; heartbeat: HeartbeatFile | null; ageMs: number }`.
 */
export function heartbeatFreshness(
  basePath: string,
  now?: number,
): { healthy: boolean; heartbeat: HeartbeatFile | null; ageMs: number } {
  const hb = readHeartbeat(basePath);
  if (hb === null) {
    return { healthy: false, heartbeat: null, ageMs: Infinity };
  }
  const hbTime = Date.parse(hb.timestamp);
  if (Number.isNaN(hbTime)) {
    return { healthy: false, heartbeat: hb, ageMs: Infinity };
  }
  const ageMs = (now ?? Date.now()) - hbTime;
  const maxAgeMs = hb.cadence_s * 2 * 1000;
  return { healthy: ageMs <= maxAgeMs, heartbeat: hb, ageMs };
}
