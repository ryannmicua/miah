/**
 * Test runner wrapper. Maps the jest-style `--grep <pattern>` flag used by the
 * plan's verification gates onto vitest's `--testNamePattern` and forwards any
 * other args unchanged. Plain `npm test` (no args) runs the full suite.
 *
 * Note: this file is intentionally not named `*.test.*` so vitest does not
 * collect it as a test file.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const vitestArgs = ["run"];

const grepIndex = args.indexOf("--grep");
if (grepIndex >= 0) {
  const pattern = args[grepIndex + 1];
  if (pattern !== undefined) {
    vitestArgs.push("--testNamePattern", pattern);
  }
  args.splice(grepIndex, 2);
}
vitestArgs.push(...args);

const here = path.dirname(fileURLToPath(import.meta.url));
const vitestEntry = path.join(here, "..", "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestEntry, ...vitestArgs], {
  stdio: "inherit",
});

process.exit(result.status === null ? 1 : result.status);
