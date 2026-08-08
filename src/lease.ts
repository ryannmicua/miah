/**
 * Lease (`lease.lock`) mechanics (R39-R40, R72, KTD2/KTD8).
 *
 * `lease.lock` is `{holder_id, acquired_at, last_heartbeat_at, ttl_s}` plus an
 * optional terminal marker (`released`) set on release. It is the authority for
 * the current holder (R39): the journal carries lease events for audit, but
 * resume reads `lease.lock`.
 *
 * Acquisition uses temp-write-then-rename (`fs.renameSync`), which is atomic on
 * NTFS same-volume (KTD2) — the only atomicity primitive we rely on. Heartbeat
 * rewrites `last_heartbeat_at` the same way. A resumer takes the lease only
 * after the heartbeat is stale past TTL **plus** one failed renewal attempt,
 * never by stealing a fresh-heartbeat holder (R72, KTD8).
 *
 * No POSIX-only primitives are used (R84).
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** On-disk lease file shape (R39). Timestamps are epoch milliseconds. */
export interface LeaseFile {
  holder_id: string;
  acquired_at: number;
  last_heartbeat_at: number;
  ttl_s: number;
  released?: boolean;
  released_at?: number;
}

/** Thrown when a caller tries to write/act without a live lease it holds. */
export class LeaseNotHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseNotHeldError";
  }
}

export type AcquireResult =
  | { ok: true; reason: "acquired" | "already-held" | "stale-takeover"; lease: LeaseFile }
  | { ok: false; reason: "fresh-heartbeat"; lease: LeaseFile };

export interface LeaseOptions {
  ttl_s: number;
  heartbeat_interval_s: number;
  now?: () => number;
}

/** Journal sink used to append lease audit events (R35, R40). */
export interface LeaseJournalSink {
  append(holderId: string, type: string, payload: Record<string, unknown>): void;
}

/** Filename suffix used for lease temp files (cleaned up on acquire). */
const TEMP_SUFFIX = ".tmp";

export class Lease {
  private journalSink: LeaseJournalSink | null = null;

  constructor(
    readonly leasePath: string,
    private readonly opts: LeaseOptions,
  ) {}

  now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Attach the journal so acquire/renew/release append audit events (R35). */
  attachJournal(sink: LeaseJournalSink): void {
    this.journalSink = sink;
  }

  /** Read the current `lease.lock`; null when absent or unparseable. */
  read(): LeaseFile | null {
    if (!fs.existsSync(this.leasePath)) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.leasePath, "utf8"));
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const lease = parsed as Record<string, unknown>;
    if (
      typeof lease.holder_id !== "string" ||
      typeof lease.last_heartbeat_at !== "number" ||
      typeof lease.acquired_at !== "number" ||
      typeof lease.ttl_s !== "number"
    ) {
      return null;
    }
    return parsed as unknown as LeaseFile;
  }

  isReleased(lease: LeaseFile): boolean {
    return lease.released === true;
  }

  /** Fresh = not released and heartbeated within the TTL (R72). */
  isFresh(lease: LeaseFile): boolean {
    if (this.isReleased(lease)) {
      return false;
    }
    return this.now() - lease.last_heartbeat_at <= lease.ttl_s * 1000;
  }

  /** Current holder id, or null when free (absent/released). */
  holderId(): string | null {
    const lease = this.read();
    return lease === null || lease.released === true ? null : lease.holder_id;
  }

  private build(holderId: string): LeaseFile {
    const now = this.now();
    return {
      holder_id: holderId,
      acquired_at: now,
      last_heartbeat_at: now,
      ttl_s: this.opts.ttl_s,
    };
  }

  /** Atomic temp-write-then-rename (KTD2). Replaces the prior lease file. */
  private atomicWrite(lease: LeaseFile): void {
    const tmp = path.join(
      path.dirname(this.leasePath),
      `${path.basename(this.leasePath)}${TEMP_SUFFIX}-${process.pid}-${crypto
        .randomBytes(4)
        .toString("hex")}`,
    );
    fs.writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(tmp, this.leasePath);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
      throw error;
    }
  }

  /** Remove temp files left by a killed acquire (kill-drill temp hygiene). */
  private cleanupStaleTemps(): void {
    const dir = path.dirname(this.leasePath);
    if (!fs.existsSync(dir)) {
      return;
    }
    const prefix = `${path.basename(this.leasePath)}${TEMP_SUFFIX}`;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix)) {
        try {
          fs.rmSync(path.join(dir, entry), { force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  /**
   * Acquire the lease. Fails without touching `lease.lock` when a *different*
   * holder's heartbeat is fresh (R39, AE11). A stale lease is taken over only
   * after one failed renewal attempt (R72, KTD8).
   */
  acquire(holderId: string): AcquireResult {
    this.cleanupStaleTemps();
    const existing = this.read();

    // Already held by this holder with a fresh heartbeat: idempotent success.
    if (
      existing !== null &&
      existing.holder_id === holderId &&
      !this.isReleased(existing) &&
      this.isFresh(existing)
    ) {
      return { ok: true, reason: "already-held", lease: existing };
    }

    // Free: absent or marked terminal by a prior release.
    if (existing === null || this.isReleased(existing)) {
      const lease = this.build(holderId);
      this.atomicWrite(lease);
      this.journalSink?.append(holderId, "lease_acquired", {
        holder_id: holderId,
        acquired_at: lease.acquired_at,
      });
      return { ok: true, reason: "acquired", lease };
    }

    // Held by someone else with a fresh heartbeat: never steal (R39).
    if (this.isFresh(existing)) {
      return { ok: false, reason: "fresh-heartbeat", lease: existing };
    }

    // Same holder resumed after a long stall: refresh in place.
    if (existing.holder_id === holderId) {
      this.renew(holderId);
      return { ok: true, reason: "already-held", lease: this.read() as LeaseFile };
    }

    // Stale holder: first the one failed renewal attempt (we are not the
    // holder, so renewal necessarily fails), then take over (R72, KTD8).
    try {
      this.renew(holderId);
    } catch {
      // Expected failed renewal — the lease belongs to another holder.
    }
    const lease = this.build(holderId);
    this.atomicWrite(lease);
    this.journalSink?.append(holderId, "lease_acquired", {
      holder_id: holderId,
      acquired_at: lease.acquired_at,
      stale_takeover: true,
    });
    return { ok: true, reason: "stale-takeover", lease };
  }

  /**
   * Refresh `last_heartbeat_at`. Throws when the caller is not the current
   * holder (R40 heartbeat rewrite; the "positive renewal attempt" of R72).
   */
  renew(holderId: string): void {
    const lease = this.read();
    if (lease === null || this.isReleased(lease)) {
      throw new LeaseNotHeldError("no lease held");
    }
    if (lease.holder_id !== holderId) {
      throw new LeaseNotHeldError(`lease held by ${lease.holder_id}`);
    }
    this.atomicWrite({ ...lease, last_heartbeat_at: this.now() });
    this.journalSink?.append(holderId, "lease_renewed", { holder_id: holderId });
  }

  /** Renew only when the heartbeat interval has elapsed. Returns whether it did. */
  maybeHeartbeat(holderId: string): boolean {
    const lease = this.read();
    if (lease === null || this.isReleased(lease) || lease.holder_id !== holderId) {
      return false;
    }
    if (this.now() - lease.last_heartbeat_at < this.opts.heartbeat_interval_s * 1000) {
      return false;
    }
    this.renew(holderId);
    return true;
  }

  /**
   * Release: append a `lease_released` journal event, then mark `lease.lock`
   * terminal (R40). `lease.lock` stays readable (with `released: true`) so a
   * later resume can see the last holder for audit.
   */
  release(holderId: string): void {
    const lease = this.read();
    if (lease === null || this.isReleased(lease)) {
      throw new LeaseNotHeldError("no lease held");
    }
    if (lease.holder_id !== holderId) {
      throw new LeaseNotHeldError(`lease held by ${lease.holder_id}`);
    }
    const releasedAt = this.now();
    this.journalSink?.append(holderId, "lease_released", {
      holder_id: holderId,
      released_at: releasedAt,
    });
    this.atomicWrite({ ...lease, released: true, released_at: releasedAt });
  }

  /**
   * Single-writer gate (R15, R34): throw unless the caller is the current
   * holder with a fresh heartbeat. Used by the journal before every append.
   */
  assertActiveHolder(holderId: string): void {
    const lease = this.read();
    if (lease === null || this.isReleased(lease)) {
      throw new LeaseNotHeldError("no lease held");
    }
    if (lease.holder_id !== holderId) {
      throw new LeaseNotHeldError(`lease held by ${lease.holder_id}`);
    }
    if (!this.isFresh(lease)) {
      throw new LeaseNotHeldError("lease heartbeat stale");
    }
  }
}
