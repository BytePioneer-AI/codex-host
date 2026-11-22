import { spawn } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runRemoteHostCli } from "../src/remote-host-cli.js";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }),
}));

import type {
  RemoteHostInstallationStatus,
  RemoteHostManifestV1,
} from "../src/remote-host-install.js";
import {
  classifyRemoteHostProbeResponse,
  probeWebSocket,
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
  it.each(["ssh", "desktop"] as const)(
    "uses the installed %s execution session instead of an inherited selection",
    async (executionSession) => {
      restore = setRemoteHostLifecycleDependenciesForTest({
        inspectInstallation: vi.fn().mockResolvedValue({ ...readyInstallation, executionSession }),
        probeProtocol: vi.fn().mockResolvedValue(runtime("stopped")),
        waitForRuntime: vi.fn().mockResolvedValue(runtime("running", "codexhost")),
      });
      await startRemoteHost({
        platform: "darwin",
        environment: { HOME: home, CODEXHOST_REMOTE_EXECUTION_SESSION: "stale" },
      });
      expect(spawn).toHaveBeenCalledWith(
        manifest.wrapperPath,
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ CODEXHOST_REMOTE_EXECUTION_SESSION: executionSession }),
        }),
      );
    },
  );

  it.skipIf(process.platform === "win32").each([
    {
      name: "desktop launch diagnostics",
      script:
        'process.stderr.write("x".repeat(4000) + "\\ndesktop launch failed: desktop session unavailable\\n"); process.exitCode = 1;',
      message: "desktop launch failed: desktop session unavailable",
    },
    {
      name: "exit code without stderr",
      script: "process.exitCode = 7;",
      message: "exit code 7",
    },
    {
      name: "signal without stderr",
      script: 'process.kill(process.pid, "SIGTERM");',
      message: "SIGTERM",
    },
  ])(
    "returns early startup errors from the real launch path ($name)",
    async ({ script, message }) => {
      const directory = await mkdtemp(path.join(tmpdir(), "remote-start-"));
      const wrapperPath = path.join(directory, "codex");
      await writeFile(wrapperPath, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
      const { spawn: realSpawn } =
        await vi.importActual<typeof ChildProcessModule>("node:child_process");
      vi.mocked(spawn).mockImplementationOnce(realSpawn);
      const probe = vi.fn().mockResolvedValue(runtime("stopped"));
      restore = setRemoteHostLifecycleDependenciesForTest({
        inspectInstallation: vi.fn().mockResolvedValue({
          ...readyInstallation,
          wrapperPath,
          executionSession: "desktop",
        }),
        probeProtocol: probe,
      });
      try {
        const error = await startRemoteHost({
          platform: "darwin",
          environment: { HOME: home },
        }).catch((error: Error) => error);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(message);
        expect((error as Error).message.length).toBeLessThanOrEqual(2_000);
        expect(probe).toHaveBeenCalledOnce();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    3_000,
  );

  it.skipIf(process.platform === "win32")(
    "returns spawn errors through CLI remote start",
    async () => {
      const { spawn: realSpawn } =
        await vi.importActual<typeof ChildProcessModule>("node:child_process");
      vi.mocked(spawn).mockImplementationOnce(realSpawn);
      restore = setRemoteHostLifecycleDependenciesForTest({
        inspectInstallation: vi.fn().mockResolvedValue({
          ...readyInstallation,
          wrapperPath: path.join(tmpdir(), "missing-remote-start", "codex"),
        }),
        probeProtocol: vi.fn().mockResolvedValue(runtime("stopped")),
      });
      const stderr = new PassThrough();
      expect(
        await runRemoteHostCli({
          arguments: ["start"],
          environment: { HOME: home },
          output: new PassThrough(),
          diagnosticOutput: stderr,
        }),
      ).toBe(1);
      expect(stderr.read().toString()).toContain("ENOENT");
    },
  );

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

  it("identifies a Host that announces Threads before answering the probe", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    server.on("connection", (connection) => {
      connection.send(JSON.stringify({ method: "thread/started", params: {} }));
      connection.on("message", () => {
        connection.send(JSON.stringify({ method: "thread/started", params: {} }));
        connection.send(
          JSON.stringify({
            id: 1,
            error: { code: -32090, message: "Application updates are unavailable" },
          }),
        );
      });
    });
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        probeWebSocket({
          socketPath,
          createConnection: () => net.createConnection(port, "127.0.0.1"),
          timeoutMs: 2_000,
          timeoutMessage: "timed out",
        }),
      ).resolves.toEqual({ state: "running", socketPath, protocol: "codexhost" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
      launch: vi.fn(() => {
        operations.push("launch");
      }),
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

  it.skipIf(process.platform === "win32").each(["running", "stopped"] as const)(
    "CLI stop uses the installed manifest without --shim (%s)",
    async (state) => {
      const terminate = vi.fn();
      const inspect = vi.fn().mockResolvedValue(readyInstallation);
      restore = setRemoteHostLifecycleDependenciesForTest({
        inspectInstallation: inspect,
        probeProtocol: vi.fn().mockResolvedValue(runtime(state, "codexhost")),
        runTerminator: terminate,
        socketExists: vi.fn().mockResolvedValue(false),
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      expect(
        await runRemoteHostCli({
          arguments: ["stop"],
          environment: { HOME: home },
          output: stdout,
          diagnosticOutput: stderr,
        }),
      ).toBe(0);
      expect(JSON.parse(stdout.read().toString())).toEqual({
        state: "stopped",
        changed: state === "running",
        socketPath,
      });
      expect(stderr.read()).toBeNull();
      expect(inspect).toHaveBeenCalledWith({ environment: { HOME: home } });
      expect(terminate).toHaveBeenCalledTimes(state === "running" ? 1 : 0);
    },
  );

  it("allows stopping an outdated installation but still refuses to start it", async () => {
    const terminate = vi.fn();
    const probe = vi.fn().mockResolvedValue(runtime("running", "codexhost"));
    const launch = vi.fn();
    restore = setRemoteHostLifecycleDependenciesForTest({
      inspectInstallation: vi.fn().mockResolvedValue({
        ...readyInstallation,
        state: "degraded",
        issues: ["shell profile does not configure the managed native entrypoint"],
      }),
      probeProtocol: probe,
      runTerminator: terminate,
      socketExists: vi.fn().mockResolvedValue(false),
      launch,
    });
    const options = { platform: "linux" as const, environment: { HOME: home } };

    await expect(startRemoteHost(options)).rejects.toThrow("installation is degraded");
    expect(probe).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    await expect(stopRemoteHost(options)).resolves.toEqual({
      state: "stopped",
      changed: true,
      socketPath,
    });
    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining(manifest),
      socketPath,
      "managed",
      options.environment,
    );
  });

  it("preserves native ownership verification when stopping a degraded installation", async () => {
    const terminate = vi.fn().mockRejectedValue(new Error("socket owner does not match"));
    restore = setRemoteHostLifecycleDependenciesForTest({
      inspectInstallation: vi.fn().mockResolvedValue({
        ...readyInstallation,
        state: "degraded",
        issues: ["shell profile does not configure the managed native entrypoint"],
      }),
      probeProtocol: vi.fn().mockResolvedValue(runtime("running", "codexhost")),
      runTerminator: terminate,
    });

    await expect(
      stopRemoteHost({ platform: "linux", environment: { HOME: home } }),
    ).rejects.toThrow("socket owner does not match");
    expect(terminate).toHaveBeenCalledOnce();
  });

  it.each(["ready", "degraded"])(
    "refuses to stop a stock listener (%s installation)",
    async (state) => {
      const terminate = vi.fn();
      restore = setRemoteHostLifecycleDependenciesForTest({
        inspectInstallation: vi.fn().mockResolvedValue({ ...readyInstallation, state }),
        probeProtocol: vi.fn().mockResolvedValue(runtime("conflict", "stock-codex")),
        runTerminator: terminate,
      });

      await expect(
        stopRemoteHost({ platform: "linux", environment: { HOME: home } }),
      ).rejects.toThrow("not owned by codexhost");
      expect(terminate).not.toHaveBeenCalled();
    },
  );
});

it("passes the persisted shared directory to a fresh SSH listener without replacing its own store", async () => {
  restore = setRemoteHostLifecycleDependenciesForTest({
    inspectInstallation: vi
      .fn()
      .mockResolvedValue({ ...readyInstallation, sharedDataDirectory: "/custom/shared-host" }),
    probeProtocol: vi.fn().mockResolvedValue(runtime("stopped")),
    waitForRuntime: vi.fn().mockResolvedValue(runtime("running", "codexhost")),
  });
  await startRemoteHost({
    platform: "linux",
    environment: { HOME: home, CODEXHOST_SHARED_DATA_DIR: "/stale/inherited" },
  });
  expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toMatchObject({
    CODEXHOST_SHARED_DATA_DIR: "/custom/shared-host",
    CODEXHOST_DATA_DIR: manifest.dataDirectory,
  });
});
