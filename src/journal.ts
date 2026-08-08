/**
 * Append-only JSONL journal (`journal.jsonl`) (R15, R33-R35, R40, KTD2).
 *
 * Each event is serialized as one JSON line and appended with
 * `fs.appendFileSync` — append-not-replace, because replacing the file would
 * discard prior events (the atomic temp-write-then-rename primitive is reserved
 * for the lease, which legitimately replaces its file). A crash mid-append may
 * leave a partial trailing line; replay validates each line and truncates a
 * malformed tail, restoring the last complete event (U3 approach).
 *
 * Only the process holding the lease may append (R15, R34): every append is
 * gated through a caller-supplied `verifyHolder` check that reads `lease.lock`.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import { JournalEvent } from "./types";

/** Thrown when a non-tail line fails to parse (real corruption). */
export class JournalCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalCorruptionError";
  }
}

export interface ParsedJournal {
  events: JournalEvent[];
  /** The final line when it is present but malformed (crash mid-append). */
  malformedTail: string | null;
  /** Description of a malformed non-tail line, or null when none. */
  corruption: string | null;
}

/** Parse one JSONL line into an event; null when blank or malformed. */
export function parseJournalLine(line: string): JournalEvent | null {
  const trimmed = line.replace(/\r$/, "");
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const event = parsed as Record<string, unknown>;
  if (
    typeof event.seq !== "number" ||
    typeof event.type !== "string" ||
    typeof event.timestamp !== "number"
  ) {
    return null;
  }
  return parsed as JournalEvent;
}

/** Split raw journal text into events. Malformed lines are only tolerated on
 * the final line (a crash-truncated tail); anywhere else is corruption. */
export function parseJournalText(text: string): ParsedJournal {
  const lines = text.split(/\r?\n/);
  const events: JournalEvent[] = [];
  let malformedTail: string | null = null;
  let corruption: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    const line = lines[i];
    if (line.length === 0) {
      continue;
    }
    const event = parseJournalLine(line);
    if (event === null) {
      if (isLast) {
        malformedTail = line;
      } else {
        corruption = `malformed line at index ${i + 1}`;
        break;
      }
    } else {
      events.push(event);
    }
  }
  return { events, malformedTail, corruption };
}

export interface ReadJournalResult {
  events: JournalEvent[];
  /** True when a malformed trailing line was present (and is being ignored). */
  truncated: boolean;
}

/** Read the journal without mutating it. Throws on mid-file corruption. */
export function readJournalFile(journalPath: string): ReadJournalResult {
  if (!fs.existsSync(journalPath)) {
    return { events: [], truncated: false };
  }
  const text = fs.readFileSync(journalPath, "utf8");
  const parsed = parseJournalText(text);
  if (parsed.corruption !== null) {
    throw new JournalCorruptionError(parsed.corruption);
  }
  return { events: parsed.events, truncated: parsed.malformedTail !== null };
}

/**
 * Atomically drop a crash-truncated trailing line (temp-write-then-rename, so
 * the rewrite can never destroy valid events). Returns whether a tail existed.
 * Always validates the full journal: a malformed non-tail line is corruption
 * and throws (never silently dropped).
 */
export function repairJournalTail(journalPath: string): boolean {
  if (!fs.existsSync(journalPath)) {
    return false;
  }
  const text = fs.readFileSync(journalPath, "utf8");
  const parsed = parseJournalText(text);
  if (parsed.corruption !== null) {
    throw new JournalCorruptionError(parsed.corruption);
  }
  if (parsed.malformedTail === null) {
    return false;
  }
  // Keep everything up to and including the last newline, preserving the exact
  // original bytes of the valid prefix (line endings, unicode, etc.).
  const lastNewline = text.lastIndexOf("\n");
  const validText = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
  const tmp = `${journalPath}.repair-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, validText, "utf8");
  try {
    fs.renameSync(tmp, journalPath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
  return true;
}

export interface JournalOptions {
  /**
   * Throws when `holderId` may not write. Reads `lease.lock` (via the Lease)
   * so the caller's claim is always checked against the actual holder (R15).
   */
  verifyHolder: (holderId: string) => void;
  now?: () => number;
}

export class Journal {
  private lastSeq: number | null = null;
  private initialized = false;

  constructor(
    readonly journalPath: string,
    private readonly opts: JournalOptions,
  ) {}

  now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Read-only load of the max complete seq (no mutation). */
  private loadReadOnly(): void {
    if (this.lastSeq !== null) {
      return;
    }
    const { events } = readJournalFile(this.journalPath);
    this.lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  }

  /**
   * One-time repair + load for this writer instance. A predecessor process may
   * have crashed mid-append leaving a partial tail; under the single-writer
   * lease no other writer can add one while this instance is alive, so this
   * runs once (the first append, after the holder gate) — keeps append O(1)
   * for the rest of the run while still repairing the crash tail exactly once.
   */
  private initialize(): void {
    if (this.initialized) {
      return;
    }
    repairJournalTail(this.journalPath);
    this.loadReadOnly();
    this.initialized = true;
  }

  /** Highest complete event seq currently on disk. */
  currentSeq(): number {
    this.loadReadOnly();
    return this.lastSeq as number;
  }

  /**
   * Append one event under the lease (R15, R34). The caller's holder id is
   * verified against `lease.lock` before any write. A crash-truncated tail from
   * a prior writer is repaired before extending the journal. Returns the
   * durable event (seq assigned, timestamp stamped).
   */
  append(holderId: string, type: string, payload: Record<string, unknown> = {}): JournalEvent {
    this.opts.verifyHolder(holderId);
    this.initialize();
    const seq = (this.lastSeq as number) + 1;
    const event: JournalEvent = { seq, type, timestamp: this.now(), ...payload };
    fs.appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, "utf8");
    this.lastSeq = seq;
    return event;
  }

  /** Read all complete events (read-only; a partial tail is ignored). */
  readEvents(): JournalEvent[] {
    const { events } = readJournalFile(this.journalPath);
    return events;
  }
}
