import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";

import WebSocket from "ws";

import {
  inspectRemoteHostInstallation,
  type RemoteHostInstallationStatus,
  type RemoteHostInstallOptions,
  type RemoteHostManifestV1,
} from "./remote-host-install.js";

const CODEXHOST_STATUS_METHOD = "codexhost/update/status";
const DIRECT_PROBE_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 12_000;

export interface RemoteHostRuntimeStatus {
  state: "stopped" | "running" | "conflict" | "unknown";
  socketPath: string;
  protocol?: "codexhost" | "stock-codex" | "unknown";
  message?: string;
}

export type RemoteHostStatus = RemoteHostInstallationStatus & {
  runtime: RemoteHostRuntimeStatus;
};

export interface RemoteHostLifecycleResult {
  state: "running" | "stopped";
  changed: boolean;
  socketPath: string;
  replacedStockCodex?: boolean;
}

interface RemoteHostProbeResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export function classifyRemoteHostProbeResponse(
  response: RemoteHostProbeResponse,
  socketPath: string,
): RemoteHostRuntimeStatus | null {
  if (response.id !== 1) return null;
  const message = typeof response.error?.message === "string" ? response.error.message : "";
  if (message.includes(`unknown variant \`${CODEXHOST_STATUS_METHOD}\``)) {
    return { state: "conflict", socketPath, protocol: "stock-codex" };
  }
  if (response.result !== undefined || response.error?.code === -32090) {
    return { state: "running", socketPath, protocol: "codexhost" };
  }
  return null;
}

interface RemoteHostLifecycleDependencies {
  inspectInstallation(options: RemoteHostInstallOptions): Promise<RemoteHostInstallationStatus>;
  probeProtocol(
    manifest: RemoteHostManifestV1,
    socketPath: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<RemoteHostRuntimeStatus>;
  runTerminator(
    manifest: RemoteHostManifestV1,
    socketPath: string,
    role: "stock" | "managed",
    environment: NodeJS.ProcessEnv,
  ): Promise<void>;
  launch(manifest: RemoteHostManifestV1, environment: NodeJS.ProcessEnv): void;
  waitForRuntime(
    manifest: RemoteHostManifestV1,
    socketPath: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<RemoteHostRuntimeStatus>;
  socketExists(socketPath: string): Promise<boolean>;
}

let lifecycleDependencyOverrides: Partial<RemoteHostLifecycleDependencies> = {};

function socketPathFor(environment: NodeJS.ProcessEnv): string {
  const codexHome =
    environment.CODEX_HOME ??
    (environment.HOME ? path.join(environment.HOME, ".codex") : undefined);
  if (!codexHome) throw new Error("CODEX_HOME or HOME is required for remote Host lifecycle");
  return path.join(codexHome, "app-server-control", "app-server-control.sock");
}

async function defaultSocketExists(socketPath: string): Promise<boolean> {
  const metadata = await stat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return metadata?.isSocket() === true;
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function probeWebSocket(input: {
  socketPath: string;
  createConnection: () => Duplex;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<RemoteHostRuntimeStatus> {
  const socket = new WebSocket("ws://localhost/", { createConnection: input.createConnection });
  try {
    return await new Promise<RemoteHostRuntimeStatus>((resolve) => {
      let settled = false;
      const finish = (status: RemoteHostRuntimeStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(status);
      };
      const timeout = setTimeout(
        () =>
          finish({
            state: "unknown",
            socketPath: input.socketPath,
            protocol: "unknown",
            message: input.timeoutMessage,
          }),
        input.timeoutMs,
      );
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: CODEXHOST_STATUS_METHOD,
            params: {},
          }),
        );
      });
      socket.once("message", (data, isBinary) => {
        if (isBinary) {
          finish({
            state: "unknown",
            socketPath: input.socketPath,
            protocol: "unknown",
            message: "Binary response",
          });
          return;
        }
        try {
          const response = JSON.parse(data.toString("utf8")) as RemoteHostProbeResponse;
          const classification = classifyRemoteHostProbeResponse(response, input.socketPath);
          if (classification) finish(classification);
        } catch (error) {
          finish({
            state: "unknown",
            socketPath: input.socketPath,
            protocol: "unknown",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      socket.once("error", (error) =>
        finish({
          state: "unknown",
          socketPath: input.socketPath,
          protocol: "unknown",
          message: error.message,
        }),
      );
    });
  } finally {
    if (socket.readyState === socket.OPEN) socket.close();
    else socket.terminate();
  }
}

async function probeProtocol(
  manifest: RemoteHostManifestV1,
  socketPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<RemoteHostRuntimeStatus> {
  if (!(await defaultSocketExists(socketPath))) return { state: "stopped", socketPath };
  const direct = await probeWebSocket({
    socketPath,
    createConnection: () => net.createConnection(socketPath),
    timeoutMs: DIRECT_PROBE_TIMEOUT_MS,
    timeoutMessage: "Remote Host direct WebSocket probe timed out",
  });
  if (direct.state !== "unknown") return direct;

  const proxy = spawn(manifest.stockCodexPath, ["app-server", "proxy", "--sock", socketPath], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  proxy.stderr.setEncoding("utf8");
  proxy.stderr.on("data", (chunk: string) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-2_000);
  });
  const tunnel = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
  try {
    return await probeWebSocket({
      socketPath,
      createConnection: () => tunnel,
      timeoutMs: PROBE_TIMEOUT_MS,
      timeoutMessage: diagnostics || "Remote Host protocol probe timed out",
    });
  } finally {
    await stopChild(proxy);
  }
}

function installedManifest(status: RemoteHostInstallationStatus): RemoteHostManifestV1 {
  if (status.state === "not-installed") {
    throw new Error("Remote Host is not installed. Run: codexhost remote install");
  }
  if (status.state === "degraded") {
    throw new Error(`Remote Host installation is degraded: ${status.issues.join("; ")}`);
  }
  return status;
}

function managedEnvironment(
  manifest: RemoteHostManifestV1,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    CODEX_INSTALL_DIR: path.dirname(manifest.wrapperPath),
    CODEXHOST_STOCK_CODEX_PATH: manifest.stockCodexPath,
    CODEXHOST_HOST_NODE_PATH: manifest.nodePath,
    CODEXHOST_HOST_RUNTIME_PATH: manifest.hostRuntimePath,
    CODEXHOST_DATA_DIR: manifest.dataDirectory,
    CODEXHOST_DEFAULT_AGENT: "codex",
    CODEXHOST_REMOTE_SSH_MANAGED: "1",
    ...(manifest.claudeCommand ? { CODEXHOST_CLAUDE_COMMAND: manifest.claudeCommand } : {}),
    PATH: `${path.dirname(manifest.wrapperPath)}${path.delimiter}${path.dirname(manifest.stockCodexPath)}${path.delimiter}${environment.PATH ?? "/usr/bin:/bin"}`,
  };
}

async function defaultRunTerminator(
  manifest: RemoteHostManifestV1,
  socketPath: string,
  role: "stock" | "managed",
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn(
    manifest.shimPath,
    [
      "--codexhost-remote-terminate",
      role,
      "--socket",
      socketPath,
      "--stock-codex",
      manifest.stockCodexPath,
      "--node",
      manifest.nodePath,
      "--host-runtime",
      manifest.hostRuntimePath,
    ],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(
      (stderr || stdout || `Remote ${role} listener termination failed with code ${code}`).trim(),
    );
  }
}

async function defaultWaitForRuntime(
  manifest: RemoteHostManifestV1,
  socketPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<RemoteHostRuntimeStatus> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last: RemoteHostRuntimeStatus = { state: "stopped", socketPath };
  while (Date.now() < deadline) {
    last = await dependencies().probeProtocol(manifest, socketPath, environment);
    if (last.state === "running") return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(last.message ?? `Remote Host did not become ready at ${socketPath}`);
}

function defaultLaunch(manifest: RemoteHostManifestV1, environment: NodeJS.ProcessEnv): void {
  const child = spawn(
    manifest.wrapperPath,
    ["-c", "features.code_mode_host=true", "app-server", "--listen", "unix://"],
    { env: managedEnvironment(manifest, environment), stdio: "ignore", detached: true },
  );
  child.unref();
}

function dependencies(): RemoteHostLifecycleDependencies {
  return {
    inspectInstallation: inspectRemoteHostInstallation,
    probeProtocol,
    runTerminator: defaultRunTerminator,
    launch: defaultLaunch,
    waitForRuntime: defaultWaitForRuntime,
    socketExists: defaultSocketExists,
    ...lifecycleDependencyOverrides,
  };
}

export function setRemoteHostLifecycleDependenciesForTest(
  overrides: Partial<RemoteHostLifecycleDependencies>,
): () => void {
  const previous = lifecycleDependencyOverrides;
  lifecycleDependencyOverrides = overrides;
  return () => {
    lifecycleDependencyOverrides = previous;
  };
}

export async function inspectRemoteHost(
  options: RemoteHostInstallOptions,
): Promise<RemoteHostStatus> {
  const environment = options.environment ?? process.env;
  const lifecycle = dependencies();
  const installation = await lifecycle.inspectInstallation(options);
  const socketPath = socketPathFor(environment);
  if (installation.state === "not-installed") {
    return { ...installation, runtime: { state: "stopped", socketPath } };
  }
  return {
    ...installation,
    runtime: await lifecycle.probeProtocol(installation, socketPath, environment),
  };
}

export async function startRemoteHost(
  options: RemoteHostInstallOptions,
): Promise<RemoteHostLifecycleResult> {
  const environment = options.environment ?? process.env;
  if ((options.platform ?? process.platform) === "win32") {
    throw new Error("Remote Host lifecycle must run on the macOS or Linux SSH host");
  }
  const lifecycle = dependencies();
  const manifest = installedManifest(await lifecycle.inspectInstallation(options));
  const socketPath = socketPathFor(environment);
  const current = await lifecycle.probeProtocol(manifest, socketPath, environment);
  if (current.state === "running") {
    return { state: "running", changed: false, socketPath };
  }
  let replacedStockCodex = false;
  if (current.state !== "stopped") {
    if (current.protocol !== "stock-codex") {
      throw new Error(current.message ?? `Unknown process owns Remote Host socket ${socketPath}`);
    }
    await lifecycle.runTerminator(manifest, socketPath, "stock", environment);
    replacedStockCodex = true;
  }
  lifecycle.launch(manifest, environment);
  await lifecycle.waitForRuntime(manifest, socketPath, environment);
  return { state: "running", changed: true, socketPath, replacedStockCodex };
}

export async function stopRemoteHost(
  options: RemoteHostInstallOptions,
): Promise<RemoteHostLifecycleResult> {
  const environment = options.environment ?? process.env;
  if ((options.platform ?? process.platform) === "win32") {
    throw new Error("Remote Host lifecycle must run on the macOS or Linux SSH host");
  }
  const lifecycle = dependencies();
  const manifest = installedManifest(await lifecycle.inspectInstallation(options));
  const socketPath = socketPathFor(environment);
  const current = await lifecycle.probeProtocol(manifest, socketPath, environment);
  if (current.state === "stopped") return { state: "stopped", changed: false, socketPath };
  if (current.state !== "running") {
    throw new Error(
      current.message ?? `Remote Host socket is not owned by codexhost: ${socketPath}`,
    );
  }
  await lifecycle.runTerminator(manifest, socketPath, "managed", environment);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (await lifecycle.socketExists(socketPath)) {
    if (Date.now() >= deadline) throw new Error(`Remote Host socket did not close: ${socketPath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { state: "stopped", changed: true, socketPath };
}
