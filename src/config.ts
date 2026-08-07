import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config, DEFAULT_CONFIG } from "./types";

export const CONFIG_FILENAME = "config.json";

/** Default miah state directory name under the user's home. */
export const MIAH_HOME_DIRNAME = ".miah";

/**
 * Environment variable that overrides where miah looks for its config (and
 * writes durable state). Tests set this to a temp dir so they never touch the
 * real user home.
 */
export const CONFIG_HOME_ENV_VAR = "MIAH_CONFIG_HOME";

export interface ConfigOptions {
  /**
   * Explicit config base path. Takes precedence over the environment variable.
   */
  configBasePath?: string;
}

/**
 * Resolve the config base directory. Priority: explicit parameter, then
 * `MIAH_CONFIG_HOME`, then `~/.miah`.
 */
export function resolveConfigBasePath(options: ConfigOptions = {}): string {
  if (options.configBasePath) {
    return options.configBasePath;
  }
  const envBase = process.env[CONFIG_HOME_ENV_VAR];
  if (envBase) {
    return envBase;
  }
  return path.join(os.homedir(), MIAH_HOME_DIRNAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge `override` onto `base`. Plain objects are merged recursively;
 * any other value in `override` (including undefined) replaces the base value.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    if (overrideValue === undefined) {
      continue;
    }
    result[key] = deepMerge(base[key], overrideValue);
  }
  return result;
}

/**
 * Read `~/.miah/config.json` (or the injected base path), apply overrides on
 * top of the defaults, and return the effective config. If the file is absent,
 * create it with the defaults and return the defaults.
 */
export function loadConfig(options: ConfigOptions = {}): Config {
  const basePath = resolveConfigBasePath(options);
  const configPath = path.join(basePath, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(basePath, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), raw) as Config;
}
