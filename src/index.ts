#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { registerCommands } from "./commands";

/** Read the version from the installed package.json (sibling of dist/). */
function readVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to the placeholder when package.json is not readable.
  }
  return "0.0.0";
}

/** Build the miah program with the full command surface registered. */
export function createProgram(): Command {
  const program = new Command();
  program
    .name("miah")
    .description("Resumable plan supervisor CLI")
    .version(readVersion(), "-v, --version", "output the version number");
  registerCommands(program);
  return program;
}

function main(): void {
  createProgram().parse(process.argv);
}

if (require.main === module) {
  main();
}
