import { spawn } from "node:child_process";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

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
  vi.mocked(spawn).mockClear();
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

  it.each([undefined, "/custom/claude"])(
    "leaves Claude discovery to the inherited environment (override: %s)",
    async (command) => {
      const environment = {
        HOME: home,
        PATH: "/user/bin",
        ...(command ? { CODEXHOST_CLAUDE_COMMAND: command } : {}),
      };
      restore = setRemoteHostLifecycleDependenciesForTest({
        inspectInstallation: vi.fn().mockResolvedValue({
          ...readyInstallation,
          claudeCommand: "/old/claude",
        }),
        probeProtocol: vi.fn().mockResolvedValue(runtime("stopped")),
        waitForRuntime: vi.fn().mockResolvedValue(runtime("running", "codexhost")),
      });

      await expect(startRemoteHost({ platform: "linux", environment })).resolves.toMatchObject({
        state: "running",
        changed: true,
      });
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith(
        manifest.wrapperPath,
        ["-c", "features.code_mode_host=true", "app-server", "--listen", "unix://"],
        expect.objectContaining({
          detached: true,
          env: expect.objectContaining({
            ...environment,
            PATH: expect.stringContaining(environment.PATH),
          }),
        }),
      );
      expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env?.CODEXHOST_CLAUDE_COMMAND).toBe(command);
    },
  );

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
});
