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
  NodeDeepSeekHostClient,
  deepSeekProcessInvocation,
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
  it("executes the latest DSH Remote Command shape with an explicit empty image list", async () => {
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const envelope = JSON.parse(Buffer.concat(chunks).toString()) as { rpcId: string };
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
      client.commands.execute({
        agentId: "session-1",
        line: "/permission danger-full-access",
        images: [],
      }),
    ).resolves.toEqual({
      commandId: "command-1",
      result: { kind: "success", text: "preset danger-full-access" },
    });
    expect(requests).toEqual([
      expect.objectContaining({
        type: "client-request",
        method: "commands/execute",
        payload: {
          args: {
            agentId: "session-1",
            line: "/permission danger-full-access",
            images: [],
          },
        },
      }),
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
    });
    await connection.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
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
});
