/**
 * `miah watchdog install|uninstall|status` commands (U5, R15-R18, KD3).
 *
 * Behind a platform seam -- Windows Task Scheduler in v1.
 * Other platforms return a clear named error (R17).
 *
 * --mode timer  (default) : oneshot tick per invocation via scheduler
 * --mode service          : resident loop process
 */
import * as cp from "child_process";
import * as path from "path";
import { loadConfig, resolveConfigBasePath } from "../config";
import { heartbeatFreshness } from "../watchdog/heartbeat";

export type WatchdogMode = "timer" | "service";

export interface ServiceRegistrar {
  platform: string;
  install(opts: { cadenceS: number; basePath: string; mode: WatchdogMode }): Promise<{ ok: boolean; error?: string }>;
  uninstall(): Promise<{ ok: boolean; error?: string }>;
  state(): Promise<"registered" | "absent" | "unknown">;
}

const TASK_NAME = "MiahWatchdog";

function nodeScriptPath(): string {
  return path.resolve(__dirname, "..", "..", "dist", "watchdog-main.js");
}

export class WindowsTaskSchedulerRegistrar implements ServiceRegistrar {
  platform = "win32";

  async install(opts: { cadenceS: number; basePath: string; mode: WatchdogMode }): Promise<{ ok: boolean; error?: string }> {
    const scriptPath = nodeScriptPath();
    const mo = Math.max(1, Math.ceil(opts.cadenceS / 60));
    // timer mode (default): one-tick per invocation; task scheduler re-launches at cadence.
    // service mode: pass --resident so the process runs as a continuous loop.
    const residentFlag = opts.mode === "service" ? " --resident" : "";
    const trString = `node "${scriptPath}" --basePath "${opts.basePath}"${residentFlag}`;
    try {
      cp.execFileSync("schtasks", ["/Create", "/TN", TASK_NAME, "/TR", trString, "/SC", "MINUTE", "/MO", String(mo), "/F"], { encoding: "utf8", stdio: "pipe" });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async uninstall(): Promise<{ ok: boolean; error?: string }> {
    try {
      cp.execFileSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { encoding: "utf8", stdio: "pipe" });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async state(): Promise<"registered" | "absent" | "unknown"> {
    try {
      cp.execFileSync("schtasks", ["/Query", "/TN", TASK_NAME], { encoding: "utf8", stdio: "pipe" });
      return "registered";
    } catch {
      return "absent";
    }
  }
}

export class NotImplementedRegistrar implements ServiceRegistrar {
  constructor(readonly platform: string) {}
  async install(): Promise<{ ok: boolean; error: string }> {
    return { ok: false, error: `watchdog service registration is not implemented on ${this.platform}` };
  }
  async uninstall(): Promise<{ ok: boolean; error: string }> {
    return { ok: false, error: `watchdog service registration is not implemented on ${this.platform}` };
  }
  async state(): Promise<"unknown"> {
    return "unknown";
  }
}

export function createRegistrar(): ServiceRegistrar {
  if (process.platform === "win32") {
    return new WindowsTaskSchedulerRegistrar();
  }
  return new NotImplementedRegistrar(process.platform);
}

export async function watchdogInstall(opts: { basePath?: string; cadenceS?: number; mode?: WatchdogMode }): Promise<number> {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const config = loadConfig({ configBasePath: basePath });
  const cadenceS = opts.cadenceS ?? config.watchdog.cadence_s;
  const mode: WatchdogMode = opts.mode ?? "timer";
  const registrar = createRegistrar();
  const result = await registrar.install({ cadenceS, basePath, mode });
  if (result.ok) {
    console.log(`miah watchdog: installed (platform=${registrar.platform}, cadence=${cadenceS}s, mode=${mode})`);
    return 0;
  }
  console.error(`miah watchdog: install failed: ${result.error}`);
  return 1;
}

export async function watchdogUninstall(): Promise<number> {
  const registrar = createRegistrar();
  const result = await registrar.uninstall();
  if (result.ok) {
    console.log("miah watchdog: uninstalled");
    return 0;
  }
  console.error(`miah watchdog: uninstall failed: ${result.error}`);
  return 1;
}

export async function watchdogStatus(opts: { basePath?: string }): Promise<number> {
  const basePath = opts.basePath ?? resolveConfigBasePath();
  const config = loadConfig({ configBasePath: basePath });
  const registrar = createRegistrar();
  const state = await registrar.state();
  const freshness = heartbeatFreshness(basePath, config.watchdog.cadence_s);
  console.log("miah watchdog status");
  console.log(`  platform: ${registrar.platform}`);
  console.log(`  registered: ${state}`);
  if (freshness.heartbeat !== null) {
    const ageS = Math.round(freshness.ageMs / 1000);
    console.log(`  heartbeat: ${freshness.heartbeat.timestamp} (${ageS}s ago)`);
    console.log(`  version: ${freshness.heartbeat.version}`);
    console.log(`  cadence: ${freshness.heartbeat.cadence_s}s`);
    console.log(`  healthy: ${freshness.healthy}`);
  } else {
    console.log("  heartbeat: none");
    console.log("  healthy: false");
  }
  return 0;
}
