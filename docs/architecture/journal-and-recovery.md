---
mode: explanation
verified: 2026-08-09
---

# Mechanism: Disk-First Durable Core — Journal, Lease, Snapshots, Replay

This is an **explanation** of the load-bearing primitives that make Miah resumable: the append-only journal (`journal.jsonl`), the single-writer lease (`lease.lock`), periodic derived-state snapshots, and replay-from-snapshot-plus-tail. Exact data shapes live in [data-and-security](./data-and-security.md); the system's other layers are [dispatch-and-isolation](./dispatch-and-isolation.md) and [evidence-and-acceptance](./evidence-and-acceptance.md). The validating incident and the generalizable lessons are in the [disk-first-paseo-loop pattern](../../docs/solutions/patterns/disk-first-paseo-loop.md).

## The problem this mechanism solves

Miah's central claim is *resume is the only implementation*: a crash at any point must lose nothing, and every invocation must be able to reconstruct everything the run knows from disk. A process cannot hold that state (memory dies); a session cannot (it dies); so the run's memory lives in three files that any process can read. The design is a direct adoption of durable-execution mechanics — write-ahead logging, idempotency keys, leases, reconcile-on-resume — without a durable-execution *runtime* (ADR:D1, "Adopt a durable-execution engine" row).

## The append-only journal

The journal is one JSONL file, one typed event per line, each `{seq, type, timestamp, ...payload}` (`src/types.ts:233-238`). It is **append-only** by construction: appends use `fs.appendFileSync`, never replace (`src/journal.ts:203-211`). The atomic temp-write-then-rename primitive is deliberately *not* used here — replacing the file would discard prior events. That primitive is reserved for the lease and snapshots, which legitimately replace their file.

Why append-only matters is easiest to see at the failure boundary. A crash mid-append may leave a partial trailing line. `parseJournalText` tolerates a malformed *final* line (a crash-truncated tail) and reports it as such, but a malformed *non-tail* line is corruption and throws (`src/journal.ts:62-86`). `repairJournalTail` truncates the malformed tail via temp-write-then-rename, restoring the last complete event and never destroying valid events (`src/journal.ts:113-142`). The same honesty applies to sequence numbers: `deriveState` and `replayFromSnapshot` throw on a duplicate or out-of-order `seq`, because that means the journal was corrupted or events were duplicated — the safe failure is loud, not silent (`src/replay.ts:334-342`, `src/replay.ts:485-492`).

## The single-writer lease

The journal is written by exactly one process at a time. The lease (`lease.lock`) is the authority for who that is (`src/lease.ts:5-7`): it carries `{holder_id, acquired_at, last_heartbeat_at, ttl_s}`, plus an optional terminal `released` marker.

The lease is where the atomic-write primitive earns its keep: acquisition, heartbeat, and release all write a temp file then `fs.renameSync` it over `lease.lock` (`src/lease.ts:129-147`), which is atomic on the same volume (NTFS on Windows, the operator's environment; `PLAN:KTD2`). A torn write can never corrupt a prior lease.

The rules that keep the lease honest (`src/lease.ts:172-223`, `acquire`):

- **Never steal a fresh heartbeat.** If a different holder's heartbeat is fresh, acquisition fails without touching the file. This is the R39 invariant, and it is what makes two drivers competing for a run safe: the loser gets `lease-held` and exits (`src/driver.ts:336-345`).
- **Same holder, fresh heartbeat → idempotent success** (`already-held`), so a driver re-running is a no-op.
- **Same holder, stale heartbeat → refresh in place.**
- **Stale holder → one failed renewal attempt, then takeover** (`stale-takeover`). The resumer does not steal on TTL alone; it must first attempt a renewal that fails (it is not the holder). This is the R72/KTD8 discipline: TTL **plus** one failed renewal before takeover.

Heartbeats happen at the step boundary and on release: `maybeHeartbeat` refreshes `last_heartbeat_at` when the interval has elapsed (`src/lease.ts:242-252`), and the driver renews at every loop iteration (`src/driver.ts:388`). Every lease operation is journaled (`lease_acquired`/`lease_renewed`/`lease_released`) for audit, but the *authority* is always `lease.lock` — resume reads the file, not the events (`src/lease.ts:5-7`).

The journal is gated on the lease: `RunStore` wires the lease's `assertActiveHolder` as the journal's `verifyHolder`, so every append re-checks that the caller still holds a fresh lease (`src/run-store.ts:136-139`, `src/lease.ts:279-290`). The holder gate is what makes the journal's single-writer property structural, not aspirational.

## Snapshots and replay

Replaying the entire journal on every invocation is correct but unbounded. Snapshots make it O(tail): every K events (default 50), `RunStore.append` writes a derived-state snapshot via temp-write-then-rename (`src/run-store.ts:181-189`, `src/replay.ts:353-374`). A torn snapshot is treated as absent — the journal itself is the authority — so a broken snapshot degrades to a full replay rather than blocking it (`src/replay.ts:424-447`).

Replay (`replayFromSnapshot`) reads the latest `snapshots/state-<seq>.json`, then folds the journal events *after* that seq through `applyEvent` (`src/replay.ts:471-498`). The boundary is the snapshot file's own seq, not the stored state's seq, so a snapshot can never silently skip events. The result is byte-identical to a full replay from seq 1 — that is the property the kill drill asserts (see [kill-drill-byte-identical-resume-verification pattern](../../docs/solutions/patterns/kill-drill-byte-identical-resume-verification.md)).

`applyEvent` reconstructs only **derived state**: run identity, phase, per-unit statuses, in-flight intents, open gaps, terminal marker (`src/replay.ts:90-288`). Raw contexts, tool inputs, and specialist prose are never stored (`PLAN:D7-a`) — they cannot be reconstructed, and the design does not need them. Missing or malformed payload values are treated as absent; a malformed event never corrupts derived state (`src/replay.ts:87-89`). One derived step is not an event fold but a graph computation: `computeBlocked` marks a `not_started` unit `blocked` when a dependency is unaccepted, using the `units.json` dependency graph (`src/replay.ts:297-321`).

## How recovery actually runs

The driver's recovery sequence (`src/driver.ts:318-384`):

1. **Acquire the lease.** Fail fast with `lease-held` if another driver holds a fresh heartbeat.
2. **Replay under lease** (`store.replay()`), repairing a crash-truncated tail first (`src/run-store.ts:162-169`).
3. **Honor a recorded stop** before anything else — the stop-requested flag written by `miah stop` is durable, so a stop recorded while no driver was alive is honored on the next `miah run` (`src/driver.ts:350-355`, `src/driver.ts:63-92`).
4. **Reconcile in-flight intents** against the adapter (one per session), then run the step loop — see [dispatch-and-isolation](./dispatch-and-isolation.md) for the reconciliation half.
5. **Release the lease on every clean exit** so the next driver resumes immediately (`src/driver.ts:169-178`).

The `miah status` and `miah list` commands are strictly read-only: they reconstruct state from the journal without acquiring the lease, repairing the journal, or launching a driver (`src/commands/status.ts:86-90`, `src/commands/list.ts:46`).

## Failure behavior

| Failure | Behavior | Source |
|---|---|---|
| Crash mid-append | malformed tail repaired once on the next write/replay | `src/journal.ts:182-189` |
| Malformed non-tail line | `JournalCorruptionError` thrown (never silently dropped) | `src/journal.ts:62-86` |
| Duplicate/out-of-order seq | `JournalCorruptionError` thrown | `src/replay.ts:334-342` |
| Torn snapshot | treated as absent; full journal replay | `src/replay.ts:424-447` |
| Lease held with fresh heartbeat | acquisition fails; driver exits `lease-held` | `src/lease.ts:197-200`, `src/driver.ts:336-345` |
| Stale lease | one failed renewal, then takeover (journaled `stale_takeover`) | `src/lease.ts:208-222` |
| Append by non-holder | `LeaseNotHeldError` thrown | `src/lease.ts:279-290`, `src/journal.ts:203-205` |
| Stop recorded while no driver alive | honored on the next `miah run` | `src/driver.ts:350-355` |

The three-level kill drill proves these behaviors under real crashes: v1 at the journal/lease level (`test/kill-drill-v1.test.ts`), v2 at the dispatch level (`test/kill-drill-v2.test.ts`), v3 as full E2E (`test/e2e/kill-drill.test.ts`).
