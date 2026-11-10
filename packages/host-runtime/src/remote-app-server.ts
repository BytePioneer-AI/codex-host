import { createServer, type Server as HttpServer } from "node:http";
import net from "node:net";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { attachRemoteAppServerSession } from "./remote-app-server-session.js";

import { WebSocketServer } from "ws";

import { withRemoteAppServerSocketInitializationLock } from "./remote-socket-lock.js";

export { withRemoteAppServerSocketInitializationLock } from "./remote-socket-lock.js";

const APP_SERVER_WEBSOCKET_AUTH_VALUE_OPTIONS = new Set([
  "--ws-auth",
  "--ws-token-file",
  "--ws-token-sha256",
  "--ws-shared-secret-file",
  "--ws-issuer",
  "--ws-audience",
  "--ws-max-clock-skew-seconds",
]);
const APP_SERVER_VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--code-mode-host",
  "--listen",
  ...APP_SERVER_WEBSOCKET_AUTH_VALUE_OPTIONS,
]);
const APP_SERVER_FLAG_OPTIONS = new Set([
  "--strict-config",
  "--stdio",
  "--analytics-default-enabled",
]);

export interface RemoteAppServerSession {
  run(): Promise<number>;
  /** Ends remote Desktop input without cancelling active work. */
  disconnect(): void;
  /** Requests hard cancellation synchronously; run settles after owned resources are released. */
  close(): void;
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
  let listenerSeen = false;
  for (let index = appServerIndex + 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) return null;
    if (argument === "--listen") {
      if (listenerSeen) return null;
      const value = arguments_[index + 1];
      if (!value) return null;
      listenerSeen = true;
      listener = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--listen=")) {
      if (listenerSeen) return null;
      listenerSeen = true;
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

export function officialListenerArgumentsForRemoteListener(
  arguments_: readonly string[],
  socketPath: string,
): string[] {
  if (!path.posix.isAbsolute(socketPath)) {
    throw new Error("Shared official app-server socket path must be absolute");
  }
  if (remoteUnixListenerUrl(arguments_) === null) {
    throw new Error("Expected a Unix listener app-server invocation");
  }
  const appServerIndex = appServerSubcommandIndex(arguments_);
  if (appServerIndex === null) throw new Error("Expected an app-server invocation");
  const result = arguments_.slice(0, appServerIndex + 1);
  const listenUrl = `unix://${socketPath}`;
  let listenerRewritten = false;
  for (let index = appServerIndex + 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument && APP_SERVER_WEBSOCKET_AUTH_VALUE_OPTIONS.has(argument)) {
      // The public listener already authenticated the remote Desktop client.
      // This second listener is an internal hop bound to a current-user-only
      // socket, so retaining public WebSocket auth would reject Host's private
      // connection unless it replayed the caller's secret.
      index += 1;
      continue;
    }
    if (
      argument &&
      [...APP_SERVER_WEBSOCKET_AUTH_VALUE_OPTIONS].some((option) =>
        argument.startsWith(`${option}=`),
      )
    ) {
      continue;
    }
    if (argument === "--listen") {
      result.push("--listen", listenUrl);
      listenerRewritten = true;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--listen=")) {
      result.push(`--listen=${listenUrl}`);
      listenerRewritten = true;
      continue;
    }
    if (argument) result.push(argument);
  }
  if (listenerRewritten) return result;
  throw new Error("Unix listener invocation omitted --listen");
}

export function officialLoopbackListenerArguments(arguments_: readonly string[]): string[] {
  const appServerIndex = appServerSubcommandIndex(arguments_);
  if (appServerIndex === null) throw new Error("Expected an app-server invocation");
  const result = [...arguments_.slice(0, appServerIndex + 1), "--listen", "ws://127.0.0.1:0"];
  for (let index = appServerIndex + 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) throw new Error("Expected an app-server option");
    if (argument === "--listen" || APP_SERVER_WEBSOCKET_AUTH_VALUE_OPTIONS.has(argument)) {
      index += 1;
      if (index >= arguments_.length) throw new Error(`${argument} requires a value`);
      continue;
    }
    if (
      argument.startsWith("--listen=") ||
      [...APP_SERVER_WEBSOCKET_AUTH_VALUE_OPTIONS].some((option) =>
        argument.startsWith(`${option}=`),
      ) ||
      argument === "--stdio"
    ) {
      continue;
    }
    if (APP_SERVER_VALUE_OPTIONS.has(argument)) {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      result.push(argument, value);
      index += 1;
      continue;
    }
    if (
      [...APP_SERVER_VALUE_OPTIONS].some((option) => argument.startsWith(`${option}=`)) ||
      APP_SERVER_FLAG_OPTIONS.has(argument)
    ) {
      result.push(argument);
      continue;
    }
    throw new Error(`Unsupported app-server argument for a shared listener: ${argument}`);
  }
  return result;
}

interface UnixFileIdentity {
  dev: number;
  ino: number;
}

async function unixSocketIdentity(socketPath: string): Promise<UnixFileIdentity | null> {
  const metadata = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return metadata?.isSocket() ? { dev: metadata.dev, ino: metadata.ino } : null;
}

function sameUnixFileIdentity(left: UnixFileIdentity, right: UnixFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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

export async function prepareRemoteAppServerSocketDirectory(socketPath: string): Promise<void> {
  const socketDirectory = path.dirname(socketPath);
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
  const sessionClosers = new Set<() => void>();
  let listening = false;
  let ownedSocketIdentity: UnixFileIdentity | null = null;
  let listenAttempt: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  const closed = Promise.withResolvers<undefined>();

  webSockets.on("connection", (socket) => {
    const session = attachRemoteAppServerSession({
      socket,
      diagnosticOutput: input.diagnosticOutput,
      createSession: input.createSession,
    });
    const running = session.running.finally(() => {
      sessions.delete(running);
      sessionClosers.delete(session.close);
    });
    sessions.add(running);
    sessionClosers.add(session.close);
  });

  return {
    closed: closed.promise,
    async listen() {
      if (closing) throw new Error("Remote app-server listener is closed");
      if (listening) return;
      // Concurrent callers share one bind, so close() always waits for the
      // attempt that can still bind the server.
      if (listenAttempt) return listenAttempt;
      const bind = async (): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once("error", onError);
          server.listen(input.socketPath, () => {
            server.off("error", onError);
            resolve();
          });
        });
        listening = true;
        if (process.platform !== "win32") {
          await chmod(input.socketPath, 0o600);
          ownedSocketIdentity = await unixSocketIdentity(input.socketPath);
          if (ownedSocketIdentity === null) {
            throw new Error(
              `Remote app-server listener did not create a socket: ${input.socketPath}`,
            );
          }
        }
      };
      const attempt = (async () => {
        if (process.platform !== "win32") {
          await prepareRemoteAppServerSocketDirectory(input.socketPath);
          await withRemoteAppServerSocketInitializationLock(input.socketPath, async () => {
            await removeStaleSocket(input.socketPath);
            await bind();
          });
        } else {
          await bind();
        }
      })();
      listenAttempt = attempt;
      try {
        await attempt;
      } catch (error) {
        // A failed attempt may be retried; a successful one stays for close().
        if (listenAttempt === attempt) listenAttempt = null;
        throw error;
      }
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        // A listen() in flight may still bind. Let it settle so the bound server
        // and its socket are released below instead of outliving close().
        await listenAttempt?.catch(() => undefined);
        const closingSessions = [...sessions];
        for (const closeSession of sessionClosers) closeSession();
        for (const socket of webSockets.clients) socket.terminate();
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        const closeServer = async (): Promise<void> => {
          if (!listening) return;
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        };
        if (process.platform !== "win32" && listening) {
          // Node unlinks a Unix socket as part of closing its server. Keep that
          // operation and any explicit cleanup in the same critical section as
          // a replacement listener's stale-socket removal and bind.
          await withRemoteAppServerSocketInitializationLock(input.socketPath, async () => {
            await closeServer();
            if (ownedSocketIdentity) {
              const current = await unixSocketIdentity(input.socketPath);
              if (current && sameUnixFileIdentity(current, ownedSocketIdentity)) {
                await rm(input.socketPath, { force: true });
              }
              ownedSocketIdentity = null;
            }
          });
        } else {
          await closeServer();
        }
        await Promise.allSettled(closingSessions);
        closed.resolve(undefined);
      })();
      return closing;
    },
  };
}
