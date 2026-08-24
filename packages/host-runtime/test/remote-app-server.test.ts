import { once } from "node:events";
import type * as FileSystemPromises from "node:fs/promises";
import { chmod, lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { uptime } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

const filesystemFault = vi.hoisted(() => ({
  chmodPath: null as string | null,
  staleLockRacePath: null as string | null,
  staleLockRemovalCount: 0,
  staleLockBothRemovers: Promise.withResolvers<undefined>(),
  staleLockReplacementOpened: Promise.withResolvers<undefined>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FileSystemPromises>();
  return {
    ...original,
    async open(...arguments_: Parameters<typeof original.open>) {
      const handle = await original.open(...arguments_);
      if (
        filesystemFault.staleLockRacePath !== null &&
        path.resolve(arguments_[0].toString()) === filesystemFault.staleLockRacePath &&
        arguments_[1] === "wx" &&
        filesystemFault.staleLockRemovalCount >= 2
      ) {
        filesystemFault.staleLockReplacementOpened.resolve(undefined);
      }
      return handle;
    },
    async rm(...arguments_: Parameters<typeof original.rm>) {
      if (
        filesystemFault.staleLockRacePath !== null &&
        path.resolve(arguments_[0].toString()) === filesystemFault.staleLockRacePath &&
        filesystemFault.staleLockRemovalCount < 2
      ) {
        // Force two legacy reclaimers past their identity checks, then let the
        // second remove the first reclaimer's replacement lock.
        filesystemFault.staleLockRemovalCount += 1;
        const removal = filesystemFault.staleLockRemovalCount;
        if (removal === 2) filesystemFault.staleLockBothRemovers.resolve(undefined);
        await filesystemFault.staleLockBothRemovers.promise;
        if (removal === 2) await filesystemFault.staleLockReplacementOpened.promise;
      }
      return original.rm(...arguments_);
    },
    async chmod(
      filePath: Parameters<typeof original.chmod>[0],
      mode: Parameters<typeof original.chmod>[1],
    ) {
      if (filesystemFault.chmodPath === path.resolve(filePath.toString())) {
        const error = new Error("fixture socket chmod failed") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return original.chmod(filePath, mode);
    },
  };
});

import {
  createRemoteAppServerWebSocketListener,
  isRemoteUnixListenerInvocation,
  officialListenerArgumentsForRemoteListener,
  remoteAppServerSocketPath,
  withRemoteAppServerSocketInitializationLock,
} from "../src/remote-app-server.js";

function testSocketPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codexhost-remote-${process.pid}-${Date.now()}`
    : path.join("/tmp", `ch-${process.pid}-${Date.now()}`, "control.sock");
}

async function withLegacyRemoteSocketInitializationLock<T>(
  socketPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${socketPath}.initializing`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  if (handle === null) throw new Error("Legacy fixture did not acquire its initialization lock");
  try {
    await handle.writeFile(
      `${JSON.stringify({
        version: 1,
        ownerToken: "legacy-fixture",
        pid: process.pid,
        bootTimeSeconds: Math.round(Date.now() / 1_000 - uptime()),
      })}\n`,
      "utf8",
    );
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

describe("remote SSH app-server transport", () => {
  it("classifies only Unix listener app-server invocations", () => {
    expect(
      isRemoteUnixListenerInvocation([
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--listen",
        "unix://",
      ]),
    ).toBe(true);
    expect(isRemoteUnixListenerInvocation(["app-server", "--listen=unix:///tmp/codex.sock"])).toBe(
      true,
    );
    expect(isRemoteUnixListenerInvocation(["app-server", "--stdio"])).toBe(false);
    expect(isRemoteUnixListenerInvocation(["app-server", "proxy"])).toBe(false);
  });

  it("rejects ambiguous app-server invocations with duplicate listeners", () => {
    expect(
      isRemoteUnixListenerInvocation([
        "app-server",
        "--listen",
        "tcp://127.0.0.1:9000",
        "--listen=unix:///tmp/codex.sock",
      ]),
    ).toBe(false);
    expect(
      isRemoteUnixListenerInvocation([
        "app-server",
        "--listen=unix:///tmp/codex.sock",
        "--listen",
        "unix:///tmp/other.sock",
      ]),
    ).toBe(false);
  });

  it("routes every Host session through one shared official listener", () => {
    const incoming = [
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--listen",
      "unix://",
      "--analytics-default-enabled",
    ];

    expect(
      officialListenerArgumentsForRemoteListener(incoming, "/tmp/codexhost-official.sock"),
    ).toEqual([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--listen",
      "unix:///tmp/codexhost-official.sock",
      "--analytics-default-enabled",
    ]);
  });

  it("does not forward public WebSocket authentication to the private listener", () => {
    const incoming = [
      "app-server",
      "--listen=unix://",
      "--ws-auth=signed-bearer-token",
      "--ws-token-file",
      "/tmp/capability-token",
      "--ws-token-sha256=deadbeef",
      "--ws-shared-secret-file",
      "/tmp/shared-secret",
      "--ws-issuer=codexhost",
      "--ws-audience",
      "codex-app-server",
      "--ws-max-clock-skew-seconds=30",
      "--analytics-default-enabled",
    ];

    expect(
      officialListenerArgumentsForRemoteListener(incoming, "/tmp/codexhost-official.sock"),
    ).toEqual([
      "app-server",
      "--listen=unix:///tmp/codexhost-official.sock",
      "--analytics-default-enabled",
    ]);
    expect(incoming).toEqual([
      "app-server",
      "--listen=unix://",
      "--ws-auth=signed-bearer-token",
      "--ws-token-file",
      "/tmp/capability-token",
      "--ws-token-sha256=deadbeef",
      "--ws-shared-secret-file",
      "/tmp/shared-secret",
      "--ws-issuer=codexhost",
      "--ws-audience",
      "codex-app-server",
      "--ws-max-clock-skew-seconds=30",
      "--analytics-default-enabled",
    ]);
  });

  it("uses the Codex control socket under the remote CODEX_HOME", () => {
    expect(
      remoteAppServerSocketPath({ HOME: "/Users/developer", CODEX_HOME: "/tmp/codex-home" }),
    ).toBe("/tmp/codex-home/app-server-control/app-server-control.sock");
  });

  it("bridges WebSocket text frames to one LF-delimited Host session", async () => {
    const socketPath = testSocketPath();
    const diagnosticOutput = new PassThrough();
    let received = "";
    const listener = createRemoteAppServerWebSocketListener({
      socketPath,
      diagnosticOutput,
      createSession: ({ input, output }) => ({
        async run() {
          input.setEncoding("utf8");
          for await (const chunk of input) {
            received += chunk;
            output.write(chunk);
          }
          output.end();
          return 0;
        },
        close: () => undefined,
      }),
    });

    try {
      await listener.listen();
      const client = new WebSocket("ws://localhost/", {
        createConnection: () => net.createConnection(socketPath),
      });
      await once(client, "open");
      client.send('{"id":1,"method":"initialize"}');
      const [message, binary] = (await once(client, "message")) as [Buffer, boolean];
      expect(binary).toBe(false);
      expect(message.toString("utf8")).toBe('{"id":1,"method":"initialize"}');
      expect(received).toBe('{"id":1,"method":"initialize"}\n');
      client.close();
      await once(client, "close");
    } finally {
      await listener.close();
      if (process.platform !== "win32") {
        await rm(path.dirname(socketPath), { recursive: true, force: true });
      }
    }
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes the Host session when its WebSocket disconnects", async () => {
    const socketPath = testSocketPath();
    let finishSession = (): void => undefined;
    const closeSession = vi.fn(() => finishSession());
    const listener = createRemoteAppServerWebSocketListener({
      socketPath,
      diagnosticOutput: new PassThrough(),
      createSession: () => ({
        run: () =>
          new Promise<number>((resolve) => {
            finishSession = () => resolve(0);
          }),
        close: closeSession,
      }),
    });

    try {
      await listener.listen();
      const client = new WebSocket("ws://localhost/", {
        createConnection: () => net.createConnection(socketPath),
      });
      await once(client, "open");
      client.close();
      await once(client, "close");

      await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce());
      await expect(listener.close()).resolves.toBeUndefined();
    } finally {
      finishSession();
      await listener.close();
      if (process.platform !== "win32") {
        await rm(path.dirname(socketPath), { recursive: true, force: true });
      }
    }
  });

  it("does not leak a rejected input cleanup promise when a frame write fails", async () => {
    const socketPath = testSocketPath();
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    let finishSession = (): void => undefined;
    const listener = createRemoteAppServerWebSocketListener({
      socketPath,
      diagnosticOutput: new PassThrough(),
      createSession: ({ input }) => {
        const desktopInput = input as PassThrough;
        desktopInput.write = ((...arguments_: unknown[]) => {
          const callback = arguments_.find(
            (argument): argument is (error?: Error | null) => void =>
              typeof argument === "function",
          );
          queueMicrotask(() => callback?.(new Error("fixture input write failed")));
          return false;
        }) as typeof desktopInput.write;
        return {
          run: () =>
            new Promise<number>((resolve) => {
              finishSession = () => resolve(0);
            }),
          close: () => finishSession(),
        };
      },
    });

    try {
      await listener.listen();
      const client = new WebSocket("ws://localhost/", {
        createConnection: () => net.createConnection(socketPath),
      });
      await once(client, "open");
      client.send('{"id":1,"method":"initialize"}');
      await once(client, "close");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      finishSession();
      await listener.close();
      if (process.platform !== "win32") {
        await rm(path.dirname(socketPath), { recursive: true, force: true });
      }
    }
  });

  it.skipIf(process.platform === "win32")(
    "serializes concurrent initialization of the same control socket",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "ch-lock-"));
      const socketPath = path.join(root, "control.sock");
      let releaseFirst = (): void => undefined;
      let firstEnteredResolve = (): void => undefined;
      const firstEntered = new Promise<void>((resolve) => {
        firstEnteredResolve = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let activeInitializers = 0;
      let maximumActiveInitializers = 0;
      let secondEntered = false;

      try {
        const first = withRemoteAppServerSocketInitializationLock(socketPath, async () => {
          activeInitializers += 1;
          maximumActiveInitializers = Math.max(maximumActiveInitializers, activeInitializers);
          firstEnteredResolve();
          await firstGate;
          activeInitializers -= 1;
        });
        await firstEntered;
        const second = withRemoteAppServerSocketInitializationLock(socketPath, async () => {
          secondEntered = true;
          activeInitializers += 1;
          maximumActiveInitializers = Math.max(maximumActiveInitializers, activeInitializers);
          activeInitializers -= 1;
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 75));
        expect(secondEntered).toBe(false);
        releaseFirst();
        await Promise.all([first, second]);
        expect(secondEntered).toBe(true);
        expect(maximumActiveInitializers).toBe(1);
        await expect(lstat(`${socketPath}.initializing`)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        releaseFirst();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "serializes a legacy initializer that arrives after version 2 enters",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "ch-cross-version-lock-"));
      const socketPath = path.join(root, "control.sock");
      const releaseVersion2 = Promise.withResolvers<undefined>();
      const version2Entered = Promise.withResolvers<undefined>();
      let legacyEntered = false;
      let activeInitializers = 0;
      let maximumActiveInitializers = 0;
      let attempts: Promise<unknown>[] = [];

      try {
        const version2 = withRemoteAppServerSocketInitializationLock(socketPath, async () => {
          activeInitializers += 1;
          maximumActiveInitializers = Math.max(maximumActiveInitializers, activeInitializers);
          version2Entered.resolve(undefined);
          await releaseVersion2.promise;
          activeInitializers -= 1;
        });
        attempts = [version2];
        await version2Entered.promise;

        const legacy = withLegacyRemoteSocketInitializationLock(socketPath, async () => {
          legacyEntered = true;
          activeInitializers += 1;
          maximumActiveInitializers = Math.max(maximumActiveInitializers, activeInitializers);
          activeInitializers -= 1;
        });
        attempts.push(legacy);

        await new Promise<void>((resolve) => setTimeout(resolve, 75));
        expect(legacyEntered).toBe(false);
        releaseVersion2.resolve(undefined);
        await Promise.all(attempts);
        expect(legacyEntered).toBe(true);
        expect(maximumActiveInitializers).toBe(1);
      } finally {
        releaseVersion2.resolve(undefined);
        await Promise.allSettled(attempts);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "recovers an abandoned control-socket initialization lock",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "ch-abandoned-lock-"));
      const socketPath = path.join(root, "control.sock");
      const lockPath = `${socketPath}.initializing`;
      await writeFile(
        lockPath,
        `${JSON.stringify({
          version: 1,
          ownerToken: "abandoned-fixture",
          pid: 2_147_483_647,
          bootTimeSeconds: 0,
        })}\n`,
        { mode: 0o600 },
      );
      let entered = false;

      try {
        await withRemoteAppServerSocketInitializationLock(socketPath, async () => {
          entered = true;
        });

        expect(entered).toBe(true);
        // Version 2 does not unlink the shared legacy path; once validated as
        // abandoned it is inert and cannot participate in ownership.
        expect((await lstat(lockPath)).isFile()).toBe(true);
        expect(await readdir(`${socketPath}.initializers`)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "serializes concurrent recovery of the same abandoned initialization lock",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "ch-abandoned-lock-race-"));
      const socketPath = path.join(root, "control.sock");
      const lockPath = `${socketPath}.initializing`;
      await writeFile(
        lockPath,
        `${JSON.stringify({
          version: 1,
          ownerToken: "abandoned-race-fixture",
          pid: 2_147_483_647,
          bootTimeSeconds: 0,
        })}\n`,
        { mode: 0o600 },
      );
      const release = Promise.withResolvers<undefined>();
      let activeInitializers = 0;
      let maximumActiveInitializers = 0;
      let attempts: Promise<undefined>[] = [];

      filesystemFault.staleLockRacePath = path.resolve(lockPath);
      filesystemFault.staleLockRemovalCount = 0;
      filesystemFault.staleLockBothRemovers = Promise.withResolvers<undefined>();
      filesystemFault.staleLockReplacementOpened = Promise.withResolvers<undefined>();
      const action = async (): Promise<undefined> => {
        activeInitializers += 1;
        maximumActiveInitializers = Math.max(maximumActiveInitializers, activeInitializers);
        await release.promise;
        activeInitializers -= 1;
        return undefined;
      };

      try {
        const first = withRemoteAppServerSocketInitializationLock(socketPath, action);
        const second = withRemoteAppServerSocketInitializationLock(socketPath, action);
        attempts = [first, second];
        await vi.waitFor(() => expect(activeInitializers).toBeGreaterThan(0));
        await new Promise<void>((resolve) => setTimeout(resolve, 75));

        expect(maximumActiveInitializers).toBe(1);
        release.resolve(undefined);
        await Promise.all([first, second]);
        expect(maximumActiveInitializers).toBe(1);
      } finally {
        release.resolve(undefined);
        await Promise.allSettled(attempts);
        filesystemFault.staleLockRacePath = null;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not unlink a replacement socket while prior sessions settle",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "ch-replacement-"));
      const socketPath = path.join(root, "control.sock");
      let finishFirstSession = (): void => undefined;
      const first = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: new PassThrough(),
        createSession: () => ({
          run: () =>
            new Promise<number>((resolve) => {
              finishFirstSession = () => resolve(0);
            }),
          close: () => undefined,
        }),
      });
      const replacement = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: new PassThrough(),
        createSession: ({ output }) => ({
          run: async () => {
            output.end();
            return 0;
          },
          close: () => undefined,
        }),
      });
      let firstClosing: Promise<void> | null = null;

      try {
        await first.listen();
        const firstClient = new WebSocket("ws://localhost/", {
          createConnection: () => net.createConnection(socketPath),
        });
        await once(firstClient, "open");
        const firstClientClosed = once(firstClient, "close");
        firstClosing = first.close();
        await firstClientClosed;

        let inactive = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (!(await socketAcceptsConnections(socketPath))) {
            inactive = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(inactive).toBe(true);
        await replacement.listen();

        finishFirstSession();
        await firstClosing;
        const replacementClient = new WebSocket("ws://localhost/", {
          createConnection: () => net.createConnection(socketPath),
        });
        await once(replacementClient, "open");
        replacementClient.close();
        await once(replacementClient, "close");
      } finally {
        finishFirstSession();
        await Promise.allSettled([firstClosing ?? first.close(), replacement.close()]);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "makes an existing control-socket directory private",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "ch-mode-"));
      const socketPath = path.join(root, "control.sock");
      await chmod(root, 0o755);
      const listener = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: new PassThrough(),
        createSession: () => ({ run: async () => 0, close: () => undefined }),
      });

      try {
        await listener.listen();
        expect((await lstat(root)).mode & 0o777).toBe(0o700);
      } finally {
        await listener.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "closes a bound server when socket permission hardening fails",
    async () => {
      const root = await mkdtemp(path.join("/tmp", "ch-chmod-"));
      const socketPath = path.join(root, "control.sock");
      const serverClose = vi.spyOn(net.Server.prototype, "close");
      const listener = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: new PassThrough(),
        createSession: () => ({ run: async () => 0, close: () => undefined }),
      });

      try {
        filesystemFault.chmodPath = path.resolve(socketPath);
        await expect(listener.listen()).rejects.toMatchObject({ code: "EPERM" });
        filesystemFault.chmodPath = null;
        await expect(listener.close()).resolves.toBeUndefined();
        expect(serverClose).toHaveBeenCalledOnce();
      } finally {
        filesystemFault.chmodPath = null;
        serverClose.mockRestore();
        await listener.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to place the control socket directly in a shared temporary directory",
    async () => {
      const socketPath = path.join("/tmp", `codexhost-shared-${process.pid}-${Date.now()}.sock`);
      const listener = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: new PassThrough(),
        createSession: () => ({ run: async () => 0, close: () => undefined }),
      });

      await expect(listener.listen()).rejects.toThrow("requires a private directory");
      await listener.close();
    },
  );
});
