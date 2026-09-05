import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { Event } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";

import type { OpenCodeTransportListener } from "../src/protocol.js";
import {
  managedOpenCodeEnvironment,
  OpenCodeServerConnection,
  SdkOpenCodeTransport,
  type OpenCodeServerDependencies,
} from "../src/sdk-transport.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 91_337;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

function clientWith(overrides: Record<string, unknown> = {}): OpencodeClient {
  return {
    global: {
      health: async () => ({ data: { healthy: true, version: "1.18.25" }, error: undefined }),
    },
    ...overrides,
  } as unknown as OpencodeClient;
}

describe("OpenCode SDK transport", () => {
  it("keeps default permissions native and scopes unattended permissions to the supplied Server env", () => {
    const input = {
      PATH: "/synthetic/bin",
      CODEXHOST_THREAD_ID: "thread-child",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
      CODEXHOST_RUNTIME_TOKEN: "runtime-secret",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "provider/model", permission: "ask" }),
    };
    const defaultEnvironment = managedOpenCodeEnvironment(input, "default");
    expect(defaultEnvironment).toEqual(input);
    expect(defaultEnvironment).not.toBe(input);

    const unattendedEnvironment = managedOpenCodeEnvironment(input, "unattended-full-access");
    expect(unattendedEnvironment).toMatchObject({
      PATH: "/synthetic/bin",
      CODEXHOST_THREAD_ID: "thread-child",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
      CODEXHOST_RUNTIME_TOKEN: "runtime-secret",
    });
    expect(JSON.parse(unattendedEnvironment.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
      model: "provider/model",
      permission: "allow",
    });
    expect(input.OPENCODE_CONFIG_CONTENT).toContain('"ask"');
  });

  it("rejects malformed config before enabling unattended execution", () => {
    expect(() =>
      managedOpenCodeEnvironment({ OPENCODE_CONFIG_CONTENT: "not-json" }, "unattended-full-access"),
    ).toThrowError(/valid JSON OPENCODE_CONFIG_CONTENT/);
  });

  it("starts an authenticated loopback Server and restarts after an unexpected exit", async () => {
    const children: FakeChild[] = [];
    const clientOptions: Array<{
      baseUrl: string;
      directory?: string;
      headers: Record<string, string>;
    }> = [];
    const spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const dependencies: OpenCodeServerDependencies = {
      createClient: (options) => {
        clientOptions.push(options);
        return clientWith();
      },
      randomPassword: () => "synthetic-password",
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, env: options.env });
        const child = new FakeChild();
        child.pid += children.length;
        children.push(child);
        queueMicrotask(() => {
          child.stdout.write(
            `opencode server listening on http://127.0.0.1:${4_000 + children.length}\n`,
          );
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
      sleep: async () => undefined,
    };
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      dependencies,
    );

    await connection.client("/first");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: process.execPath,
      args: ["serve", "--hostname=127.0.0.1", "--port=0"],
      env: {
        OPENCODE_SERVER_USERNAME: "codexhost",
        OPENCODE_SERVER_PASSWORD: "synthetic-password",
      },
    });
    expect(clientOptions.at(-1)).toMatchObject({
      baseUrl: "http://127.0.0.1:4001",
      directory: "/first",
      headers: {
        Authorization: `Basic ${Buffer.from("codexhost:synthetic-password").toString("base64")}`,
      },
    });

    const first = children[0] as FakeChild;
    first.exitCode = 1;
    first.emit("exit", 1, null);
    await connection.client("/second");
    expect(spawnCalls).toHaveLength(2);
    expect(clientOptions.at(-1)).toMatchObject({
      baseUrl: "http://127.0.0.1:4002",
      directory: "/second",
    });

    const second = children[1] as FakeChild;
    second.exitCode = 0;
    await connection.close();
  });

  it("allows a later retry after startup fails before a child is available", async () => {
    let attempts = 0;
    const child = new FakeChild();
    const dependencies: OpenCodeServerDependencies = {
      createClient: () => clientWith(),
      randomPassword: () => "synthetic-password",
      spawn: () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        queueMicrotask(() => {
          child.stdout.write("opencode server listening on http://127.0.0.1:4010\n");
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
      sleep: async () => undefined,
    };
    const connection = new OpenCodeServerConnection(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      dependencies,
    );

    await expect(connection.client()).rejects.toMatchObject({ code: "notInstalled" });
    await expect(connection.client()).resolves.toBeDefined();
    expect(attempts).toBe(2);
    child.exitCode = 0;
    await connection.close();
  });

  it("checks SDK result errors while accepting the prompt_async 204 payload", async () => {
    const promptAsync = vi
      .fn()
      .mockResolvedValueOnce({ data: undefined, error: undefined })
      .mockResolvedValueOnce({ data: undefined, error: undefined })
      .mockResolvedValueOnce({ data: undefined, error: { message: "synthetic rejection" } });
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ session: { promptAsync } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { commandTimeoutMs: 100 });
    const input = { sessionID: "session-1", text: "hello" };

    await expect(transport.promptAsync(input)).resolves.toBeUndefined();
    expect(promptAsync).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ messageID: expect.anything() }),
      { signal: expect.any(AbortSignal) },
    );
    await expect(
      transport.promptAsync({ ...input, messageID: "msg_000000000001CH012345678900" }),
    ).resolves.toBeUndefined();
    expect(promptAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageID: "msg_000000000001CH012345678900" }),
      { signal: expect.any(AbortSignal) },
    );
    await expect(transport.promptAsync(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("aborts an ambiguous prompt admission when its response times out", async () => {
    let signal: AbortSignal | undefined;
    const promptAsync = vi.fn((_input: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<never>(() => undefined);
    });
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ session: { promptAsync } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", {
      commandTimeoutMs: 5,
    });

    await expect(
      transport.promptAsync({ sessionID: "session-1", text: "hello" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(signal?.aborted).toBe(true);
  });

  it("updates Session metadata through the SDK", async () => {
    const update = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: undefined });
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ session: { update } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { commandTimeoutMs: 100 });

    await expect(
      transport.updateSessionMetadata("session-1", { "codexhost.selection.v1": { modelID: "m" } }),
    ).resolves.toMatchObject({ id: "session-1" });
    expect(update).toHaveBeenCalledWith({
      sessionID: "session-1",
      metadata: { "codexhost.selection.v1": { modelID: "m" } },
    });
  });

  it("reads authoritative directory and worktree paths through the SDK", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        home: "/home/synthetic",
        state: "/state",
        config: "/config",
        directory: "/repo/packages/app",
        worktree: "/repo",
      },
      error: undefined,
    });
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ path: { get } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/repo/packages/app", {
      commandTimeoutMs: 100,
    });

    await expect(transport.getPaths()).resolves.toMatchObject({
      directory: "/repo/packages/app",
      worktree: "/repo",
    });
    expect(get).toHaveBeenCalledWith();
  });

  it("creates and updates Session permissions through the SDK", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: undefined });
    const update = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: undefined });
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ session: { create, update } }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { commandTimeoutMs: 100 });
    const ask = [{ permission: "*", pattern: "*", action: "ask" }] as const;
    const allow = [{ permission: "*", pattern: "*", action: "allow" }] as const;

    await transport.createSession({ permission: [...ask] });
    await transport.updateSessionPermission("session-1", [...allow]);
    expect(create).toHaveBeenCalledWith({ permission: ask });
    expect(update).toHaveBeenCalledWith({ sessionID: "session-1", permission: allow });
  });

  it("fails closed when a data-bearing SDK response omits data", async () => {
    const connection = {
      stderrTail: "",
      client: async () =>
        clientWith({
          global: { health: async () => ({ data: undefined, error: undefined }) },
        }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", { commandTimeoutMs: 100 });

    await expect(transport.health()).rejects.toMatchObject({ code: "protocolError" });
  });

  it("reconnects the SSE stream and emits a new server.connected boundary", async () => {
    let subscriptions = 0;
    const event = {
      subscribe: async (_input: unknown, options: { signal: AbortSignal }) => {
        subscriptions += 1;
        const ordinal = subscriptions;
        return {
          stream: (async function* (): AsyncGenerator<Event> {
            yield { id: `connected-${ordinal}`, type: "server.connected", properties: {} };
            if (ordinal === 1) return;
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })(),
        };
      },
    };
    const connection = {
      stderrTail: "",
      client: async () => clientWith({ event }),
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", {
      commandTimeoutMs: 100,
      reconnectAttempts: 2,
      reconnectDelayMs: 1,
    });
    const events: Event[] = [];
    const listener: OpenCodeTransportListener = {
      onEvent: (next) => events.push(next),
      onFault: vi.fn(),
    };

    await transport.subscribe(listener);
    await vi.waitFor(() =>
      expect(events.map(({ id }) => id)).toEqual(["connected-1", "connected-2"]),
    );
    expect(subscriptions).toBe(2);
    expect(listener.onFault).not.toHaveBeenCalled();
    await transport.close();
  });
});
