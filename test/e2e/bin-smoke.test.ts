/**
 * L3 — real-binary smoke test.
 *
 * The in-process command tests drive the command modules directly; only this
 * test runs the actual built `dist/index.js` bin. It would catch packaging
 * regressions (missing files, bin path, shebang, dependency hoisting) that no
 * in-process test can. The bin is rebuilt first with the same `tsc` command
 * `npm run build` uses. No daemon, no adapter, no paseoCliAvailable gate.
 */
import * as cp from "child_process";
import * as path from "path";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const BIN = path.join(repoRoot, "dist", "index.js");
const BAD_PLAN = path.join(repoRoot, "test", "fixtures", "test-plan-bad.md");

/** Rebuild the bin exactly as `npm run build` does (tsc over src/ -> dist/). */
function buildBin(): void {
  const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const result = cp.spawnSync(process.execPath, [tsc], {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tsc build failed (exit ${String(result.status)}): ${result.stderr}`);
  }
}

describe("e2e real-binary smoke (L3)", () => {
  beforeAll(() => {
    buildBin();
  }, 180_000);

  it("node dist/index.js --help exits 0 and prints usage", () => {
    const result = cp.spawnSync(process.execPath, [BIN, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    const usage = result.stdout.toLowerCase();
    expect(usage).toContain("preflight");
    expect(usage).toContain("start");
    expect(usage).toContain("resolve");
    expect(usage).toContain("approve");
  });

  it("node dist/index.js preflight <broken plan> exits non-zero", () => {
    const result = cp.spawnSync(process.execPath, [BIN, "preflight", BAD_PLAN], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    // test-plan-bad.md deliberately violates preflight in all three classes
    // (missing tier, missing creates, dependency cycle, unresolved input), so
    // the real bin must fail closed with the preflight verdict.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("preflight: FAIL");
    expect(result.stdout).toContain("structural failures");
  });
});
