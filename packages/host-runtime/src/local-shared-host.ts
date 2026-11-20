import path from "node:path";
import { homedir } from "node:os";
import {
  ensureHostService,
  discoverHostClientChannel,
  type HostServiceLaunch,
} from "@codexhost/desktop-control";
import { WebSocket, createWebSocketStream } from "ws";
import { StreamThreadPeer, type SharedThreadPeer } from "./shared-thread-peer.js";

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
              ([key, value]) => key.startsWith("CODEXHOST_") && value !== undefined,
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

/** Desktop's Shim remains a byte-transparent frontend. It owns no Adapter,
 * MappingStore or native Codex backend; closing stdin detaches only this viewer. */
export async function runLocalDesktopBridge(
  environment: NodeJS.ProcessEnv,
  runtime: string,
  stockCodex: string,
  arguments_: string[],
): Promise<number> {
  const launcher = environment.CODEXHOST_LAUNCHER_EXECUTABLE;
  if (!launcher || !path.isAbsolute(launcher))
    throw new Error("Independent Host requires the native Launcher");
  const stream = await connectStream(
    {
      launcher,
      runtime,
      stockCodex,
      dataDirectory: path.resolve(
        environment.CODEXHOST_DATA_DIR ?? path.join(homedir(), ".codexhost"),
      ),
      ...(environment.CODEX_HOME ? { codexHome: environment.CODEX_HOME } : {}),
    },
    { environment, arguments: arguments_ },
  );
  try {
    const closed = new Promise<number>((resolve) => {
      stream.once("error", () => resolve(1));
      stream.once("close", () => resolve(0));
    });
    process.stdin.pipe(stream);
    stream.pipe(process.stdout, { end: false });
    return await closed;
  } finally {
    process.stdin.unpipe(stream);
    stream.unpipe(process.stdout);
    stream.destroy();
  }
}
