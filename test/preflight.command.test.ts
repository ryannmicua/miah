import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWorkspacePaths, runPreflight } from "../src/commands/preflight";

const FIXTURES = path.join(__dirname, "fixtures");
const VALID_PLAN = path.join(FIXTURES, "valid-plan.md");
const BAD_PLAN = path.join(FIXTURES, "bad-plan.md");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miah-cmd-test-"));
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

function capture(callback: () => number): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => stdout.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args.join(" ")));
  const code = callback();
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("preflight command", () => {
  it("returns exit 0 and prints a green verdict for a valid plan", () => {
    const { code, stdout } = capture(() => runPreflight(VALID_PLAN, FIXTURES));
    expect(code).toBe(0);
    expect(stdout).toContain("preflight: PASS");
    expect(stdout).toContain("Valid Miah Test Plan");
    expect(stdout).toContain("no structural, referential, or verifiability findings");
  });

  it("returns non-zero and prints structured failures by class for a bad plan", () => {
    const { code, stdout } = capture(() => runPreflight(BAD_PLAN, FIXTURES));
    expect(code).toBe(1);
    expect(stdout).toContain("preflight: FAIL");
    expect(stdout).toContain("structural failures");
    expect(stdout).toContain("referential failures");
    expect(stdout).toContain("verifiability failures");
    // Failures name the offending unit IDs.
    expect(stdout).toContain("[U2]");
    expect(stdout).toContain("[U4]");
    expect(stdout).toContain("[U5]");
    expect(stdout).toContain("[U3]");
  });

  it("returns non-zero when the plan file cannot be read", () => {
    const missing = path.join(makeTempDir(), "does-not-exist.md");
    const { code, stderr } = capture(() => runPreflight(missing, FIXTURES));
    expect(code).toBe(1);
    expect(stderr).toContain("cannot read plan file");
  });

  it("collects workspace paths relative to the root, skipping heavy dirs", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "a");
    fs.writeFileSync(path.join(root, "node_modules", "big.ts"), "big");
    const paths = collectWorkspacePaths(root);
    expect(paths).toContain("src");
    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("node_modules/big.ts");
  });

  it("resolves an input against the workspace path set passed to the command", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "existing.ts"), "x");
    // A plan whose only unit consumes src/existing.ts from the workspace.
    const planPath = path.join(root, "plan.md");
    fs.writeFileSync(
      planPath,
      `---
title: Workspace Input Plan
artifact_contract: ce-unified-plan/v1
execution: code
---

# Workspace Input Plan

## Implementation Units

### U1. Consumer

- **Goal:** Consume an existing file.
- **creates:** \`src/out.ts\`
- **inputs:** \`src/existing.ts\`
- **depends-on:** none
- **Acceptance:**
  - out exists — \`tier: deterministic\`
`,
      "utf8",
    );
    const { code, stdout } = capture(() => runPreflight(planPath, root));
    expect(code).toBe(0);
    expect(stdout).toContain("preflight: PASS");
  });
});
