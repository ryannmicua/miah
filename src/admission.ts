/**
 * Admission gate (R57, R80, U4): `preflight(plan, workspace) ∧ substrateProbe()`.
 *
 * `admitPlan` composes the pure preflight verdict (R55-R60) with the live
 * substrate probe and fails closed on any blocker:
 *
 *   - preflight failure        -> structured failures, no run store
 *   - max-duration absent      -> refused, message names the missing mechanism
 *                                 (R4/R5, R57, R86)
 *   - MCP injection unscopable -> refused, message names the issue + operator
 *                                 workaround (R21, R87)
 *   - immutability absent      -> recorded as a manifest caveat, NOT a refusal
 *                                 (R46)
 *
 * When everything passes, admission writes the run store: the plan snapshot
 * (R23), `units.json` (R24), the manifest with the admission-time config
 * snapshot (R80) and probe verdicts, then acquires the lease and opens the
 * journal with a `run_start` event.
 */
import * as fs from "fs";
import * as path from "path";
import { Config } from "./types";
import { parsePlan } from "./parser";
import { PLAN_LEVEL, preflightPlan, type PreflightVerdict } from "./preflight";
import { runIdFromPlan, resolveRunLayout, RunStore, type RunStoreLayout } from "./run-store";
import { writeManifest, type Manifest } from "./manifest";
import { canonicalizePlan, computeContentHash, writeSnapshot } from "./snapshot";
import type { SubstrateProbe, SubstrateProbeReport } from "./substrate-probe";

export type AdmissionFailureKind = "preflight-failed" | "max-duration-absent" | "mcp-unscopable";

export interface AdmissionFailure {
  kind: AdmissionFailureKind;
  message: string;
}

export interface AdmittedRun {
  runId: string;
  layout: RunStoreLayout;
  planHash: string;
}

export interface AdmissionResult {
  ok: boolean;
  failures: AdmissionFailure[];
  /** Non-fatal caveats (e.g. immutability absent) recorded into the manifest. */
  caveats: string[];
  /** The preflight verdict (present on every path). */
  preflight: PreflightVerdict | null;
  /** The substrate probe report (present on every path). */
  probe: SubstrateProbeReport | null;
  /** The admitted run, or null when admission refused. */
  run: AdmittedRun | null;
}

export interface AdmitOptions {
  /** The injected substrate probe (U10 substitutes a fake; real one here). */
  probe: SubstrateProbe;
  /** Config read at admission time; snapshotted into the manifest (R80). */
  config: Config;
  /** Base path for the run store (`~/.miah` in production, temp in tests). */
  basePath: string;
  /** Identity of the lease holder (the admitting/driving process). */
  holderId: string;
  /** Workspace path set for the referential preflight (R56(b)). */
  workspacePaths?: string[];
  now?: () => number;
}

export function maxDurationAbsentMessage(probe: SubstrateProbeReport): string {
  const evidence = probe.max_duration.evidence.join("; ") || "no evidence recorded";
  return [
    "substrate probe: per-agent max-duration is ABSENT — admission fails closed (R4/R5, R57, R86).",
    "Mechanism needed: a Paseo daemon-enforced per-agent duration/expiry flag",
    "(e.g. --max-duration, --expires-at, or --budget) on `paseo run` so Miah can bound specialist runtime.",
    `Evidence: ${evidence}.`,
  ].join(" ");
}

export function mcpUnscopableMessage(probe: SubstrateProbeReport): string {
  const evidence = probe.mcp_injection.evidence.join("; ") || "no evidence recorded";
  return [
    "substrate probe: agent-orchestration MCP injection is UNSCCOPABLE — admission fails closed (R21, R87).",
    "daemon.mcp.injectIntoAgents is enabled and no per-agent MCP scoping flag exists",
    "(checked `paseo run --help` and `paseo agent update --help`), so specialists could reach",
    "agent-orchestration MCP tools.",
    "Operator workaround: disable daemon.mcp.injectIntoAgents in ~/.paseo/config.json while Miah runs.",
    `Evidence: ${evidence}.`,
  ].join(" ");
}

function renderPreflightFailure(preflight: PreflightVerdict): string {
  const lines = preflight.failures.map(
    (finding) =>
      `  - ${finding.unitId === PLAN_LEVEL ? "plan-level" : `[${finding.unitId}]`} ` +
      `(${finding.class}/${finding.code}): ${finding.message}`,
  );
  return `preflight failed (${preflight.failures.length} finding${
    preflight.failures.length === 1 ? "" : "s"
  }):\n${lines.join("\n")}`;
}

/**
 * Admit a plan: preflight ∧ substrate probe, then write the run store. Pure
 * preflight needs no run state; admission is the gate that does.
 */
export async function admitPlan(planText: string, opts: AdmitOptions): Promise<AdmissionResult> {
  const failures: AdmissionFailure[] = [];
  const caveats: string[] = [];

  const preflight = preflightPlan(planText, opts.workspacePaths ?? []);
  if (!preflight.ok) {
    failures.push({ kind: "preflight-failed", message: renderPreflightFailure(preflight) });
  }
  if (preflight.execution === "knowledge-work") {
    failures.push({
      kind: "preflight-failed",
      message: "execution: knowledge-work is out of v1 scope (R22); admission rejects this plan.",
    });
  }

  const probe = await opts.probe.run();
  if (probe.max_duration.status !== "present") {
    failures.push({ kind: "max-duration-absent", message: maxDurationAbsentMessage(probe) });
  }
  if (probe.mcp_injection.status === "unscopable") {
    failures.push({ kind: "mcp-unscopable", message: mcpUnscopableMessage(probe) });
  }
  caveats.push(...probe.caveats);

  if (failures.length > 0) {
    return { ok: false, failures, caveats, preflight, probe, run: null };
  }

  return admitRunStore(planText, { ...opts, probe, preflight, caveats });
}

function admitRunStore(
  planText: string,
  opts: Omit<AdmitOptions, "probe"> & {
    probe: SubstrateProbeReport;
    preflight: PreflightVerdict;
    caveats: string[];
  },
): AdmissionResult {
  const nowMs = opts.now ? opts.now() : Date.now();
  const plan = parsePlan(planText);

  // The run id derives from the plan content hash (R31); compute it before any
  // write so the snapshot lands in the run's own directory.
  const planHash = computeContentHash(canonicalizePlan(planText));
  const runId = runIdFromPlan(planHash, nowMs);
  const layout = resolveRunLayout(opts.basePath, runId);
  const snapshot = writeSnapshot(planText, layout.root);

  const store = new RunStore({
    basePath: opts.basePath,
    runId,
    config: opts.config,
    holderId: opts.holderId,
    now: opts.now,
  });

  // units.json: the parsed-once machine view (R24).
  fs.writeFileSync(layout.unitsJsonPath, `${JSON.stringify(plan.units, null, 2)}\n`, "utf8");

  // Manifest: run identity, plan hash, admission-time config snapshot (R80),
  // and the probe verdicts (R86-R87). Written once, never mutated.
  const manifest: Manifest = {
    schema_version: 1,
    run_id: runId,
    plan_hash: snapshot.hash,
    plan_snapshot_file: path.basename(snapshot.filePath),
    created_at: new Date(nowMs).toISOString(),
    config_snapshot: opts.config,
    probe_verdicts: {
      paseo_version: opts.probe.paseo_version,
      max_duration: opts.probe.max_duration,
      mcp_injection: opts.probe.mcp_injection,
      immutability: opts.probe.immutability,
      caveats: opts.caveats,
    },
  };
  writeManifest(layout, manifest);

  // Acquire the lease, then open the journal with run_start (R15, R35).
  const acquired = store.lease.acquire(opts.holderId);
  if (!acquired.ok) {
    return {
      ok: false,
      failures: [
        {
          kind: "preflight-failed",
          message: `lease held by ${acquired.lease.holder_id} with a fresh heartbeat; cannot admit`,
        },
      ],
      caveats: opts.caveats,
      preflight: opts.preflight,
      probe: opts.probe,
      run: null,
    };
  }
  store.append("run_start", { run_id: runId, plan_hash: snapshot.hash });

  return {
    ok: true,
    failures: [],
    caveats: opts.caveats,
    preflight: opts.preflight,
    probe: opts.probe,
    run: { runId, layout, planHash: snapshot.hash },
  };
}
