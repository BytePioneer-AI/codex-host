import path from "node:path";
import { homedir } from "node:os";
import type { Duplex } from "node:stream";
import {
  ensureHostService,
  discoverHostClientChannel,
  type HostServiceLaunch,
} from "@codexhost/desktop-control";
import { WebSocket, createWebSocketStream } from "ws";
import { StreamThreadPeer, type SharedThreadPeer } from "./shared-thread-peer.js";
import { isDesktopContextVariable } from "./desktop-context-environment.js";
import { createDesktopMcpBridge } from "./desktop-mcp-bridge.js";
import {
  CODEX_RUNTIME_REMOVED_MESSAGE,
  CodexRuntimeFilesRemovedError,
} from "./codex-runtime/backend-files.js";

/** Matches both npm payloads and the signed macOS app's Resources/MacOS split. */
export function sharedHostLauncherPath(
  runtime: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (environment.CODEXHOST_LAUNCHER_EXECUTABLE) return environment.CODEXHOST_LAUNCHER_EXECUTABLE;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const root = paths.dirname(paths.dirname(runtime));
  if (
    platform === "darwin" &&
    paths.basename(root) === "Resources" &&
    paths.basename(paths.dirname(root)) === "Contents"
  ) {
    return paths.join(paths.dirname(root), "MacOS", "codexhost");
  }
  return paths.join(root, "bin", platform === "win32" ? "codexhost.exe" : "codexhost");
}

/** Old manifests can inherit an empty variable before remote install refreshes them. */
export function sharedHostDataDirectory(
  environment: NodeJS.ProcessEnv,
  home = environment.HOME ?? environment.USERPROFILE ?? homedir(),
): string {
  const configured = environment.CODEXHOST_SHARED_DATA_DIR;
  if (!configured?.trim()) return path.resolve(home, ".codexhost");
  if (!path.isAbsolute(configured))
    throw new Error("Shared Host data directory must be an absolute path");
  return path.resolve(configured);
}

async function connectStream(
  launch: HostServiceLaunch,
  desktop?: { environment: NodeJS.ProcessEnv; arguments: string[] },
  endpoint = "/v1/desktop",
) {
  await ensureHostService(launch);
  const descriptor = await discoverHostClientChannel(
    path.join(launch.dataDirectory, "client-hosts"),
  );
  if (descriptor?.owner !== "service") throw new Error("Independent Host is unavailable");
  const context = desktop
    ? Buffer.from(
        JSON.stringify({
          version: 1,
          arguments: desktop.arguments,
          environment: Object.fromEntries(
            Object.entries(desktop.environment).filter(
              ([key, value]) => isDesktopContextVariable(key) && value !== undefined,
            ),
          ),
        }),
      ).toString("base64")
    : undefined;
  if (context && context.length > 16_000)
    throw new Error("Desktop runtime context exceeds its transport limit");
  const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}${endpoint}`, {
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      ...(context ? { "x-codexhost-desktop-context": context } : {}),
    },
    // Match native stdio/history capabilities, including responses over 128 MiB.
    handshakeTimeout: 5000,
    maxPayload: 0,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  const stream = createWebSocketStream(socket);
  socket.once("close", (code, reason) => {
    if (code === 1000 || code === 1005) return;
    // Only this fixed authenticated recovery reason is exposed to the Desktop.
    const error =
      code === 1011 && reason.toString() === CODEX_RUNTIME_REMOVED_MESSAGE
        ? new CodexRuntimeFilesRemovedError()
        : new Error("Independent Host connection closed unexpectedly");
    stream.destroy(error);
  });
  socket.on("error", () => stream.destroy());
  return stream;
}

/** Host-private Node client, also used by process-level acceptance tests. */
export async function connectLocalSharedHost(launch: HostServiceLaunch): Promise<SharedThreadPeer> {
  const stream = await connectStream(launch);
  const peer = new StreamThreadPeer(stream, stream, () => stream.destroy());
  stream.on("error", () => peer.close());
  return peer;
}

/** SSH shares external execution with Desktop/Web, without subscribing to native Codex. */
export async function connectLocalSharedExternalHost(
  launch: HostServiceLaunch,
): Promise<SharedThreadPeer> {
  const stream = await connectStream(launch, undefined, "/v1/external");
  const peer = new StreamThreadPeer(stream, stream, () => stream.destroy());
  stream.on("error", () => peer.close());
  return peer;
}

/** Desktop owns its browser MCP children while the shared Host owns task execution. */
export async function runLocalDesktopBridge(
  environment: NodeJS.ProcessEnv,
  runtime: string,
  stockCodex: string,
  arguments_: string[],
): Promise<number> {
  const launcher = environment.CODEXHOST_LAUNCHER_EXECUTABLE;
  if (!launcher || !path.isAbsolute(launcher))
    throw new Error("Independent Host requires the native Launcher");
  const mcp =
    process.platform === "darwin"
      ? await createDesktopMcpBridge({
          runtimePath: runtime,
          native: { executable: stockCodex, arguments: arguments_ },
          nodeReplPath: path.join(path.dirname(process.execPath), "node_repl"),
          environment,
        })
      : undefined;
  let stream: Duplex | undefined;
  try {
    stream = await connectStream(
      {
        launcher,
        runtime,
        stockCodex,
        dataDirectory: path.resolve(
          environment.CODEXHOST_DATA_DIR ?? path.join(homedir(), ".codexhost"),
        ),
        ...(environment.CODEX_HOME ? { codexHome: environment.CODEX_HOME } : {}),
      },
      { environment: { ...environment, ...mcp?.environment }, arguments: arguments_ },
    );
    const connection = stream;
    const closed = new Promise<number>((resolve) => {
      connection.once("error", (error) => {
        if (error instanceof CodexRuntimeFilesRemovedError)
          process.stderr.write(`${error.message}\n`);
        resolve(1);
      });
      connection.once("close", () => resolve(0));
    });
    if (mcp) {
      mcp.input.on("error", (error) => stream?.destroy(error));
      process.stdin.pipe(mcp.input).pipe(stream);
    } else {
      process.stdin.pipe(stream);
    }
    stream.pipe(process.stdout, { end: false });
    return await closed;
  } finally {
    process.stdin.unpipe(mcp?.input ?? stream);
    process.stdin.pause();
    mcp?.input.destroy();
    stream?.unpipe(process.stdout);
    stream?.destroy();
    await mcp?.close();
  }
}
