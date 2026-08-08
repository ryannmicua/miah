/**
 * `miah start` command wiring (U4): admission gate behind the CLI. Uses an
 * injected probe so the command layer is tested without the live daemon; the
 * live fail-closed behavior is covered by the admission suite.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStart } from "../src/commands/start";
import { readJournalFile } from "../src/journal";
import { resolveRunLayout, RunStore } from "../src/run-store";
import { DEFAULT_CONFIG } from "../src/types";
import { makeFakeProbe, makeFakeProbeReport } from "./fixtures/fake-substrate-probe";

const FIXTURES = path.join(__dirname, "fixtures");
const VALID_PLAN = path.join(FIXTURES, "valid-plan.md");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miah-start-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function capture(callback: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  const code = await callback();
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("start command", () => {
  it("returns 0 and prints the run id and run store for a passing admission", async () => {
    const basePath = makeTempDir();
    const { code, stdout } = await capture(() =>
      runStart(VALID_PLAN, { probe: makeFakeProbe(), basePath, config: DEFAULT_CONFIG }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("admission: PASS");
    expect(stdout).toContain("run id: run-");
    expect(stdout).toContain("run store:");
    // The run store was actually created under the base path.
    const runsDir = path.join(basePath, "runs");
    expect(fs.readdirSync(runsDir).length).toBe(1);
  });

  it("returns non-zero and names the missing mechanism when max-duration is absent", async () => {
    const report = makeFakeProbeReport({
      max_duration: { status: "absent", evidence: ["no flag in `paseo run --help`"] },
    });
    const { code, stdout } = await capture(() =>
      runStart(VALID_PLAN, {
        probe: makeFakeProbe(report),
        basePath: makeTempDir(),
        config: DEFAULT_CONFIG,
      }),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("admission: FAIL");
    expect(stdout).toContain("[max-duration-absent]");
    expect(stdout).toContain("max-duration");
  });

  it("returns non-zero when the plan file cannot be read", async () => {
    const missing = path.join(makeTempDir(), "does-not-exist.md");
    const { code, stderr } = await capture(() =>
      runStart(missing, { probe: makeFakeProbe(), basePath: makeTempDir(), config: DEFAULT_CONFIG }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("cannot read plan file");
  });

  it("returns non-zero and names the operator workaround when MCP is unscopable", async () => {
    const report = makeFakeProbeReport({
      mcp_injection: {
        status: "unscopable",
        global_injection_enabled: true,
        per_agent_scoping: false,
        evidence: ["no scoping flag"],
      },
    });
    const { code, stdout } = await capture(() =>
      runStart(VALID_PLAN, {
        probe: makeFakeProbe(report),
        basePath: makeTempDir(),
        config: DEFAULT_CONFIG,
      }),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("[mcp-unscopable]");
    expect(stdout).toContain("injectIntoAgents");
    expect(stdout).toContain("disable");
  });

  it("releases the admission lease so a different holder acquires immediately (start -> run handoff)", async () => {
    const basePath = makeTempDir();
    const startHolder = "miah-start-holder";
    const { code } = await capture(() =>
      runStart(VALID_PLAN, {
        probe: makeFakeProbe(),
        basePath,
        config: DEFAULT_CONFIG,
        holderId: startHolder,
      }),
    );
    expect(code).toBe(0);

    const runsDir = path.join(basePath, "runs");
    const runId = fs.readdirSync(runsDir)[0];
    const { journalPath } = resolveRunLayout(basePath, runId);

    const { events } = readJournalFile(journalPath);
    const releaseEvents = events.filter((event) => event.type === "lease_released");
    expect(releaseEvents).toHaveLength(1);
    expect(releaseEvents[0].holder_id).toBe(startHolder);

    const store = new RunStore({ basePath, runId, config: DEFAULT_CONFIG, holderId: startHolder });
    const acquired = store.lease.acquire("miah-run-holder");
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      expect(acquired.reason).toBe("acquired");
    }
  });
});
