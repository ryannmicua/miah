/**
 * Fake substrate probe (KTD9, U10): reports every substrate check present so the
 * full Miah pipeline is E2E-testable against the live adapter now, while the
 * real Paseo daemon still lacks per-agent max-duration. Test-only; the
 * real-probe fail-closed tests always use the real implementation.
 */
import type { SubstrateProbe, SubstrateProbeReport } from "../../src/substrate-probe";

export function makeFakeProbeReport(
  overrides: Partial<SubstrateProbeReport> = {},
): SubstrateProbeReport {
  return {
    paseo_version: "fake-0.0.0",
    max_duration: { status: "present", evidence: ["fake: all substrate checks present"] },
    mcp_injection: {
      status: "scoped",
      global_injection_enabled: true,
      per_agent_scoping: true,
      evidence: ["fake: per-agent MCP scoping exists"],
    },
    immutability: { status: "present", evidence: ["fake: worktree immutable after termination"] },
    caveats: [],
    ...overrides,
  };
}

/** A probe stub whose `run()` returns the given report. */
export function makeFakeProbe(report: SubstrateProbeReport = makeFakeProbeReport()): SubstrateProbe {
  return {
    run: async () => report,
  };
}
