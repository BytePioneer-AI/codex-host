import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { DeepSeekHostClient } from "../src/host-client.js";
import {
  DeepSeekHostConnection,
  NodeDeepSeekCommandClient,
  NodeDeepSeekHostClient,
  deepSeekProcessInvocation,
  deepSeekWebArguments,
  dshWebHelpSupportsNoOpen,
  resolveDeepSeekCommand,
  type DeepSeekHostConnectionDependencies,
} from "../src/host-client.js";

function success<T>(value: T) {
  return { rpcId: "response" as never, result: { ok: true as const, value } };
}

function fakeClient(describe: () => Promise<unknown>): DeepSeekHostClient {
  return {
    host: { describe },
    events: {
      mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) =>
        (async function* () {
          onOpen?.();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        })(),
    },
  } as unknown as DeepSeekHostClient;
}

function childProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      Object.assign(child, { signalCode: signal });
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    }),
  });
  return child;
}

describe("DeepSeek local Host connection", () => {
  it("calls the Typert Remote command wire and validates its catalog", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: input.href, body });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "server-response",
              rpcId: body.rpcId,
              result: {
                ok: true,
                value: [{ name: "compact", description: "Compact older conversation history" }],
              },
            }),
          ),
        );
      }),
    );
    try {
      const client = new NodeDeepSeekCommandClient("http://127.0.0.1:43123");

      await expect(client.list("session-1" as never)).resolves.toEqual({
        ok: true,
        value: [{ name: "compact", description: "Compact older conversation history" }],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://127.0.0.1:43123/api/commands/list");
      expect(requests[0]?.body).toMatchObject({
        type: "client-request",
        method: "commands/list",
        payload: { args: { agentId: "session-1" } },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts host.describe from DSH 0.1.0 that omits home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "server-response",
              rpcId: body.rpcId,
              result: {
                ok: true,
                value: {
                  version: "0.0.1",
                  cwd: "/workspace",
                  provider: "deepseek-official",
                  model: "deepseek-v4-flash",
                  attachedSessions: 0,
                  canOpenPath: true,
                },
              },
            }),
          ),
        );
      }),
    );
    try {
      const client = new NodeDeepSeekHostClient("http://127.0.0.1:43123");
      const described = await client.host.describe({});
      expect(described.result).toMatchObject({
        ok: true,
        value: {
          version: "0.0.1",
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
          home: expect.any(String),
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries commands/execute with the newer empty images field only when requested", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        payloads.push(body.payload as Record<string, unknown>);
        const first = payloads.length === 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "server-response",
              rpcId: body.rpcId,
              result: first
                ? {
                    ok: false,
                    error: {
                      code: "internal",
                      message:
                        'typert gateway: commands/execute: args fields do not match the descriptor: missing "images"',
                      details: {},
                    },
                  }
                : {
                    ok: true,
                    value: {
                      commandId: "command-1",
                      result: { kind: "success", text: "compacted" },
                    },
                  },
            }),
          ),
        );
      }),
    );
    try {
      const client = new NodeDeepSeekCommandClient("http://127.0.0.1:43123");

      await expect(client.execute("session-1" as never, "/compact")).resolves.toEqual({
        ok: true,
        value: { commandId: "command-1", result: { kind: "success", text: "compacted" } },
      });
      expect(payloads).toEqual([
        { args: { agentId: "session-1", line: "/compact" } },
        { args: { agentId: "session-1", line: "/compact", images: [] } },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("executes the latest DSH Remote Command shape with an explicit empty image list", async () => {
    const requests: Array<{ payload: { args: Record<string, unknown> }; rpcId: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const envelope = JSON.parse(Buffer.concat(chunks).toString()) as {
          payload: { args: Record<string, unknown> };
          rpcId: string;
        };
        requests.push(envelope);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            type: "server-response",
            rpcId: envelope.rpcId,
            result:
              requests.length === 1
                ? {
                    ok: false,
                    error: {
                      code: "internal",
                      message:
                        'typert gateway: commands/execute: args fields do not match the descriptor: missing "images"',
                      details: {},
                    },
                  }
                : {
                    ok: true,
                    value: {
                      commandId: "command-1",
                      result: { kind: "success", text: "preset danger-full-access" },
                    },
                  },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const client = new NodeDeepSeekHostClient(`http://127.0.0.1:${address.port}`);

    await expect(
      client.commands.execute("session-1" as never, "/permission danger-full-access"),
    ).resolves.toEqual({
      ok: true,
      value: {
        commandId: "command-1",
        result: { kind: "success", text: "preset danger-full-access" },
      },
    });
    expect(requests.map((request) => request.payload.args)).toEqual([
      { agentId: "session-1", line: "/permission danger-full-access" },
      { agentId: "session-1", line: "/permission danger-full-access", images: [] },
    ]);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("connects to an existing compatible Host without spawning or stopping it", async () => {
    const spawn = vi.fn();
    const dependencies: DeepSeekHostConnectionDependencies = {
      createClient: () =>
        fakeClient(() =>
          Promise.resolve(
            success({
              version: "0.0.1",
              cwd: "/workspace",
              provider: "deepseek-official",
              model: "deepseek-v4-flash",
              attachedSessions: 0,
              canOpenPath: false,
            }),
          ),
        ),
      spawn,
      sleep: () => Promise.resolve(),
    };
    const connection = new DeepSeekHostConnection({}, dependencies);

    await connection.connect();
    expect(spawn).not.toHaveBeenCalled();
    await connection.close();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("retries after a failed connection attempt", async () => {
    let ready = false;
    const dependencies: DeepSeekHostConnectionDependencies = {
      createClient: () =>
        fakeClient(() =>
          ready
            ? Promise.resolve(
                success({
                  version: "0.0.1",
                  cwd: "/workspace",
                  provider: "deepseek-official",
                  model: "deepseek-v4-flash",
                  attachedSessions: 0,
                  canOpenPath: false,
                }),
              )
            : Promise.reject(new TypeError("fetch failed")),
        ),
      spawn: vi.fn(),
      sleep: () => Promise.resolve(),
    };
    const connection = new DeepSeekHostConnection(
      {
        command: "/missing/dsh",
        endpoint: "http://127.0.0.1:43123",
      },
      dependencies,
    );

    await expect(connection.connect()).rejects.toMatchObject({ code: "notInstalled" });
    ready = true;
    await expect(connection.connect()).resolves.toBeUndefined();
    await connection.close();
  });

  it("starts a configured local dsh Web profile and stops only that managed process", async () => {
    const executableDirectory = mkdtempSync(path.join(os.tmpdir(), "codexhost-dsh-command-"));
    const executable = path.join(executableDirectory, "dsh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    let ready = false;
    const child = childProcess();
    const spawn = vi.fn(() => {
      ready = true;
      return child;
    });
    const dependencies: DeepSeekHostConnectionDependencies = {
      createClient: () =>
        fakeClient(() =>
          ready
            ? Promise.resolve(
                success({
                  version: "0.0.1",
                  cwd: "/workspace",
                  provider: "deepseek-official",
                  model: "deepseek-v4-flash",
                  attachedSessions: 0,
                  canOpenPath: false,
                }),
              )
            : Promise.reject(new TypeError("fetch failed")),
        ),
      spawn,
      sleep: () => Promise.resolve(),
      readWebHelp: () => "",
    };
    const connection = new DeepSeekHostConnection(
      { command: executable, endpoint: "http://127.0.0.1:43123" },
      dependencies,
    );

    await connection.connect();
    const expectedInvocation = deepSeekProcessInvocation(
      executable,
      deepSeekWebArguments(new URL("http://127.0.0.1:43123")),
      process.env,
    );
    expect(spawn).toHaveBeenCalledWith(expectedInvocation.command, expectedInvocation.arguments, {
      env: process.env,
      stdio: "pipe",
      windowsVerbatimArguments: expectedInvocation.windowsVerbatimArguments,
    });
    await connection.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("passes --no-open only when this dsh web CLI still advertises it", async () => {
    const executableDirectory = mkdtempSync(path.join(os.tmpdir(), "codexhost-dsh-no-open-"));
    const executable = path.join(executableDirectory, "dsh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    let ready = false;
    const child = childProcess();
    const spawn = vi.fn(() => {
      ready = true;
      return child;
    });
    const dependencies: DeepSeekHostConnectionDependencies = {
      createClient: () =>
        fakeClient(() =>
          ready
            ? Promise.resolve(
                success({
                  version: "0.0.1",
                  cwd: "/workspace",
                  provider: "deepseek-official",
                  model: "deepseek-v4-flash",
                  attachedSessions: 0,
                  canOpenPath: false,
                }),
              )
            : Promise.reject(new TypeError("fetch failed")),
        ),
      spawn,
      sleep: () => Promise.resolve(),
      readWebHelp: () => "Options:\n  --no-open\n  --host <host>\n  --port <port>\n",
    };
    const connection = new DeepSeekHostConnection(
      { command: executable, endpoint: "http://127.0.0.1:43123" },
      dependencies,
    );

    await connection.connect();
    const expectedInvocation = deepSeekProcessInvocation(
      executable,
      deepSeekWebArguments(new URL("http://127.0.0.1:43123"), { noOpen: true }),
      process.env,
    );
    expect(spawn).toHaveBeenCalledWith(expectedInvocation.command, expectedInvocation.arguments, {
      env: process.env,
      stdio: "pipe",
      windowsVerbatimArguments: expectedInvocation.windowsVerbatimArguments,
    });
    await connection.close();
  });

  it("classifies an npx DSH package startup exit as not installed", async () => {
    const executableDirectory = mkdtempSync(path.join(os.tmpdir(), "codexhost-npx-command-"));
    const executable = path.join(
      executableDirectory,
      process.platform === "win32" ? "npx.cmd" : "npx",
    );
    writeFileSync(
      executable,
      process.platform === "win32" ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n",
    );
    chmodSync(executable, 0o755);
    const child = childProcess();
    Object.assign(child, { exitCode: 1 });
    const spawn = vi.fn(() => child);
    const environment = { PATH: executableDirectory };
    const dependencies: DeepSeekHostConnectionDependencies = {
      createClient: () => fakeClient(() => Promise.reject(new TypeError("fetch failed"))),
      spawn,
      sleep: () => Promise.resolve(),
      readWebHelp: () => "",
    };
    const connection = new DeepSeekHostConnection(
      { endpoint: "http://127.0.0.1:43123", environment },
      dependencies,
    );

    await expect(connection.connect()).rejects.toMatchObject({ code: "notInstalled" });
    const expectedInvocation = deepSeekProcessInvocation(
      executable,
      [
        "--offline",
        "--no-install",
        "@deepseek-ai/dsh",
        ...deepSeekWebArguments(new URL("http://127.0.0.1:43123")),
      ],
      environment,
    );
    expect(spawn).toHaveBeenCalledWith(expectedInvocation.command, expectedInvocation.arguments, {
      env: environment,
      stdio: "pipe",
      windowsVerbatimArguments: expectedInvocation.windowsVerbatimArguments,
    });
  });

  it("classifies a missing DSH executable spawn as not installed", async () => {
    const executableDirectory = mkdtempSync(path.join(os.tmpdir(), "codexhost-dsh-spawn-"));
    const executable = path.join(executableDirectory, "dsh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const child = childProcess();
    const spawn = vi.fn(() => {
      queueMicrotask(() =>
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
      );
      return child;
    });
    const environment = { PATH: executableDirectory };
    const dependencies: DeepSeekHostConnectionDependencies = {
      createClient: () => fakeClient(() => Promise.reject(new TypeError("fetch failed"))),
      spawn,
      sleep: () => Promise.resolve(),
    };
    const connection = new DeepSeekHostConnection(
      { endpoint: "http://127.0.0.1:43123", environment },
      dependencies,
    );

    await expect(connection.connect()).rejects.toMatchObject({ code: "notInstalled" });
  });

  it("rejects non-loopback endpoints and incompatible Hosts", async () => {
    expect(() => new NodeDeepSeekHostClient("http://example.com:3080")).toThrow(
      "endpoint must use HTTP on loopback",
    );
    const connection = new DeepSeekHostConnection(
      {},
      {
        createClient: () =>
          fakeClient(() =>
            Promise.resolve(
              success({
                version: "future",
                cwd: "/workspace",
                provider: "deepseek-official",
                model: "deepseek-v4-flash",
                attachedSessions: 0,
                canOpenPath: false,
              }),
            ),
          ),
        spawn: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    await expect(connection.connect()).rejects.toMatchObject({
      code: "protocolError",
    });
  });

  it("resolves the configured command from the Adapter environment", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-dsh-path-"));
    const executable = path.join(directory, process.platform === "win32" ? "dsh.cmd" : "dsh");
    writeFileSync(
      executable,
      process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    chmodSync(executable, 0o755);

    const resolved = resolveDeepSeekCommand(undefined, { PATH: directory });
    expect(resolved).toMatchObject({ arguments: [] });
    expect(resolved?.command.toLowerCase()).toBe(executable.toLowerCase());
    expect(resolveDeepSeekCommand(undefined, { PATH: "" })).toBeNull();
  });

  it("detects --no-open from dsh web help without matching nearby flags", () => {
    expect(dshWebHelpSupportsNoOpen("Options:\n  --no-open\n  --host <host>\n")).toBe(true);
    expect(dshWebHelpSupportsNoOpen("Options:\n  --host <host>\n  --port <port>\n")).toBe(false);
    expect(dshWebHelpSupportsNoOpen("--no-open-browser")).toBe(false);
  });
});
