import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { DeepSeekHostClient } from "../../src/legacy/host-client.js";
import {
  DeepSeekHarnessTransportError,
  DeepSeekHostConnection,
  NodeDeepSeekCommandClient,
  NodeDeepSeekHostClient,
  deepSeekProcessInvocation,
  resolveDeepSeekCommand,
  type DeepSeekHostConnectionDependencies,
} from "../../src/legacy/host-client.js";

function success<T>(value: T) {
  return { rpcId: "response" as never, result: { ok: true as const, value } };
}

function fakeClient(describe: () => Promise<unknown>): DeepSeekHostClient {
  return {
    host: { describe },
    llm: {
      models: () => Promise.resolve(success({ groups: [], failures: [] })),
    },
    settings: {
      describe: () =>
        Promise.resolve(success({ writable: false, hasDocument: false, namespaces: [] })),
    },
    sessions: {
      list: () => Promise.resolve(success({ items: [] })),
    },
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

  it("preserves validated command input metadata and native order", async () => {
    const catalog = [
      {
        name: "goal",
        description: "set or view the goal for a long-running task",
        input: {
          hint: "[<objective>|clear|edit <objective>|pause|resume]",
          images: true,
        },
      },
      {
        name: "feedback",
        description: "record feedback about this session",
        input: { hint: "<text>", images: false },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "server-response",
              rpcId: body.rpcId,
              result: { ok: true, value: catalog },
            }),
          ),
        );
      }),
    );
    try {
      const client = new NodeDeepSeekCommandClient("http://127.0.0.1:43123");
      await expect(client.list("session-1" as never)).resolves.toEqual({
        ok: true,
        value: catalog,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["non-array catalog", {}],
    ["invalid name", [{ name: "Goal", description: "goal" }]],
    ["blank description", [{ name: "goal", description: " " }]],
    ["unknown descriptor field", [{ name: "goal", description: "goal", future: true }]],
    ["blank input hint", [{ name: "goal", description: "goal", input: { hint: " " } }]],
    [
      "unknown input field",
      [{ name: "goal", description: "goal", input: { hint: "objective", future: true } }],
    ],
    [
      "invalid images flag",
      [{ name: "goal", description: "goal", input: { hint: "objective", images: "yes" } }],
    ],
    [
      "duplicate name",
      [
        { name: "goal", description: "first" },
        { name: "goal", description: "second" },
      ],
    ],
  ])("rejects a %s", async (_label, catalog) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "server-response",
              rpcId: body.rpcId,
              result: { ok: true, value: catalog },
            }),
          ),
        );
      }),
    );
    try {
      const client = new NodeDeepSeekCommandClient("http://127.0.0.1:43123");
      await expect(client.list("session-1" as never)).rejects.toMatchObject({
        code: "protocolError",
        message: expect.stringContaining("invalid command catalog"),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("executes the exact rc.2 Remote Command shape with an explicit empty image list", async () => {
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
            result: {
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
      { agentId: "session-1", line: "/permission danger-full-access", images: [] },
    ]);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("refuses redirects for both Legacy RPC clients without contacting the target", async () => {
    let targetRequests = 0;
    const target = createServer((_request, response) => {
      targetRequests += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("redirect target did not bind");
    }
    const origin = createServer((_request, response) => {
      response.statusCode = 307;
      response.setHeader("location", `http://127.0.0.1:${targetAddress.port}/capture`);
      response.end();
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originAddress = origin.address();
    if (!originAddress || typeof originAddress === "string") {
      throw new Error("redirect origin did not bind");
    }
    try {
      const endpoint = `http://127.0.0.1:${originAddress.port}`;
      const hostClient = new NodeDeepSeekHostClient(endpoint);
      const commandClient = new NodeDeepSeekCommandClient(endpoint);

      await expect(hostClient.host.describe({})).rejects.toMatchObject({
        code: "protocolError",
      });
      await expect(commandClient.list("session-1" as never)).rejects.toMatchObject({
        code: "protocolError",
      });
      expect(targetRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        origin.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        target.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("cancels rejected Legacy HTTP bodies before returning a transport error", async () => {
    let cancellations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                cancellations += 1;
              },
            }),
            { status: 500 },
          ),
        ),
      ),
    );
    try {
      const endpoint = "http://127.0.0.1:43123";
      await expect(new NodeDeepSeekHostClient(endpoint).host.describe({})).rejects.toMatchObject({
        code: "protocolError",
      });
      await expect(
        new NodeDeepSeekCommandClient(endpoint).list("session-1" as never),
      ).rejects.toMatchObject({ code: "protocolError" });
      expect(cancellations).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed on an external 404 without starting a managed process", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    const spawn = vi.fn();
    const endpoint = "http://127.0.0.1:43123";
    const connection = new DeepSeekHostConnection(
      {
        endpoint,
        commandInvocation: { command: "resolved-dsh", arguments: [], kind: "configured" },
      },
      {
        createClient: (url, timeoutMs) => new NodeDeepSeekHostClient(url, timeoutMs),
        spawn,
        sleep: () => Promise.resolve(),
      },
    );
    try {
      await expect(connection.connect()).rejects.toMatchObject({
        code: "protocolError",
        nativeCode: "HTTP_404",
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await connection.close();
      vi.unstubAllGlobals();
    }
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
      sleep: () => new Promise<void>(() => undefined),
    };
    const connection = new DeepSeekHostConnection({}, dependencies);

    await connection.connect();
    expect(spawn).not.toHaveBeenCalled();
    await connection.close();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("probes every exact rc.2 capability in order before attaching", async () => {
    const calls: string[] = [];
    const client = fakeClient(() => {
      calls.push("host.describe");
      return Promise.resolve(
        success({
          version: "0.0.1",
          cwd: "/workspace",
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
          attachedSessions: 0,
          canOpenPath: false,
        }),
      );
    });
    Object.assign(client.llm, {
      models: () => {
        calls.push("llm.models");
        return Promise.resolve(success({ groups: [], failures: [] }));
      },
    });
    Object.assign(client.settings, {
      describe: () => {
        calls.push("settings.describe");
        return Promise.resolve(success({ writable: false, hasDocument: false, namespaces: [] }));
      },
    });
    Object.assign(client.sessions, {
      list: () => {
        calls.push("sessions.list");
        return Promise.resolve(success({ items: [] }));
      },
    });
    const spawn = vi.fn();
    const connection = new DeepSeekHostConnection(
      { attachOnly: true },
      {
        createClient: () => client,
        spawn,
        sleep: () => new Promise<void>(() => undefined),
      },
    );

    await connection.connect();
    expect(calls).toEqual(["host.describe", "llm.models", "settings.describe", "sessions.list"]);
    expect(spawn).not.toHaveBeenCalled();
    await connection.close();
  });

  it.each(["llm.models", "settings.describe", "sessions.list"] as const)(
    "rejects a partial exact rc.2 wire when %s fails",
    async (operation) => {
      const client = fakeClient(() =>
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
      );
      const fail = () => Promise.reject(new Error(`${operation} unavailable`));
      if (operation === "llm.models") Object.assign(client.llm, { models: fail });
      if (operation === "settings.describe") Object.assign(client.settings, { describe: fail });
      if (operation === "sessions.list") Object.assign(client.sessions, { list: fail });
      const spawn = vi.fn();
      const connection = new DeepSeekHostConnection(
        {},
        {
          createClient: () => client,
          spawn,
          sleep: () => Promise.resolve(),
        },
      );

      await expect(connection.connect()).rejects.toMatchObject({ code: "protocolError" });
      expect(spawn).not.toHaveBeenCalled();
      await connection.close();
    },
  );

  it("rejects a Legacy mux that opens and immediately ends", async () => {
    const client = fakeClient(() =>
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
    );
    Object.assign(client.events, {
      mux: (_payload: unknown, _signal: AbortSignal, onOpen?: () => void) =>
        (async function* () {
          onOpen?.();
        })(),
    });
    const connection = new DeepSeekHostConnection(
      { attachOnly: true, startupTimeoutMs: 100 },
      {
        createClient: () => client,
        spawn: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    await expect(connection.connect()).rejects.toMatchObject({ code: "protocolError" });
    await connection.close();
  });

  it("bounds close even when an injected Legacy mux ignores cancellation", async () => {
    const client = fakeClient(() =>
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
    );
    Object.assign(client.events, {
      mux: (_payload: unknown, _signal: AbortSignal, onOpen?: () => void) =>
        (async function* () {
          onOpen?.();
          await new Promise<void>(() => undefined);
          yield undefined as never;
        })(),
    });
    const connection = new DeepSeekHostConnection(
      { attachOnly: true, closeTimeoutMs: 1 },
      {
        createClient: () => client,
        spawn: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    );

    await connection.connect();
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it("does not spawn after close wins an uncooperative initial probe", async () => {
    let rejectProbe!: (error: Error) => void;
    const probe = new Promise<never>((_resolve, reject) => {
      rejectProbe = reject;
    });
    const spawn = vi.fn();
    const connection = new DeepSeekHostConnection(
      {
        commandInvocation: { command: "resolved-dsh", arguments: [], kind: "configured" },
        closeTimeoutMs: 1,
      },
      {
        createClient: () => fakeClient(() => probe),
        spawn,
        sleep: () => Promise.resolve(),
      },
    );

    const connecting = connection.connect();
    const rejected = expect(connecting).rejects.toMatchObject({ code: "cancelled" });
    await connection.close();
    rejectProbe(new TypeError("fetch failed"));
    await rejected;
    expect(spawn).not.toHaveBeenCalled();
  });

  it("treats an unresponsive endpoint timeout as unavailable", async () => {
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const spawn = vi.fn();
    const connection = new DeepSeekHostConnection(
      { attachOnly: true },
      {
        createClient: () => fakeClient(() => Promise.reject(timeout)),
        spawn,
        sleep: () => Promise.resolve(),
      },
    );

    await expect(connection.connect()).rejects.toMatchObject({ code: "unavailable" });
    expect(spawn).not.toHaveBeenCalled();
    await connection.close();
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
      sleep: () => new Promise<void>(() => undefined),
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
    const killProcessTree = vi.fn((owned: ChildProcess) => {
      if (owned.exitCode !== null || owned.signalCode !== null) return;
      Object.assign(owned, { signalCode: "SIGKILL" });
      queueMicrotask(() => owned.emit("exit", null, "SIGKILL"));
    });
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
      sleep: () => new Promise<void>(() => undefined),
      killProcessTree,
    };
    const connection = new DeepSeekHostConnection(
      { command: executable, endpoint: "http://127.0.0.1:43123" },
      dependencies,
    );

    await connection.connect();
    const expectedInvocation = deepSeekProcessInvocation(
      executable,
      ["web", "--no-open", "--host", "127.0.0.1", "--port", "43123"],
      process.env,
    );
    expect(spawn).toHaveBeenCalledWith(expectedInvocation.command, expectedInvocation.arguments, {
      env: process.env,
      stdio: "pipe",
      windowsVerbatimArguments: expectedInvocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    await connection.close();
    expect(killProcessTree).toHaveBeenCalledWith(child, process.platform, 3_000);
    if (process.platform !== "win32") expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("retries a temporary 404 while an owned rc.2 Web mounts its exact routes", async () => {
    const child = childProcess();
    let managed = false;
    let hostCalls = 0;
    let modelCalls = 0;
    const client = fakeClient(() => {
      hostCalls += 1;
      return managed
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
        : Promise.reject(new TypeError("fetch failed"));
    });
    Object.assign(client.llm, {
      models: () => {
        modelCalls += 1;
        return modelCalls === 1
          ? Promise.reject(
              new DeepSeekHarnessTransportError(
                "protocolError",
                "DeepSeek Harness Legacy RPC failed with HTTP 404",
                "HTTP_404",
              ),
            )
          : Promise.resolve(success({ groups: [], failures: [] }));
      },
    });
    const sleep = vi.fn(() => Promise.resolve());
    const connection = new DeepSeekHostConnection(
      {
        commandInvocation: { command: "resolved-dsh", arguments: [], kind: "configured" },
        endpoint: "http://127.0.0.1:43123",
      },
      {
        createClient: () => client,
        spawn: () => {
          managed = true;
          return child;
        },
        sleep,
        killProcessTree: (owned) => {
          Object.assign(owned, { signalCode: "SIGKILL" });
          queueMicrotask(() => owned.emit("exit", null, "SIGKILL"));
        },
      },
    );

    await expect(connection.connect()).resolves.toBeUndefined();
    expect(hostCalls).toBe(3);
    expect(modelCalls).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    await connection.close();
  });

  it("passes an IPv6 loopback bind host without URL brackets", async () => {
    const executableDirectory = mkdtempSync(path.join(os.tmpdir(), "codexhost-dsh-ipv6-"));
    const executable = path.join(executableDirectory, "dsh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    let ready = false;
    const child = childProcess();
    const spawn = vi.fn(() => {
      ready = true;
      return child;
    });
    const connection = new DeepSeekHostConnection(
      { command: executable, endpoint: "http://[::1]:43123" },
      {
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
        sleep: () => new Promise<void>(() => undefined),
        killProcessTree: (owned) => {
          Object.assign(owned, { signalCode: "SIGKILL" });
          queueMicrotask(() => owned.emit("exit", null, "SIGKILL"));
        },
      },
    );

    await connection.connect();
    const spawnCall = spawn.mock.calls[0] as unknown as [string, string[]];
    const spawnedArguments = spawnCall[1];
    const hostIndex = spawnedArguments.indexOf("--host");
    expect(spawnedArguments.slice(hostIndex, hostIndex + 2)).toEqual(["--host", "::1"]);
    await connection.close();
  });

  it("rejects close when the managed Legacy process survives tree cleanup", async () => {
    let ready = false;
    const child = childProcess();
    const killProcessTree = vi.fn(() => undefined);
    const connection = new DeepSeekHostConnection(
      {
        commandInvocation: { command: "resolved-dsh", arguments: [], kind: "configured" },
        endpoint: "http://127.0.0.1:43123",
        closeTimeoutMs: 1,
      },
      {
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
        spawn: () => {
          ready = true;
          return child;
        },
        sleep: () => new Promise<void>(() => undefined),
        platform: "win32",
        killProcessTree,
      },
    );

    await connection.connect();
    await expect(connection.close()).rejects.toMatchObject({ code: "unavailable" });
    expect(killProcessTree).toHaveBeenCalledOnce();
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
        "web",
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        "43123",
      ],
      environment,
    );
    expect(spawn).toHaveBeenCalledWith(expectedInvocation.command, expectedInvocation.arguments, {
      env: environment,
      stdio: "pipe",
      windowsVerbatimArguments: expectedInvocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    await connection.close();
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
      "loopback HTTP root",
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
});
