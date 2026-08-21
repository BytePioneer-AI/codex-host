import { createServer, type Server as HttpServer } from "node:http";
import net from "node:net";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

const APP_SERVER_VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--listen",
  "--ws-auth",
  "--ws-token-file",
  "--ws-token-sha256",
  "--ws-shared-secret-file",
  "--ws-issuer",
  "--ws-audience",
  "--ws-max-clock-skew-seconds",
]);
const APP_SERVER_FLAG_OPTIONS = new Set([
  "--strict-config",
  "--stdio",
  "--analytics-default-enabled",
]);

export interface RemoteAppServerSession {
  run(): Promise<number>;
}

export interface RemoteAppServerSessionStreams {
  input: Readable;
  output: Writable;
  diagnosticOutput: Writable;
}

export interface RemoteAppServerWebSocketListener {
  readonly closed: Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function appServerSubcommandIndex(arguments_: readonly string[]): number | null {
  const globalValueOptions = new Set([
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--remote",
    "--remote-auth-token-env",
    "-m",
    "--model",
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
  ]);
  const globalFlags = new Set([
    "--strict-config",
    "--oss",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "app-server") return index;
    if (argument && globalValueOptions.has(argument)) {
      index += 1;
      if (index >= arguments_.length) return null;
      continue;
    }
    if (
      argument &&
      ([...globalValueOptions].some((option) => argument.startsWith(`${option}=`)) ||
        globalFlags.has(argument))
    ) {
      continue;
    }
    return null;
  }
  return null;
}

export function remoteUnixListenerUrl(arguments_: readonly string[]): string | null {
  const appServerIndex = appServerSubcommandIndex(arguments_);
  if (appServerIndex === null) return null;
  let listener: string | null = null;
  for (let index = appServerIndex + 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) return null;
    if (argument === "--listen") {
      const value = arguments_[index + 1];
      if (!value) return null;
      listener = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--listen=")) {
      listener = argument.slice("--listen=".length);
      continue;
    }
    if (APP_SERVER_VALUE_OPTIONS.has(argument)) {
      index += 1;
      if (index >= arguments_.length) return null;
      continue;
    }
    if (
      [...APP_SERVER_VALUE_OPTIONS].some((option) => argument.startsWith(`${option}=`)) ||
      APP_SERVER_FLAG_OPTIONS.has(argument)
    ) {
      continue;
    }
    return null;
  }
  return listener?.startsWith("unix://") ? listener : null;
}

export function isRemoteUnixListenerInvocation(arguments_: readonly string[]): boolean {
  return remoteUnixListenerUrl(arguments_) !== null;
}

export function remoteAppServerSocketPath(
  environment: NodeJS.ProcessEnv,
  listenUrl = "unix://",
): string {
  if (!listenUrl.startsWith("unix://")) {
    throw new Error("Remote app-server listener must use a Unix URL");
  }
  const explicit = listenUrl.slice("unix://".length);
  if (explicit.length > 0) return path.posix.resolve(decodeURIComponent(explicit));
  const codexHome =
    environment.CODEX_HOME ??
    (environment.HOME ? path.posix.join(environment.HOME, ".codex") : undefined);
  if (!codexHome)
    throw new Error("CODEX_HOME or HOME is required for the remote app-server socket");
  return path.posix.join(codexHome, "app-server-control", "app-server-control.sock");
}

export function stdioArgumentsForRemoteListener(arguments_: readonly string[]): string[] {
  if (remoteUnixListenerUrl(arguments_) === null) {
    throw new Error("Expected a Unix listener app-server invocation");
  }
  const result = [...arguments_];
  const appServerIndex = appServerSubcommandIndex(result);
  if (appServerIndex === null) throw new Error("Expected an app-server invocation");
  for (let index = appServerIndex + 1; index < result.length; index += 1) {
    const argument = result[index];
    if (argument === "--listen") {
      result.splice(index, 2, "--stdio");
      return result;
    }
    if (argument?.startsWith("--listen=")) {
      result.splice(index, 1, "--stdio");
      return result;
    }
  }
  throw new Error("Unix listener invocation omitted --listen");
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("Unsupported WebSocket frame payload");
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const metadata = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return;
  if (!metadata.isSocket()) {
    throw new Error(`Remote app-server path exists and is not a socket: ${socketPath}`);
  }
  const active = await new Promise<boolean>((resolve, reject) => {
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
  if (active) throw new Error(`Remote app-server socket is already in use at ${socketPath}`);
  await rm(socketPath, { force: true });
}

async function preparePrivateSocketDirectory(socketDirectory: string): Promise<void> {
  const existing = await lstat(socketDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    const ownedByCurrentUser =
      typeof process.getuid !== "function" || existing.uid === process.getuid();
    const sharedTemporaryDirectory = (existing.mode & 0o1000) !== 0;
    if (!existing.isDirectory() || !ownedByCurrentUser || sharedTemporaryDirectory) {
      throw new Error(
        `Remote app-server socket requires a private directory owned by the current user: ${socketDirectory}`,
      );
    }
  }
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  await chmod(socketDirectory, 0o700);
}

function sendOutputFrames(socket: WebSocket, output: PassThrough): void {
  let pending = Buffer.alloc(0);
  output.on("data", (chunk: Buffer | string) => {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const frame = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (socket.readyState === socket.OPEN) socket.send(frame, { binary: false });
    }
  });
  output.once("end", () => {
    if (pending.length > 0 && socket.readyState === socket.OPEN) {
      socket.close(1011, "Host Runtime emitted an incomplete frame");
    } else if (socket.readyState === socket.OPEN) {
      socket.close(1000);
    }
  });
}

export function createRemoteAppServerWebSocketListener(input: {
  socketPath: string;
  diagnosticOutput: Writable;
  createSession(streams: RemoteAppServerSessionStreams): RemoteAppServerSession;
}): RemoteAppServerWebSocketListener {
  const server: HttpServer = createServer((_request, response) => {
    response.writeHead(426, { Connection: "Upgrade", Upgrade: "websocket" });
    response.end();
  });
  const webSockets = new WebSocketServer({ server, maxPayload: 128 * 1024 * 1024 });
  webSockets.on("error", (error) => {
    input.diagnosticOutput.write(`codexhost remote WebSocket server: ${error.message}\n`);
  });
  const sessions = new Set<Promise<unknown>>();
  let listening = false;
  let closing: Promise<void> | null = null;
  const closed = Promise.withResolvers<undefined>();

  webSockets.on("connection", (socket) => {
    const desktopInput = new PassThrough();
    const desktopOutput = new PassThrough();
    const session = input.createSession({
      input: desktopInput,
      output: desktopOutput,
      diagnosticOutput: input.diagnosticOutput,
    });
    sendOutputFrames(socket, desktopOutput);
    let inputTail = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Codex app-server messages must be text");
        return;
      }
      const frame = rawDataBuffer(data);
      inputTail = inputTail.then(
        () =>
          new Promise<void>((resolve, reject) => {
            desktopInput.write(Buffer.concat([frame, Buffer.from("\n")]), (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      );
      void inputTail.catch(() => socket.close(1011, "Host Runtime input failed"));
    });
    socket.once("close", () => {
      void inputTail.finally(() => desktopInput.end());
    });
    socket.once("error", () => desktopInput.destroy());
    const running = session
      .run()
      .then((code) => {
        if (code !== 0 && socket.readyState === socket.OPEN) {
          socket.close(1011, "Host Runtime exited");
        }
      })
      .catch((error: unknown) => {
        input.diagnosticOutput.write(
          `codexhost remote app-server: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (socket.readyState === socket.OPEN) socket.close(1011, "Host Runtime failed");
      })
      .finally(() => {
        desktopOutput.end();
        sessions.delete(running);
      });
    sessions.add(running);
  });

  return {
    closed: closed.promise,
    async listen() {
      if (listening) return;
      if (process.platform !== "win32") {
        const socketDirectory = path.dirname(input.socketPath);
        await preparePrivateSocketDirectory(socketDirectory);
        await removeStaleSocket(input.socketPath);
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(input.socketPath, () => {
          server.off("error", onError);
          resolve();
        });
      });
      if (process.platform !== "win32") await chmod(input.socketPath, 0o600);
      listening = true;
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        for (const socket of webSockets.clients) socket.terminate();
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        if (listening) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
        await Promise.allSettled(sessions);
        if (process.platform !== "win32") await rm(input.socketPath, { force: true });
        closed.resolve(undefined);
      })();
      return closing;
    },
  };
}
