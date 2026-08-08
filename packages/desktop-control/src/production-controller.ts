import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  startControllerAttachmentServer,
  type ControllerAttachmentServer,
  type StartControllerAttachmentServerOptions,
} from "./controller-attachment-server.js";
import {
  installRendererControlSession,
  type RendererControlSession,
} from "./renderer-control-session.js";

export interface DesktopControllerOptions {
  inspectorEndpoint: string;
  rendererPath: string;
  defaultAgent: "codex" | "pi";
  attachmentPort: number;
  attachmentNonce: string;
}

export interface DesktopControllerCompatibilityWarning {
  capability: "title-isolation";
  reason: "unreviewed-title-service-identity";
  observedIdentity: string;
}

export interface DesktopControllerReadiness {
  schemaVersion: 1;
  state: "ready";
  warnings: DesktopControllerCompatibilityWarning[];
}

export interface DesktopControllerDependencies {
  readRenderer(filePath: string): Promise<string>;
  install(options: {
    inspectorEndpoint: string;
    rendererSource: string;
    enabledAgents: readonly string[];
    timeoutMs: number;
  }): Promise<RendererControlSession>;
  startAttachmentServer(
    options: StartControllerAttachmentServerOptions,
  ): Promise<ControllerAttachmentServer>;
  ready(readiness: DesktopControllerReadiness): void;
  sleep(milliseconds: number): Promise<void>;
  monitorIntervalMs: number;
}

const PRODUCTION_INSTALL_TIMEOUT_MS = 90_000;
const DESKTOP_CONTROLLER_READINESS_MAX_BYTES = 512;
const TRANSIENT_INSTALL_ATTEMPTS = 3;
const TRANSIENT_INSTALL_RETRY_MS = 250;

export function serializeDesktopControllerReadiness(readiness: DesktopControllerReadiness): string {
  if (
    readiness.schemaVersion !== 1 ||
    readiness.state !== "ready" ||
    !Array.isArray(readiness.warnings) ||
    readiness.warnings.length > 1 ||
    readiness.warnings.some(
      (warning) =>
        warning.capability !== "title-isolation" ||
        warning.reason !== "unreviewed-title-service-identity" ||
        !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(warning.observedIdentity) ||
        Object.keys(warning).length !== 3,
    ) ||
    Object.keys(readiness).length !== 3
  ) {
    throw new Error("Desktop Controller readiness is invalid");
  }
  const line = JSON.stringify(readiness);
  if (Buffer.byteLength(line, "utf8") > DESKTOP_CONTROLLER_READINESS_MAX_BYTES) {
    throw new Error("Desktop Controller readiness exceeds its size limit");
  }
  return line;
}

const defaultDependencies: DesktopControllerDependencies = {
  readRenderer: (filePath) => readFile(filePath, "utf8"),
  install: installRendererControlSession,
  startAttachmentServer: startControllerAttachmentServer,
  ready: (readiness) => {
    process.stdout.write(`${serializeDesktopControllerReadiness(readiness)}\n`);
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  monitorIntervalMs: 500,
};

function inspectorEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("--inspector-endpoint must be a loopback HTTP origin with an explicit port");
  }
  return url.origin;
}

export function parseDesktopControllerArguments(
  arguments_: readonly string[],
): DesktopControllerOptions {
  let endpoint: string | undefined;
  let rendererPath: string | undefined;
  let defaultAgent: "codex" | "pi" | undefined;
  let attachmentPort: number | undefined;
  let attachmentNonce: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--inspector-endpoint") {
      if (endpoint !== undefined) throw new Error("--inspector-endpoint may only be provided once");
      if (!value) throw new Error("--inspector-endpoint requires a value");
      endpoint = inspectorEndpoint(value);
      index += 1;
      continue;
    }
    if (argument === "--renderer") {
      if (rendererPath !== undefined) throw new Error("--renderer may only be provided once");
      if (!value) throw new Error("--renderer requires a value");
      if (!path.isAbsolute(value)) throw new Error("--renderer must be an absolute path");
      rendererPath = path.normalize(value);
      index += 1;
      continue;
    }
    if (argument === "--default-agent") {
      if (defaultAgent !== undefined) throw new Error("--default-agent may only be provided once");
      if (value !== "codex" && value !== "pi") {
        throw new Error("--default-agent must be 'codex' or 'pi'");
      }
      defaultAgent = value;
      index += 1;
      continue;
    }
    if (argument === "--attachment-port") {
      if (attachmentPort !== undefined) {
        throw new Error("--attachment-port may only be provided once");
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--attachment-port must be a valid TCP port");
      }
      attachmentPort = port;
      index += 1;
      continue;
    }
    if (argument === "--attachment-nonce") {
      if (attachmentNonce !== undefined) {
        throw new Error("--attachment-nonce may only be provided once");
      }
      if (value === undefined || !/^[0-9a-f]{32}$/.test(value)) {
        throw new Error("--attachment-nonce must be 32 lowercase hexadecimal characters");
      }
      attachmentNonce = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown Desktop Controller option: ${argument}`);
  }
  if (endpoint === undefined) throw new Error("--inspector-endpoint is required");
  if (rendererPath === undefined) throw new Error("--renderer is required");
  if (defaultAgent === undefined) throw new Error("--default-agent is required");
  if (attachmentPort === undefined) throw new Error("--attachment-port is required");
  if (attachmentNonce === undefined) throw new Error("--attachment-nonce is required");
  return {
    inspectorEndpoint: endpoint,
    rendererPath,
    defaultAgent,
    attachmentPort,
    attachmentNonce,
  };
}

function isTransientElectronInstallError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Uncaught (in promise)") ||
    message.includes("Execution context was destroyed") ||
    message.includes("Promise was collected")
  );
}

async function installProductionSession(
  options: Parameters<DesktopControllerDependencies["install"]>[0],
  dependencies: DesktopControllerDependencies,
): Promise<RendererControlSession> {
  for (let attempt = 1; attempt <= TRANSIENT_INSTALL_ATTEMPTS; attempt += 1) {
    try {
      return await dependencies.install(options);
    } catch (error) {
      if (attempt === TRANSIENT_INSTALL_ATTEMPTS || !isTransientElectronInstallError(error)) {
        throw error;
      }
      await dependencies.sleep(TRANSIENT_INSTALL_RETRY_MS);
    }
  }
  throw new Error("Desktop Controller exhausted Renderer installation attempts");
}

export async function runDesktopController(
  options: DesktopControllerOptions,
  signal: AbortSignal,
  dependencies: DesktopControllerDependencies = defaultDependencies,
): Promise<void> {
  const rendererSource = await dependencies.readRenderer(options.rendererPath);
  if (rendererSource.trim().length === 0) throw new Error("production Renderer Bundle is empty");
  const configuration = `Object.defineProperty(window, "__codexhostProductionConfigV1", { configurable: true, value: { defaultAgent: ${JSON.stringify(options.defaultAgent)} } });`;
  const session = await installProductionSession(
    {
      inspectorEndpoint: options.inspectorEndpoint,
      rendererSource: `${configuration}\n${rendererSource}`,
      enabledAgents: ["codex", "pi", "claude-code"],
      timeoutMs: PRODUCTION_INSTALL_TIMEOUT_MS,
    },
    dependencies,
  );
  let operation = Promise.resolve<unknown>(undefined);
  const useSession = <T>(callback: () => Promise<T>): Promise<T> => {
    const next = operation.then(callback, callback);
    operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  let attachmentServer: ControllerAttachmentServer | undefined;
  try {
    attachmentServer = await dependencies.startAttachmentServer({
      port: options.attachmentPort,
      nonce: options.attachmentNonce,
      attach: () =>
        useSession(async () => {
          await session.ensureInstalled();
          await session.activateDesktop();
        }),
      compatibilityUpdate: () =>
        useSession(async () => {
          await session.ensureInstalled();
          return session.requestCompatibilityUpdate();
        }),
      shutdown: () => useSession(() => session.quitDesktop()),
    });
    dependencies.ready({
      schemaVersion: 1,
      state: "ready",
      warnings: session.snapshot.titlePolicy.warnings,
    });
    while (!signal.aborted) {
      await dependencies.sleep(dependencies.monitorIntervalMs);
      if (!signal.aborted) await useSession(() => session.ensureInstalled());
    }
  } finally {
    await attachmentServer?.close();
    await operation;
    session.close();
  }
}
