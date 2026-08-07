import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.join(__dirname, "..", "..", "src");

interface BannedPrimitive {
  label: string;
  pattern: RegExp;
}

/**
 * POSIX-only primitives that must never be load-bearing in `src/**` (R84,
 * KTD2). Windows 10 + Git Bash is the primary environment; anything listed
 * here would break there.
 */
const BANNED_PRIMITIVES: BannedPrimitive[] = [
  { label: "flock", pattern: /flock/ },
  { label: "mkfifo", pattern: /mkfifo/ },
  { label: "SIGTERM (Unix signal)", pattern: /SIGTERM/ },
  { label: "SIGKILL (Unix signal)", pattern: /SIGKILL/ },
  { label: "kill( with a PID", pattern: /kill\s*\(/ },
];

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(fullPath, out);
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

describe("portability", () => {
  const sourceFiles = listSourceFiles(SRC_DIR);

  it("scans a non-empty src/ tree", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("finds no load-bearing POSIX-only primitives in src/**", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, "utf8");
      for (const { label, pattern } of BANNED_PRIMITIVES) {
        if (pattern.test(content)) {
          offenders.push(`${path.relative(SRC_DIR, file)}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
