import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { DeepSeekHostClient } from "../src/host-client.js";
import {
  DeepSeekHostConnection,
  NodeDeepSeekHostClient,
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
    expect(spawn).toHaveBeenCalledWith(
      executable,
      ["web", "--host", "127.0.0.1", "--port", "43123"],
      {
        env: process.env,
        stdio: "ignore",
      },
    );
    await connection.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
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
