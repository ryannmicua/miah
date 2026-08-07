import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizePlan,
  computeContentHash,
  writeSnapshot,
} from "../src/snapshot";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miah-snapshot-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("snapshot", () => {
  it("canonicalizes line endings and trailing newlines", () => {
    expect(canonicalizePlan("a\nb\n")).toBe("a\nb\n");
    expect(canonicalizePlan("a\r\nb\r\n")).toBe("a\nb\n");
    expect(canonicalizePlan("a\nb")).toBe("a\nb\n");
    expect(canonicalizePlan("a\nb\n\n\n")).toBe("a\nb\n");
  });

  it("computes a SHA-256 content hash matching Node crypto", () => {
    const content = "some canonical content";
    const expected = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    expect(computeContentHash(content)).toBe(expected);
  });

  it("writeSnapshot writes canonicalized content to the injected out-of-tree path and returns its hash", () => {
    const targetDir = makeTempDir();
    const result = writeSnapshot("plan\r\ncontent\r\n", targetDir);
    expect(result.canonicalContent).toBe("plan\ncontent\n");
    expect(fs.readFileSync(result.filePath, "utf8")).toBe("plan\ncontent\n");
    expect(path.dirname(result.filePath)).toBe(targetDir);
    expect(result.hash).toBe(computeContentHash("plan\ncontent\n"));
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same content yields the same hash; different content yields a different hash", () => {
    const planText = "identical plan body\n";
    const a = writeSnapshot(planText, makeTempDir());
    const b = writeSnapshot(planText, makeTempDir());
    expect(a.hash).toBe(b.hash);
    const c = writeSnapshot(`${planText}changed\n`, makeTempDir());
    expect(c.hash).not.toBe(a.hash);
  });

  it("creates the target directory when absent", () => {
    const parent = makeTempDir();
    const nested = path.join(parent, "runs", "run-1");
    const result = writeSnapshot("plan", nested);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it("is injectable for tests (writes to whatever target dir is supplied)", () => {
    const targetDir = makeTempDir();
    const result = writeSnapshot("x", targetDir);
    expect(result.filePath.startsWith(targetDir)).toBe(true);
    // Never touches the cwd or a real run store.
    expect(fs.readdirSync(targetDir)).toEqual(["plan-snapshot.v1.md"]);
  });
});
