import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import type {
  RemoteHostInstallationStatus,
  RemoteHostManifestV1,
} from "../src/remote-host-install.js";
import {
  classifyRemoteHostProbeResponse,
  inspectRemoteHost,
  setRemoteHostLifecycleDependenciesForTest,
  startRemoteHost,
  stopRemoteHost,
  type RemoteHostRuntimeStatus,
} from "../src/remote-host-lifecycle.js";

const home = "/home/developer";
const socketPath = path.join(home, ".codex", "app-server-control", "app-server-control.sock");
const manifest: RemoteHostManifestV1 = {
  format: 1,
  wrapperPath: "/home/developer/.codexhost/remote/bin/codex",
  profilePath: "/home/developer/.bashrc",
  stockCodexPath: "/opt/codex/bin/codex",
  nodePath: "/opt/node/bin/node",
  shimPath: "/opt/codexhost/bin/codexhost-shim",
  hostRuntimePath: "/opt/codexhost/app/host-runtime.mjs",
  dataDirectory: "/home/developer/.codexhost/remote/data",
};
const readyInstallation: RemoteHostInstallationStatus = {
  state: "ready",
  issues: [],
  ...manifest,
};

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function runtime(
  state: RemoteHostRuntimeStatus["state"],
  protocol?: RemoteHostRuntimeStatus["protocol"],
): RemoteHostRuntimeStatus {
  return { state, socketPath, ...(protocol ? { protocol } : {}) };
}

describe("remote Host lifecycle", () => {
  it("uses the lightweight update status method to identify the managed Host", () => {
    expect(
      classifyRemoteHostProbeResponse(
        { id: 1, error: { code: -32090, message: "Application updates are unavailable" } },
        socketPath,
      ),
    ).toEqual({ state: "running", socketPath, protocol: "codexhost" });
    expect(
      classifyRemoteHostProbeResponse(
        {
          id: 1,
          error: {
            code: -32600,
            message: "Invalid request: unknown variant `codexhost/update/status`",
          },
        },
        socketPath,
      ),
    ).toEqual({ state: "conflict", socketPath, protocol: "stock-codex" });
    expect(
      classifyRemoteHostProbeResponse(
        { id: 1, error: { code: -32602, message: "Invalid request" } },
        socketPath,
      ),
    ).toBeNull();
  });

  it("reports installation and runtime state together", async () => {
    restore = setRemoteHostLifecycleDependenciesForTest({
      inspectInstallation: vi.fn().mockResolvedValue(readyInstallation),
      probeProtocol: vi.fn().mockResolvedValue(runtime("conflict", "stock-codex")),
    });

    await expect(inspectRemoteHost({ environment: { HOME: home } })).resolves.toMatchObject({
      state: "ready",
      runtime: { state: "conflict", protocol: "stock-codex", socketPath },
    });
  });

  it("is idempotent when the managed Host is already running", async () => {
    const launch = vi.fn();
    const terminate = vi.fn();
    restore = setRemoteHostLifecycleDependenciesForTest({
      inspectInstallation: vi.fn().mockResolvedValue(readyInstallation),
      probeProtocol: vi.fn().mockResolvedValue(runtime("running", "codexhost")),
      launch,
      runTerminator: terminate,
    });

    await expect(
      startRemoteHost({ platform: "linux", environment: { HOME: home } }),
    ).resolves.toEqual({ state: "running", changed: false, socketPath });
    expect(launch).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("uses process verification when an active listener cannot be classified", async () => {
    const operations: string[] = [];
    restore = setRemoteHostLifecycleDependenciesForTest({
      inspectInstallation: vi.fn().mockResolvedValue(readyInstallation),
      probeProtocol: vi.fn().mockResolvedValue(runtime("unknown", "unknown")),
      runTerminator: vi.fn(async (_manifest, _socket, role) => {
        operations.push(`terminate:${role}`);
      }),
      launch: vi.fn(() => operations.push("launch")),
      waitForRuntime: vi.fn(async () => {
        operations.push("ready");
        return runtime("running", "codexhost");
      }),
    });

    await expect(
      startRemoteHost({ platform: "linux", environment: { HOME: home } }),
    ).resolves.toEqual({
      state: "running",
      changed: true,
      socketPath,
      replacedStockCodex: true,
    });
    expect(operations).toEqual(["terminate:stock", "launch", "ready"]);
  });

  it("fails closed for an unknown active socket", async () => {
    const launch = vi.fn();
    const terminate = vi
      .fn()
      .mockRejectedValue(
        new Error("remote Host socket owner does not match the requested installed listener"),
      );
    restore = setRemoteHostLifecycleDependenciesForTest({
      inspectInstallation: vi.fn().mockResolvedValue(readyInstallation),
      probeProtocol: vi
        .fn()
        .mockResolvedValue({ ...runtime("unknown", "unknown"), message: "unknown owner" }),
      launch,
      runTerminator: terminate,
    });

    await expect(
      startRemoteHost({ platform: "linux", environment: { HOME: home } }),
    ).rejects.toThrow("socket owner does not match");
    expect(launch).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledWith(expect.objectContaining(manifest), socketPath, "stock", {
      HOME: home,
    });
  });

  it("stops only a protocol-verified managed Host", async () => {
    const terminate = vi.fn();
    restore = setRemoteHostLifecycleDependenciesForTest({
      inspectInstallation: vi.fn().mockResolvedValue(readyInstallation),
      probeProtocol: vi.fn().mockResolvedValue(runtime("running", "codexhost")),
      runTerminator: terminate,
      socketExists: vi.fn().mockResolvedValue(false),
    });

    await expect(
      stopRemoteHost({ platform: "linux", environment: { HOME: home } }),
    ).resolves.toEqual({ state: "stopped", changed: true, socketPath });
    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining(manifest),
      socketPath,
      "managed",
      { HOME: home },
    );
  });

  it("refuses to stop a stock listener", async () => {
    const terminate = vi.fn();
    restore = setRemoteHostLifecycleDependenciesForTest({
      inspectInstallation: vi.fn().mockResolvedValue(readyInstallation),
      probeProtocol: vi.fn().mockResolvedValue(runtime("conflict", "stock-codex")),
      runTerminator: terminate,
    });

    await expect(
      stopRemoteHost({ platform: "linux", environment: { HOME: home } }),
    ).rejects.toThrow("not owned by codexhost");
    expect(terminate).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "probes a listener that rejects clients offering WebSocket extensions",
    async () => {
      // The stock codex app-server uses tokio-tungstenite, which supports no
      // extension and aborts the upgrade without writing an HTTP response when a
      // client offers one. `ws` enables permessage-deflate by default, so a probe
      // that keeps that default hangs until its timeout and reports "unknown"
      // instead of classifying the listener.
      //
      // Unix socket paths are capped near 104 bytes and the probe appends a
      // fixed suffix to CODEX_HOME, so bind under a short base directory.
      const codexHome = await mkdtemp("/tmp/cxh-");
      await mkdir(path.join(codexHome, "app-server-control"), { recursive: true });
      const listenerPath = path.join(codexHome, "app-server-control", "app-server-control.sock");

      const server: Server = createServer();
      const webSockets = new WebSocketServer({ noServer: true });
      server.on("upgrade", (request, socket: Duplex, head) => {
        if (request.headers["sec-websocket-extensions"]) {
          socket.destroy();
          return;
        }
        webSockets.handleUpgrade(request, socket, head, (client) => {
          client.on("message", () =>
            client.send(
              JSON.stringify({
                id: 1,
                error: {
                  code: -32600,
                  message: "Invalid request: unknown variant `codexhost/update/status`",
                },
              }),
            ),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(listenerPath, resolve));

      restore = setRemoteHostLifecycleDependenciesForTest({
        inspectInstallation: vi.fn().mockResolvedValue(readyInstallation),
      });

      try {
        await expect(
          inspectRemoteHost({ environment: { CODEX_HOME: codexHome } }),
        ).resolves.toMatchObject({
          runtime: {
            state: "conflict",
            protocol: "stock-codex",
            socketPath: listenerPath,
          },
        });
      } finally {
        webSockets.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(codexHome, { recursive: true, force: true });
      }
    },
  );
});
