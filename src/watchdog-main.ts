#!/usr/bin/env node
/**
 * `miah-watchdog` bin entry (U4, KTD11).
 *
 * Default: one-tick (scan, act, write heartbeat, exit).
 * Pass --resident for a continuous loop. The cadence is read from the
 * config file.
 */
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { loadConfig, resolveConfigBasePath } from "./config";
import { tick, runLoop } from "./watchdog";
import { PaseoCliAdapter, createDefaultExecutor } from "./adapter/paseo";

function readVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

function main(): void {
  const program = new Command();
  program
    .name("miah-watchdog")
    .description("Miah watchdog daemon -- sole reaper of per-dispatch deadlines")
    .version(readVersion(), "-v, --version")
    .option("--basePath <path>", "Miah config base path (or set MIAH_CONFIG_HOME)")
    .option("--once", "Run one tick and exit (default)")
    .option("--resident", "Run as a resident loop (overrides default one-tick)")
    .action(async (opts) => {
      const basePath = opts.basePath ?? resolveConfigBasePath();
      const config = loadConfig({ configBasePath: basePath });
      const version = readVersion();
      const adapter = new PaseoCliAdapter(createDefaultExecutor());

      if (opts.resident) {
        // --resident: run as a continuous loop.
        await runLoop(adapter, { basePath, config, version });
      } else {
        // Default (one-tick): scan, act, write heartbeat, exit.
        const report = await tick(adapter, { basePath, config, version });
        console.log(JSON.stringify(report, null, 2));
        process.exit(report.errors.length > 0 ? 1 : 0);
      }
    });

  program.parse(process.argv);
}

if (require.main === module) {
  main();
}
