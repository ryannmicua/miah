/**
 * Watchdog kill — adapter.stop wrapper (U3, R2, KTD3).
 *
 * Builds a PaseoHandle from the InFlightIntent's recorded agent_id and
 * workspace_id (no inspect round-trip), calls adapter.stop, and records
 * the outcome. An intent with null/empty agent_id produces a
 * "no-recorded-agent" receipt instead of a stop call.
 */
import type { InFlightIntent } from "../types";
import type { PaseoAdapter, PaseoHandle } from "../adapter/paseo";
import type { AdapterOutcome } from "./receipts";

/** Result of attempting to kill one overdue dispatch. */
export interface KillResult {
  /** The adapter outcome recorded in the receipt. */
  outcome: AdapterOutcome;
  /** Error message when adapter_outcome is "adapter-failed". */
  error: string | null;
  /** The handle used (or null when no agent_id). */
  handle: PaseoHandle | null;
}

/**
 * Attempt to kill one overdue dispatch intent (R2).
 *
 * - null/empty agent_id → no stop call, outcome "no-recorded-agent"
 * - adapter.stop succeeds → outcome "terminated"
 * - adapter.stop throws → outcome "adapter-failed", error recorded
 */
export async function killIntent(
  adapter: PaseoAdapter,
  intent: InFlightIntent,
): Promise<KillResult> {
  // KTD3: build handle directly from recorded identity; no inspect round-trip.
  if (!intent.agent_id || intent.agent_id.trim().length === 0) {
    return { outcome: "no-recorded-agent", error: null, handle: null };
  }

  const handle: PaseoHandle = {
    agentId: intent.agent_id,
    cwd: null,
    workspaceId: intent.workspace_id,
  };

  try {
    await adapter.stop(handle);
    return { outcome: "terminated", error: null, handle };
  } catch (err) {
    return {
      outcome: "adapter-failed",
      error: err instanceof Error ? err.message : String(err),
      handle,
    };
  }
}
