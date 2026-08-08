/**
 * U4 adapter tests. These run against a fake CLI executor (injected into the
 * adapter) so no real agent is ever dispatched — the fake responses are the
 * verbatim shapes captured from the live `paseo` CLI v0.3.0-beta.2 during U4
 * probing (run/inspect JSON, the ANSI-colored error shape, `agent stop`
 * text). The one sanctioned live dispatch (the immutability probe) lives in
 * the substrate-probe tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PaseoCliAdapter,
  PaseoCliError,
  PaseoCliUnavailableError,
  extractJsonObject,
  parseCliError,
  stripAnsi,
  type CliExecutor,
  type PaseoHandle,
} from "../src/adapter/paseo";

/** Verbatin run output captured from the live CLI (success path). */
const LIVE_RUN_OUTPUT = [
  "\u001b[31;1mCreated workspace wks_4d3b3e1270124b2c - massive-wasp (massive-wasp)\u001b[0m",
  "Tip: pass --workspace <id> (or set PASEO_WORKSPACE_ID) to run in an existing workspace.",
  "{",
  '  "agentId": "34b3e6c5-e33c-4526-b460-1f5496fd0a54",',
  '  "status": "running",',
  '  "provider": "opencode",',
  '  "cwd": "C:\\\\Users\\\\rmicua\\\\.paseo\\\\worktrees\\\\03nz0vwd\\\\massive-wasp",',
  '  "title": "miah-u4-probe"',
  "}",
].join("\n");

/** Verbatim inspect output captured from the live CLI. */
const LIVE_INSPECT_OUTPUT = `{
  "Id": "34b3e6c5-e33c-4526-b460-1f5496fd0a54",
  "Name": "miah-u4-probe",
  "Provider": "opencode",
  "Model": "opencode-go/deepseek-v4-flash",
  "Thinking": "auto",
  "Status": "idle",
  "Archived": false,
  "ArchivedAt": null,
  "Mode": "default",
  "Cwd": "C:\\\\Users\\\\rmicua\\\\.paseo\\\\worktrees\\\\03nz0vwd\\\\massive-wasp",
  "CreatedAt": "2026-08-07T02:34:59.965Z",
  "UpdatedAt": "2026-08-07T02:35:11.987Z",
  "LastUsage": {
    "InputTokens": 28745,
    "OutputTokens": 5,
    "CachedTokens": 1920,
    "CostUsd": 0.004034996
  },
  "Capabilities": {
    "Streaming": true,
    "Persistence": true,
    "DynamicModes": true,
    "McpServers": true
  },
  "AvailableModes": [
    { "id": "build", "label": "Build" }
  ],
  "PendingPermissions": [],
  "Worktree": null,
  "ParentAgentId": "b1d97e1e-546f-47ff-84b4-21206319fe0d"
}`;

/** Verbatim error shape captured from the live CLI (ANSI-colored). */
const LIVE_ERROR_OUTPUT =
  "\u001b[31;1m{\u001b[0m\n\u001b[31;1m  \"error\": {\u001b[0m\n" +
  '\u001b[31;1m    "code": "MISSING_PROVIDER",\u001b[0m\n' +
  '\u001b[31;1m    "message": "Provider is required",\u001b[0m\n' +
  '\u001b[31;1m    "details": "Pass --provider <provider> or --provider <provider>/<model>."\u001b[0m\n' +
  "\u001b[31;1m  }\u001b[0m\n" +
  "\u001b[31;1m}\u001b[0m";

interface FakeResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnFailure?: boolean;
}

/** A fake CliExecutor that records the args it is called with. */
function fakeExecutor(handler: (args: string[]) => FakeResponse): { exec: CliExecutor; calls: string[][] } {
  const calls: string[][] = [];
  const exec: CliExecutor = async (args) => {
    calls.push([...args]);
    const response = handler(args);
    if (response.spawnFailure) {
      throw new PaseoCliUnavailableError("paseo CLI failed to spawn: spawn ENOENT");
    }
    const stdout = response.stdout ?? "";
    const stderr = response.stderr ?? "";
    return {
      code: response.exitCode ?? 0,
      stdout,
      stderr,
      text: `${stdout}${stderr}`,
    };
  };
  return { exec, calls };
}

describe("adapter defensive JSON parsing", () => {
  it("parses plain JSON", () => {
    expect(extractJsonObject('{"agentId":"a1","status":"running"}')).toEqual({
      agentId: "a1",
      status: "running",
    });
  });

  it("strips ANSI color codes before parsing", () => {
    const text = "\u001b[31;1m{\"error\":{\"code\":\"X\"}}\u001b[0m";
    expect(extractJsonObject(text)).toEqual({ error: { code: "X" } });
  });

  it("skips human lines before the JSON (live run output)", () => {
    expect(extractJsonObject(LIVE_RUN_OUTPUT)).toMatchObject({ agentId: "34b3e6c5-e33c-4526-b460-1f5496fd0a54" });
  });

  it("finds JSON whose string values contain braces", () => {
    const text = 'log line\n{"prompt":"use { these } braces","agentId":"a1"}';
    expect(extractJsonObject(text)).toEqual({ prompt: "use { these } braces", agentId: "a1" });
  });

  it("returns null when there is no JSON object", () => {
    expect(extractJsonObject("INTERRUPTED")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject('["not","an","object"]')).toBeNull();
  });

  it("stripAnsi removes color sequences", () => {
    expect(stripAnsi("\u001b[31;1mhello\u001b[0m")).toBe("hello");
  });
});

describe("adapter parseCliError", () => {
  it("extracts code and message from the live error shape", () => {
    const json = extractJsonObject(LIVE_ERROR_OUTPUT);
    expect(parseCliError(json)).toEqual({ code: "MISSING_PROVIDER", message: "Provider is required" });
  });

  it("returns null for a non-error object", () => {
    expect(parseCliError({ agentId: "a1" })).toBeNull();
  });
});

describe("adapter launch", () => {
  it("runs `paseo run --background --json` with the U4 dispatch contract and returns the handle", async () => {
    const { exec, calls } = fakeExecutor((args) => {
      if (args[0] === "run") {
        return { stdout: LIVE_RUN_OUTPUT };
      }
      return { stdout: "" };
    });
    const adapter = new PaseoCliAdapter(exec);

    const handle = await adapter.launch("Build the hello module", {
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      title: "builder-U1",
    });

    expect(calls[0]).toEqual([
      "run",
      "--background",
      "--json",
      "--provider",
      "opencode",
      "--model",
      "opencode-go/deepseek-v4-flash",
      "--title",
      "builder-U1",
      "--new-workspace",
      "worktree",
      "--worktree-mode",
      "branch-off",
      "Build the hello module",
    ]);
    expect(handle.agentId).toBe("34b3e6c5-e33c-4526-b460-1f5496fd0a54");
    expect(handle.cwd).toContain("massive-wasp");
    expect(handle.workspaceId).toBe("wks_4d3b3e1270124b2c");
  });

  it("honors explicit workspace / worktree-mode / env / cwd options", async () => {
    const { exec, calls } = fakeExecutor(() => ({ stdout: '{"agentId":"a9","status":"running"}' }));
    const adapter = new PaseoCliAdapter(exec);
    await adapter.launch("task", {
      provider: "opencode",
      workspace: "local",
      worktreeMode: "checkout-branch",
      env: { KEY: "value" },
      cwd: "C:\\repo",
      mode: "plan",
    });
    const args = calls[0];
    expect(args).toContain("--new-workspace");
    expect(args[args.indexOf("--new-workspace") + 1]).toBe("local");
    expect(args[args.indexOf("--worktree-mode") + 1]).toBe("checkout-branch");
    expect(args[args.indexOf("--env") + 1]).toBe("KEY=value");
    expect(args[args.indexOf("--cwd") + 1]).toBe("C:\\repo");
    expect(args[args.indexOf("--mode") + 1]).toBe("plan");
  });

  it("throws PaseoCliError with the CLI code/message on an error object", async () => {
    const { exec } = fakeExecutor(() => ({ stdout: LIVE_ERROR_OUTPUT, exitCode: 1 }));
    const adapter = new PaseoCliAdapter(exec);
    await expect(adapter.launch("task", { provider: "opencode" })).rejects.toMatchObject({
      name: "PaseoCliError",
      exitCode: 1,
    });
    await expect(adapter.launch("task", { provider: "opencode" })).rejects.toThrow(/MISSING_PROVIDER/);
  });

  it("throws PaseoCliError when the output has no machine-readable JSON", async () => {
    const { exec } = fakeExecutor(() => ({ stdout: "Something went sideways" }));
    const adapter = new PaseoCliAdapter(exec);
    await expect(adapter.launch("task", { provider: "opencode" })).rejects.toThrow(/no machine-readable JSON/);
  });

  it("throws PaseoCliError when the JSON is missing agentId", async () => {
    const { exec } = fakeExecutor(() => ({ stdout: '{"status":"running"}' }));
    const adapter = new PaseoCliAdapter(exec);
    await expect(adapter.launch("task", { provider: "opencode" })).rejects.toThrow(/missing agentId/);
  });

  it("throws PaseoCliUnavailableError when the CLI cannot be spawned", async () => {
    const { exec } = fakeExecutor(() => ({ spawnFailure: true }));
    const adapter = new PaseoCliAdapter(exec);
    await expect(adapter.launch("task", { provider: "opencode" })).rejects.toBeInstanceOf(
      PaseoCliUnavailableError,
    );
  });
});

describe("adapter status", () => {
  it("queries `paseo inspect --json <id>` and returns the lifecycle", async () => {
    const handle: PaseoHandle = { agentId: "agent-1", cwd: null, workspaceId: null };
    const { exec, calls } = fakeExecutor((args) => {
      if (args[0] === "inspect") {
        return { stdout: LIVE_INSPECT_OUTPUT };
      }
      return { stdout: "" };
    });
    const adapter = new PaseoCliAdapter(exec);

    expect(await adapter.status(handle)).toBe("idle");
    expect(calls[0]).toEqual(["inspect", "--json", "agent-1"]);
  });
});

describe("adapter inspect", () => {
  it("maps the PascalCase inspect output onto the contract", async () => {
    const handle: PaseoHandle = { agentId: "agent-1", cwd: null, workspaceId: null };
    const { exec } = fakeExecutor(() => ({ stdout: LIVE_INSPECT_OUTPUT }));
    const adapter = new PaseoCliAdapter(exec);

    const result = await adapter.inspect(handle);
    expect(result.agentId).toBe("34b3e6c5-e33c-4526-b460-1f5496fd0a54");
    expect(result.lifecycle).toBe("idle");
    expect(result.provider).toBe("opencode");
    expect(result.model).toBe("opencode-go/deepseek-v4-flash");
    expect(result.mode).toBe("default");
    expect(result.cwd).toContain("massive-wasp");
    expect(result.usage).toEqual({
      inputTokens: 28745,
      outputTokens: 5,
      cachedTokens: 1920,
      costUsd: 0.004034996,
    });
    expect(result.capabilities).toMatchObject({ McpServers: true });
  });

  it("tolerates missing optional fields (sparse inspect JSON)", async () => {
    const handle: PaseoHandle = { agentId: "agent-1", cwd: null, workspaceId: null };
    const { exec } = fakeExecutor(() => ({
      stdout: '{"Id":"agent-1","Status":"running"}',
    }));
    const adapter = new PaseoCliAdapter(exec);
    const result = await adapter.inspect(handle);
    expect(result.lifecycle).toBe("running");
    expect(result.provider).toBeNull();
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
    });
    expect(result.capabilities).toEqual({});
  });
});

describe("adapter stop / cancel", () => {
  it("stop calls `paseo agent stop <id>` and tolerates non-JSON output", async () => {
    const handle: PaseoHandle = { agentId: "agent-1", cwd: null, workspaceId: null };
    const { exec, calls } = fakeExecutor(() => ({ stdout: "INTERRUPTED\n" }));
    const adapter = new PaseoCliAdapter(exec);

    await adapter.stop(handle);
    expect(calls[0]).toEqual(["agent", "stop", "agent-1"]);
  });

  it("cancel uses the same `paseo agent stop <id>` primitive", async () => {
    const handle: PaseoHandle = { agentId: "agent-1", cwd: null, workspaceId: null };
    const { exec, calls } = fakeExecutor(() => ({ stdout: "INTERRUPTED\n" }));
    const adapter = new PaseoCliAdapter(exec);

    await adapter.cancel(handle);
    expect(calls[0]).toEqual(["agent", "stop", "agent-1"]);
  });

  it("stop throws PaseoCliError when the CLI returns an error object", async () => {
    const handle: PaseoHandle = { agentId: "agent-1", cwd: null, workspaceId: null };
    const { exec } = fakeExecutor(() => ({
      stdout: '{"error":{"code":"AGENT_NOT_FOUND","message":"no such agent"}}',
      exitCode: 1,
    }));
    const adapter = new PaseoCliAdapter(exec);
    await expect(adapter.stop(handle)).rejects.toThrow(/AGENT_NOT_FOUND/);
  });

  it("stop returns within the timeout and does not throw when the CLI never acknowledges (best-effort)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handle: PaseoHandle = { agentId: "agent-1", cwd: null, workspaceId: null };
      // A stop exec that never settles — the slow-daemon acknowledgment case
      // that hung the driver (adapter.stop blocked forever, so stopAndRelease /
      // refusePastDeadline never reached the Stopping transition).
      const neverAcknowledges: CliExecutor = () => new Promise(() => {});
      const adapter = new PaseoCliAdapter(neverAcknowledges, 50);

      const started = Date.now();
      await expect(adapter.stop(handle)).resolves.toBeUndefined();
      const elapsed = Date.now() - started;
      // Bounded by the injected 50ms stop timeout — never the vitest default
      // per-test timeout (which would indicate the unbounded hang returned).
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("stop still throws when the CLI exec fails (a genuine error is not swallowed as a timeout)", async () => {
    const handle: PaseoHandle = { agentId: "agent-1", cwd: null, workspaceId: null };
    const failsToSpawn: CliExecutor = async () => {
      throw new PaseoCliUnavailableError("paseo CLI failed to spawn: spawn ENOENT");
    };
    const adapter = new PaseoCliAdapter(failsToSpawn, 50);
    await expect(adapter.stop(handle)).rejects.toBeInstanceOf(PaseoCliUnavailableError);
  });
});

