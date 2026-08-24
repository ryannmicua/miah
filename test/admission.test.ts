/**
 * U4 admission-gate tests. The fail-closed substrate cases use fake probes
 * (deterministic); the fake-probe pass case asserts the full run-store write
 * (config snapshot, lease, plan snapshot, units.json, journal). The final
 * suite runs the REAL probe against the live daemon and asserts admission
 * fails closed with the max-duration-absent message — the test that keeps
 * R4/R5 honest. The live probe here uses no provider, so no throwaway agent
 * is dispatched (immutability honestly reports unverifiable).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { admitPlan, maxDurationAbsentMessage, mcpUnscopableMessage } from "../src/admission";
import { PaseoSubstrateProbe, type SubstrateProbeReport } from "../src/substrate-probe";
import { DEFAULT_CONFIG } from "../src/types";
import { makeFakeProbe, makeFakeProbeReport } from "./fixtures/fake-substrate-probe";

const FIXTURES = path.join(__dirname, "fixtures");
const VALID_PLAN = fs.readFileSync(path.join(FIXTURES, "valid-plan.md"), "utf8");
const BAD_PLAN = fs.readFileSync(path.join(FIXTURES, "bad-plan.md"), "utf8");

const tempDirs: string[] = [];

function makeTempDir(prefix = "miah-admission-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function admitOptions(report: SubstrateProbeReport) {
  return {
    probe: makeFakeProbe(report),
    config: DEFAULT_CONFIG,
    basePath: makeTempDir(),
    holderId: "holder-admission",
  };
}

describe("admission fails closed", () => {
  it("refuses when preflight fails, returning structured failures and creating no run store", async () => {
    const opts = admitOptions(makeFakeProbeReport());
    const result = await admitPlan(BAD_PLAN, opts);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === "preflight-failed")).toBe(true);
    expect(result.run).toBeNull();
    // No run store was created under the base path.
    const runsPath = path.join(opts.basePath, "runs");
    expect(fs.existsSync(runsPath)).toBe(false);
  });

  it("fails closed on max-duration absent with a message naming the missing mechanism (R4/R5, R86)", async () => {
    const report = makeFakeProbeReport({
      max_duration: {
        status: "absent",
        evidence: ["no --max-duration / --expires-at / --budget flag in `paseo run --help`"],
      },
    });
    const result = await admitPlan(VALID_PLAN, admitOptions(report));
    expect(result.ok).toBe(false);
    const failure = result.failures.find((f) => f.kind === "max-duration-absent");
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("max-duration");
    expect(failure?.message).toContain("ABSENT");
    expect(failure?.message).toContain("--max-duration");
    expect(result.run).toBeNull();
    expect(maxDurationAbsentMessage(report)).toContain("To satisfy the max-duration gate, either:");
  });

  it("fails closed on MCP unscopable with a message naming the issue and the operator workaround (R87)", async () => {
    const report = makeFakeProbeReport({
      mcp_injection: {
        status: "unscopable",
        global_injection_enabled: true,
        per_agent_scoping: false,
        evidence: ["no per-agent MCP scoping flag"],
      },
    });
    const result = await admitPlan(VALID_PLAN, admitOptions(report));
    expect(result.ok).toBe(false);
    const failure = result.failures.find((f) => f.kind === "mcp-unscopable");
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("MCP");
    expect(failure?.message).toContain("injectIntoAgents");
    expect(failure?.message).toContain("disable");
    expect(mcpUnscopableMessage(report)).toContain("~/.paseo/config.json");
  });

  it("records both substrate failures when both are present", async () => {
    const report = makeFakeProbeReport({
      max_duration: { status: "absent", evidence: ["no flag"] },
      mcp_injection: {
        status: "unscopable",
        global_injection_enabled: true,
        per_agent_scoping: false,
        evidence: ["no scoping"],
      },
    });
    const result = await admitPlan(VALID_PLAN, admitOptions(report));
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind).sort()).toEqual([
      "max-duration-absent",
      "mcp-unscopable",
    ]);
  });
});

describe("admission proceeds (fake probe all present)", () => {
  it("writes config snapshot, acquires the lease, writes the plan snapshot, opens the journal", async () => {
    const opts = admitOptions(makeFakeProbeReport());
    const result = await admitPlan(VALID_PLAN, opts);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.caveats).toEqual([]);
    expect(result.run).not.toBeNull();

    const { layout } = result.run as { layout: { root: string; manifestPath: string; leasePath: string; planSnapshotPath: string; unitsJsonPath: string; journalPath: string } };

    // Plan snapshot written (R23).
    expect(fs.existsSync(layout.planSnapshotPath)).toBe(true);
    expect(fs.readFileSync(layout.planSnapshotPath, "utf8")).toContain("Valid Miah Test Plan");

    // units.json written (R24).
    const units = JSON.parse(fs.readFileSync(layout.unitsJsonPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(units)).toEqual(["U1", "U2", "U3"]);

    // Manifest with the admission-time config snapshot (R80) and probe verdicts.
    const manifest = JSON.parse(fs.readFileSync(layout.manifestPath, "utf8")) as {
      run_id: string;
      plan_hash: string;
      config_snapshot: unknown;
      probe_verdicts: SubstrateProbeReport & { caveats: string[] };
    };
    expect(manifest.run_id).toBe(result.run?.runId);
    expect(manifest.plan_hash).toBe(result.run?.planHash);
    expect(manifest.config_snapshot).toEqual(DEFAULT_CONFIG);
    expect(manifest.probe_verdicts.max_duration.status).toBe("present");
    expect(manifest.probe_verdicts.mcp_injection.status).toBe("scoped");
    expect(manifest.probe_verdicts.immutability.status).toBe("present");
    expect(manifest.probe_verdicts.caveats).toEqual([]);

    // Lease acquired (lease.lock exists, held by the admission holder).
    const lease = JSON.parse(fs.readFileSync(layout.leasePath, "utf8")) as { holder_id: string; released?: boolean };
    expect(lease.holder_id).toBe("holder-admission");
    expect(lease.released).not.toBe(true);

    // Journal opened with run_start (R35).
    const journal = fs.readFileSync(layout.journalPath, "utf8").trim().split("\n");
    const events = journal.map((line) => JSON.parse(line) as { type: string; run_id?: string; plan_hash?: string });
    expect(events.map((e) => e.type)).toContain("run_start");
    const runStart = events.find((e) => e.type === "run_start");
    expect(runStart?.run_id).toBe(result.run?.runId);
    expect(runStart?.plan_hash).toBe(result.run?.planHash);
  });

  it("records an immutability-absent caveat in the manifest but still proceeds (R46, not a refusal)", async () => {
    const report = makeFakeProbeReport({
      immutability: { status: "absent", evidence: ["write succeeded"] },
    });
    report.caveats = [
      "post-termination-immutability-absent: a terminated agent's worktree remained writable",
    ];
    const result = await admitPlan(VALID_PLAN, admitOptions(report));
    expect(result.ok).toBe(true);
    expect(result.caveats.join(" ")).toContain("post-termination-immutability-absent");
    const manifest = JSON.parse(
      fs.readFileSync((result.run as { layout: { manifestPath: string } }).layout.manifestPath, "utf8"),
    ) as { probe_verdicts: { caveats: string[] } };
    expect(manifest.probe_verdicts.caveats.join(" ")).toContain("post-termination-immutability-absent");
  });

  it("rejects execution: knowledge-work even when the substrate passes", async () => {
    const knowledgeWorkPlan = `---
title: Knowledge Plan
artifact_contract: ce-unified-plan/v1
execution: knowledge-work
---

# Knowledge Plan

## Implementation Units

### U1. Write the doc

- **creates:** none
- **inputs:** none
- **depends-on:** none
- **Acceptance:**
  - U1.AC1. Something - \`tier: deterministic\`
- **Verification Contract:**
  - **Commands:** \`U1.CMD1\` = \`npm test\`
  - **Criterion mapping:** \`U1.AC1\` -> \`U1.CMD1\`
  - **Evidence sources:** \`verification\`
`;
    const result = await admitPlan(knowledgeWorkPlan, admitOptions(makeFakeProbeReport()));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.message.includes("knowledge-work"))).toBe(true);
  });
});

describe("admission against the live daemon", () => {
  it("fails closed with the max-duration-absent message (the test that keeps R4/R5 honest)", async () => {
    const probe = new PaseoSubstrateProbe(); // real probe; no provider -> no throwaway dispatch
    const result = await admitPlan(VALID_PLAN, {
      probe,
      config: DEFAULT_CONFIG,
      basePath: makeTempDir(),
      holderId: "holder-live",
    });

    expect(result.ok).toBe(false);
    const maxDurationFailure = result.failures.find((f) => f.kind === "max-duration-absent");
    expect(maxDurationFailure).toBeDefined();
    expect(maxDurationFailure?.message).toContain("max-duration");
    expect(maxDurationFailure?.message).toContain("ABSENT");
    // No journal was created (admission refused before any run-store write).
    expect(result.run).toBeNull();

    // MCP: if the live daemon runs global injection, this is also a refusal.
    if (probeReportSaysGlobalInjection(result.probe)) {
      const mcpFailure = result.failures.find((f) => f.kind === "mcp-unscopable");
      expect(mcpFailure).toBeDefined();
      expect(mcpFailure?.message).toContain("injectIntoAgents");
    }

    // Capture the fail-closed message for the verification gate.
    console.log(`[live-admission-fail-closed] ${maxDurationFailure?.message}`);
  }, 90_000);
});

function probeReportSaysGlobalInjection(
  probe: SubstrateProbeReport | null,
): boolean {
  return probe?.mcp_injection.global_injection_enabled === true;
}
