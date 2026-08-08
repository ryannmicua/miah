/**
 * A scripted PaseoAdapter for U5 dispatch tests (not a vitest test file).
 *
 * Records every call and replays canned responses, so tests exercise the
 * dispatch pipeline against an in-memory adapter without ever touching the
 * live `paseo` CLI.
 */
import type { PaseoAdapter, PaseoHandle, PaseoInspectResult, PaseoLaunchOptions } from "../../src/adapter/paseo";

export class ScriptedAdapter implements PaseoAdapter {
  launchCalls: Array<{ prompt: string; opts: PaseoLaunchOptions }> = [];
  stopCalls: PaseoHandle[] = [];
  launchResult: PaseoHandle | null = null;
  launchError: Error | null = null;
  statusFor: ((handle: PaseoHandle) => string) | null = null;
  inspectFor: ((handle: PaseoHandle) => PaseoInspectResult) | null = null;
  onLaunch: ((prompt: string, opts: PaseoLaunchOptions) => void) | null = null;

  async launch(prompt: string, opts: PaseoLaunchOptions): Promise<PaseoHandle> {
    this.launchCalls.push({ prompt, opts });
    if (this.onLaunch !== null) {
      this.onLaunch(prompt, opts);
    }
    if (this.launchError !== null) {
      throw this.launchError;
    }
    if (this.launchResult === null) {
      throw new Error("scripted adapter: no launchResult configured");
    }
    return this.launchResult;
  }

  async status(handle: PaseoHandle): Promise<string> {
    if (this.statusFor !== null) {
      return this.statusFor(handle);
    }
    return "running";
  }

  async inspect(handle: PaseoHandle): Promise<PaseoInspectResult> {
    if (this.inspectFor !== null) {
      return this.inspectFor(handle);
    }
    return {
      agentId: handle.agentId,
      lifecycle: "running",
      provider: null,
      model: null,
      mode: null,
      cwd: null,
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null },
      capabilities: {},
    };
  }

  async stop(handle: PaseoHandle): Promise<void> {
    this.stopCalls.push(handle);
  }

  async cancel(handle: PaseoHandle): Promise<void> {
    this.stopCalls.push(handle);
  }
}
