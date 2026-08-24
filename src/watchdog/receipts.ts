/**
 * Reap receipts — the out-of-journal artifact both sides share (U0, R23-R27).
 *
 * A reap receipt is a single JSON file under `<run-root>/reap-receipts/`,
 * written by atomic temp-write-then-rename. It records that a specialist was
 * terminated for running past its deadline. The watchdog writes it; the lease
 * holder (driver at step boundary, or watchdog after stale takeover) consumes
 * it by journaling `gap_recorded` + `dispatch_terminated` and deleting the file.
 *
 * Key properties:
 *   - keyed by dispatch attempt (idempotent overwrite, R24)
 *   - atomic write (crash-safe, KTD6)
 *   - tolerant read (missing/malformed = "nothing to do")
 *   - crash-consistent consumption ordering (F8)
 *   - shared drain helper used by both the driver and the watchdog (KTD4)
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { InFlightIntent, UnitId } from "../types";
import type { RunStore } from "../run-store";
import { recordDeadlineRefusal, refFromIntent } from "../dispatch";

// ---------------------------------------------------------------------------
// Schema (F9)
// ---------------------------------------------------------------------------

/** Schema identifier pinned to v1 (F9). */
export const REAP_RECEIPT_SCHEMA = "miah/reap-receipt/v1";

/** Adapter outcome recorded in a reap receipt. */
export type AdapterOutcome = "terminated" | "adapter-failed" | "no-recorded-agent";

/** One reap receipt on disk (R23). All fields are required. */
export interface ReapReceipt {
  schema: string;
  intent_id: string;
  agent_id: string | null;
  workspace_id: string | null;
  deadline: string;
  reap_timestamp: number;
  adapter_outcome: AdapterOutcome;
  error: string | null;
  unit_id: UnitId;
  role: string;
  take: number;
  run_id: string;
  reaper: string;
  version: string;
}

// ---------------------------------------------------------------------------
// Filename sanitization (F2/F10)
// ---------------------------------------------------------------------------

const RESERVED_DEVICE_NAMES = [
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];
const RESERVED_DEVICE_NAMES_LOWER = RESERVED_DEVICE_NAMES.map((n) => n.toLowerCase());

/**
 * Sanitize an attempt key into a safe Windows filename (F2/F10).
 * Lowercase ASCII, replace invalid chars with `-`, cap at 200 chars,
 * append intent-hash suffix for collision resistance.
 */
export function safeReceiptFilename(attempt: string): string {
  let s = attempt.toLowerCase();
  s = s.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length === 0) {
    s = "receipt";
  }
  if (
    RESERVED_DEVICE_NAMES_LOWER.includes(s) ||
    (s.startsWith("receipt-") && RESERVED_DEVICE_NAMES_LOWER.includes(s.slice(8))) ||
    RESERVED_DEVICE_NAMES_LOWER.some((name) => s.startsWith(name + "."))
  ) {
    s = `receipt-${s}`;
  }
  if (s.length > 200) {
    s = s.slice(0, 200);
  }
  const hash = crypto.createHash("sha256").update(attempt).digest("hex").slice(0, 8);
  s = `${s}-${hash}`;
  return `${s}.json`;
}

// ---------------------------------------------------------------------------
// Atomic write (KTD6)
// ---------------------------------------------------------------------------

/**
 * Write a reap receipt atomically (temp-write-then-rename). The directory is
 * created lazily on first write. On rename failure, the temp file is cleaned up.
 */
export function writeReceipt(reapReceiptsDir: string, receipt: ReapReceipt): string {
  fs.mkdirSync(reapReceiptsDir, { recursive: true });
  const filename = safeReceiptFilename(receipt.intent_id);
  const target = path.join(reapReceiptsDir, filename);
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Tolerant read
// ---------------------------------------------------------------------------

export type ReceiptReadResult =
  | { ok: true; receipt: ReapReceipt }
  | { ok: false; reason: string; filePath: string };

/**
 * Read a single receipt file tolerantly. Missing file, unparseable JSON,
 * missing required fields, wrong schema version, or truncated content all
 * yield `{ ok: false }` rather than throwing (KTD6, R27).
 */
export function readReceipt(filePath: string): ReceiptReadResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, reason: "missing", filePath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparseable", filePath };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object", filePath };
  }
  const r = parsed as Record<string, unknown>;

  // Validate ALL required fields with their types (R23, P2-7).
  if (r.schema !== REAP_RECEIPT_SCHEMA) {
    return { ok: false, reason: `wrong-schema: ${String(r.schema)}`, filePath };
  }
  if (typeof r.intent_id !== "string" || r.intent_id.length === 0) {
    return { ok: false, reason: "missing-intent-id", filePath };
  }
  if (typeof r.unit_id !== "string") {
    return { ok: false, reason: "missing-unit-id", filePath };
  }
  if (typeof r.reap_timestamp !== "number") {
    return { ok: false, reason: "missing-reap-timestamp", filePath };
  }
  if (typeof r.take !== "number") {
    return { ok: false, reason: "missing-take", filePath };
  }
  if (typeof r.role !== "string") {
    return { ok: false, reason: "missing-role", filePath };
  }
  if (typeof r.run_id !== "string") {
    return { ok: false, reason: "missing-run-id", filePath };
  }
  if (typeof r.deadline !== "string") {
    return { ok: false, reason: "missing-deadline", filePath };
  }
  if (typeof r.reaper !== "string") {
    return { ok: false, reason: "missing-reaper", filePath };
  }
  if (typeof r.version !== "string") {
    return { ok: false, reason: "missing-version", filePath };
  }
  if (typeof r.agent_id !== "string" && r.agent_id !== null) {
    return { ok: false, reason: "bad-agent-id", filePath };
  }
  if (typeof r.workspace_id !== "string" && r.workspace_id !== null) {
    return { ok: false, reason: "bad-workspace-id", filePath };
  }
  if (typeof r.error !== "string" && r.error !== null) {
    return { ok: false, reason: "bad-error", filePath };
  }
  const validOutcomes: AdapterOutcome[] = ["terminated", "adapter-failed", "no-recorded-agent"];
  if (!validOutcomes.includes(r.adapter_outcome as AdapterOutcome)) {
    return { ok: false, reason: `bad-adapter-outcome: ${String(r.adapter_outcome)}`, filePath };
  }
  return { ok: true, receipt: parsed as unknown as ReapReceipt };
}

// ---------------------------------------------------------------------------
// List receipts
// ---------------------------------------------------------------------------

/**
 * List all receipt files in the reap-receipts directory. Missing directory
 * returns an empty list (R27: absence means "no receipts", never an error).
 */
export function listReceipts(reapReceiptsDir: string): string[] {
  if (!fs.existsSync(reapReceiptsDir)) {
    return [];
  }
  return fs.readdirSync(reapReceiptsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(reapReceiptsDir, f));
}

// ---------------------------------------------------------------------------
// Match predicate
// ---------------------------------------------------------------------------

/**
 * Match a parsed receipt against the current in-flight intents. Returns the
 * matching InFlightIntent or null. Match on intent_id === idempotency_key;
 * verify unit_id and take agree (R27).
 */
export function matchReceipt(
  receipt: ReapReceipt,
  inFlightIntents: InFlightIntent[],
): InFlightIntent | null {
  for (const intent of inFlightIntents) {
    if (
      intent.idempotency_key === receipt.intent_id &&
      intent.unit_id === receipt.unit_id &&
      intent.take === receipt.take
    ) {
      return intent;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Consume (F8) — crash-consistent ordering
// ---------------------------------------------------------------------------

/**
 * Consume a matched receipt: append `gap_recorded` then `dispatch_terminated`,
 * then delete the file. Crash-consistent ordering (F8):
 *   1. Match already done by caller
 *   2. Append gap_recorded
 *   3. Append dispatch_terminated
 *   4. Delete receipt
 *
 * Any crash between steps produces a safe recovery:
 *   - Before step 2: receipt present, no events, next drain re-consumes
 *   - Between 2 and 3: gap present, no terminal, next drain re-appends both
 *   - Between 3 and 4: both events present, receipt present, next drain
 *     sees intent no longer in-flight, deletes receipt
 */
export function consume(
  store: RunStore,
  receipt: ReapReceipt,
  intent: InFlightIntent,
  filePath: string,
): void {
  // P2-4: Use the shared recordDeadlineRefusal to produce identical artifacts
  // by construction, not by careful imitation (KTD4).
  recordDeadlineRefusal(store, refFromIntent(intent), {
    agentId: intent.agent_id,
    workspaceId: intent.workspace_id,
  });
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // non-fatal: next drain will treat as already-closed (R27)
  }
}

// ---------------------------------------------------------------------------
// Shared drain helper (KTD4, R25, R27)
// ---------------------------------------------------------------------------

export interface DrainSummary {
  drained: number;
  discarded: number;
  errors: string[];
}

/**
 * Drain all reap receipts for a run. For each receipt:
 *   - parse (tolerant)
 *   - match against in-flight intents
 *   - if matched: consume (journal + delete)
 *   - if not matched: delete silently (R27)
 *
 * Requires the caller to already hold the lease.
 */
export function drainReapReceipts(store: RunStore, now?: () => number): DrainSummary {
  const summary: DrainSummary = { drained: 0, discarded: 0, errors: [] };
  const filePaths = listReceipts(store.layout.reapReceiptsDir);
  if (filePaths.length === 0) return summary;
  const state = store.replay().state;

  for (const filePath of filePaths) {
    const readResult = readReceipt(filePath);
    if (!readResult.ok) {
      summary.discarded += 1;
      try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
      continue;
    }
    const intent = matchReceipt(readResult.receipt, state.in_flight_intents);
    if (intent === null) {
      summary.discarded += 1;
      try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
      continue;
    }
    try {
      consume(store, readResult.receipt, intent, filePath);
      summary.drained += 1;
    } catch (error) {
      summary.errors.push(
        `consume failed for ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return summary;
}
