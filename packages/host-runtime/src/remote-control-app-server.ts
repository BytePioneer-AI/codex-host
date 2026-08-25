import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { createRemoteOfficialAppServerConnection } from "./remote-official-connection.js";

export const REMOTE_CONTROL_BRIDGE_PIPE_ENV = "CODEXHOST_REMOTE_CONTROL_BRIDGE_PIPE";
export const REMOTE_CONTROL_BRIDGE_NODE_ENV = "CODEXHOST_REMOTE_CONTROL_BRIDGE_NODE_PATH";
export const REMOTE_CONTROL_BRIDGE_RUNTIME_ENV = "CODEXHOST_REMOTE_CONTROL_BRIDGE_RUNTIME_PATH";
export const REMOTE_CONTROL_BRIDGE_DESCRIPTOR_FILE = "remote-control-bridge-v1.json";

const HOST_NODE_PATH_ENV = "CODEXHOST_HOST_NODE_PATH";
const HOST_RUNTIME_PATH_ENV = "CODEXHOST_HOST_RUNTIME_PATH";
const BRIDGE_READY_METHOD = "codexhost/remote-control-bridge/ready";

export interface RemoteControlAppServerPlan {
  pipePath: string;
  descriptorPath: string;
  descriptor: RemoteControlAppServerDescriptorV1;
  environment: NodeJS.ProcessEnv;
  officialArguments: string[];
}

export interface RemoteControlAppServerDescriptorV1 {
  schemaVersion: 1;
  ownerPid: number;
  pipePath: string;
  nodePath: string;
  runtimePath: string;
}

function absoluteEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const value = environment[name] ?? fallback;
  if (!value) return null;
  if (path.isAbsolute(value)) return path.normalize(value);
  return platform === "win32" && path.win32.isAbsolute(value) ? path.win32.normalize(value) : null;
}

/**
 * Node's Windows main-module resolver does not accept Win32 extended-length
 * paths (`\\?\C:\...` or `\\?\UNC\...`) as an entry point. The Shim still
 * validates and owns the canonical path; only the descriptor consumed by the
 * child Node process uses the equivalent conventional Win32 spelling.
 */
export function nodeCompatibleWindowsPath(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

export function remoteControlBridgePipePath(
  processId: number = process.pid,
  instanceId: string = randomUUID(),
): string {
  const safeInstance = instanceId.replaceAll(/[^a-zA-Z0-9-]/gu, "");
  if (!safeInstance) throw new Error("Remote Control bridge instance ID is invalid");
  return `\\\\.\\pipe\\codexhost-remote-control-${processId}-${safeInstance}`;
}

export function remoteControlBridgeDescriptorPath(environment: NodeJS.ProcessEnv): string | null {
  const root = environment.LOCALAPPDATA;
  if (!root || !path.isAbsolute(root)) return null;
  return path.join(path.normalize(root), "codexhost", REMOTE_CONTROL_BRIDGE_DESCRIPTOR_FILE);
}

/**
 * Publishes the current runtime rendezvous atomically. A stale snapshot is safe:
 * its random named pipe stops accepting connections with the owning process and
 * the next Host Runtime replaces the file before serving Remote Control.
 */
export async function publishRemoteControlAppServerDescriptor(
  plan: RemoteControlAppServerPlan,
): Promise<void> {
  const directory = path.dirname(plan.descriptorPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${REMOTE_CONTROL_BRIDGE_DESCRIPTOR_FILE}.${plan.descriptor.ownerPid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(plan.descriptor)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, plan.descriptorPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Creates the private Host-side endpoint advertised only to the stock
 * app-server child. The official Remote Control relay remains responsible for
 * authentication and transport; this endpoint never listens on a network
 * interface.
 */
export function createRemoteControlAppServerPlan(input: {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  hostRuntimePath?: string;
  platform?: NodeJS.Platform;
  processId?: number;
  instanceId?: string;
}): RemoteControlAppServerPlan | null {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return null;
  const absoluteNodePath = absoluteEnvironmentPath(
    input.environment,
    HOST_NODE_PATH_ENV,
    undefined,
    platform,
  );
  const absoluteRuntimePath = absoluteEnvironmentPath(
    input.environment,
    HOST_RUNTIME_PATH_ENV,
    input.hostRuntimePath,
    platform,
  );
  const descriptorPath = remoteControlBridgeDescriptorPath(input.environment);
  if (!absoluteNodePath || !absoluteRuntimePath || !descriptorPath) return null;
  const nodePath = nodeCompatibleWindowsPath(absoluteNodePath);
  const runtimePath = nodeCompatibleWindowsPath(absoluteRuntimePath);
  const ownerPid = input.processId ?? process.pid;
  const pipePath = remoteControlBridgePipePath(ownerPid, input.instanceId);
  return {
    pipePath,
    descriptorPath,
    officialArguments: [...input.arguments],
    descriptor: {
      schemaVersion: 1,
      ownerPid,
      pipePath,
      nodePath,
      runtimePath,
    },
    environment: {
      ...input.environment,
      [REMOTE_CONTROL_BRIDGE_PIPE_ENV]: pipePath,
      [REMOTE_CONTROL_BRIDGE_NODE_ENV]: nodePath,
      [REMOTE_CONTROL_BRIDGE_RUNTIME_ENV]: runtimePath,
    },
  };
}

/**
 * Runs inside a stock app-server process/spawn process on the controlled
 * Windows machine. It adapts LF-delimited app-server frames on stdio to the
 * current Host Runtime's private named-pipe WebSocket.
 */
export async function runRemoteControlAppServerBridge(
  input: {
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const environment = input.environment ?? process.env;
  if (process.platform !== "win32") {
    throw new Error("Remote Control app-server bridge is available only on Windows");
  }
  const pipePath = environment[REMOTE_CONTROL_BRIDGE_PIPE_ENV];
  if (!pipePath?.startsWith("\\\\.\\pipe\\codexhost-remote-control-")) {
    throw new Error(`${REMOTE_CONTROL_BRIDGE_PIPE_ENV} is unavailable or invalid`);
  }

  const connection = await createRemoteOfficialAppServerConnection(pipePath);
  process.title = "codexhost remote-control app-server bridge";
  connection.stderr.pipe(process.stderr, { end: false });
  process.stdout.write(
    `${JSON.stringify({ method: BRIDGE_READY_METHOD, params: { protocolVersion: 1 } })}\n`,
  );
  connection.stdout.pipe(process.stdout, { end: false });
  process.stdin.pipe(connection.stdin);

  const close = (): void => connection.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    const result = await connection.closed;
    if (result.error) throw result.error;
    return result.signal ? 1 : (result.code ?? 1);
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  }
}
