import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createRemoteOfficialAppServerListener,
  remoteOfficialAppServerSocketPath,
} from "../src/remote-official-app-server.js";

class FakeOfficialListenerProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  });
}

class StubbornOfficialListenerProcess extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === "SIGKILL") queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
    return true;
  });
}

describe("shared remote official app-server", () => {
  it("uses a private sibling socket distinct from the Desktop control socket", () => {
    expect(
      remoteOfficialAppServerSocketPath(
        "/Users/developer/.codex/app-server-control/app-server-control.sock",
        "fixture1234",
      ),
    ).toBe("/Users/developer/.codex/app-server-control/.c-fixture1234.sock");
  });

  it("keeps the private sibling basename within the public socket path budget", () => {
    const publicSocket = "/Users/developer/.codex/app-server-control/app-server-control.sock";
    const privateSocket = remoteOfficialAppServerSocketPath(
      publicSocket,
      "12345678-1234-1234-1234-123456789abc",
    );

    expect(Buffer.byteLength(path.posix.basename(privateSocket))).toBeLessThanOrEqual(
      Buffer.byteLength(path.posix.basename(publicSocket)),
    );
  });

  it("starts one listener and keeps it alive until the remote Host closes", async () => {
    const child = new FakeOfficialListenerProcess();
    const spawnOfficial = vi.fn(
      () => child as unknown as ReturnType<typeof spawn> & ChildProcess,
    ) as unknown as typeof spawn;
    const waitUntilReady = vi.fn(async () => undefined);
    const listener = createRemoteOfficialAppServerListener({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server", "--listen", "unix:///tmp/codexhost-official.sock"],
      socketPath: "/tmp/codexhost-official.sock",
      environment: { PATH: "/usr/bin" },
      diagnosticOutput: new PassThrough(),
      spawnOfficial,
      waitUntilReady,
    });

    await listener.listen();
    await listener.listen();

    expect(spawnOfficial).toHaveBeenCalledTimes(1);
    expect(spawnOfficial).toHaveBeenCalledWith(
      "/synthetic/codex",
      ["app-server", "--listen", "unix:///tmp/codexhost-official.sock"],
      expect.objectContaining({
        env: { PATH: "/usr/bin" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      }),
    );
    expect(waitUntilReady).toHaveBeenCalledWith(
      "/tmp/codexhost-official.sock",
      expect.any(Promise),
    );
    expect(child.kill).not.toHaveBeenCalled();

    await listener.close();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(listener.closed).resolves.toEqual({ code: null, signal: "SIGTERM" });
  });

  it("escalates shutdown when the official listener ignores SIGTERM", async () => {
    const child = new StubbornOfficialListenerProcess();
    const listener = createRemoteOfficialAppServerListener({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server", "--listen", "unix:///tmp/codexhost-official.sock"],
      socketPath: "/tmp/codexhost-official.sock",
      environment: { PATH: "/usr/bin" },
      diagnosticOutput: new PassThrough(),
      spawnOfficial: vi.fn(
        () => child as unknown as ReturnType<typeof spawn> & ChildProcess,
      ) as unknown as typeof spawn,
      waitUntilReady: vi.fn(async () => undefined),
      closeTimeoutMs: 1,
    });

    await listener.listen();
    await listener.close();

    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(listener.closed).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });
});
