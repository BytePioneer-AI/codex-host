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

export type DesktopControllerCompatibilityState =
  "compatible" | "compatible-with-warning" | "degraded";

export interface DesktopControllerCompatibilityIssue {
  capability:
    | "title-isolation"
    | "permission-control"
    | "sidebar-decoration"
    | "fork-control"
    | "usage-surface"
    | "settings-surface";
  reason: "unreviewed-title-service-identity" | "capability-unavailable";
  observedIdentity?: string;
}

export interface DesktopControllerReadiness {
  schemaVersion: 2;
  state: DesktopControllerCompatibilityState;
  issues: DesktopControllerCompatibilityIssue[];
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
  now?(): number;
  monitorIntervalMs: number;
}

const PRODUCTION_INSTALL_TIMEOUT_MS = 90_000;
const DESKTOP_CONTROLLER_READINESS_MAX_BYTES = 512;
const TRANSIENT_INSTALL_ATTEMPTS = 3;
const TRANSIENT_INSTALL_RETRY_MS = 250;
const RECOVERY_RETRY_INITIAL_MS = 30_000;
const RECOVERY_RETRY_MAX_MS = 300_000;
const startupTraceStartedAt = Date.now();

function startupTrace(stage: string, detail?: unknown): void {
  if (process.env.CODEXHOST_STARTUP_TRACE !== "1") return;
  const suffix =
    detail === undefined ? "" : `: ${detail instanceof Error ? detail.message : String(detail)}`;
  console.error(
    `[codexhost startup +${Date.now() - startupTraceStartedAt}ms] controller: ${stage}${suffix}`,
  );
}

function validCompatibilityIssue(
  state: DesktopControllerCompatibilityState,
  issue: DesktopControllerCompatibilityIssue,
): boolean {
  const keys = Object.keys(issue);
  if (state === "compatible-with-warning") {
    return (
      issue.capability === "title-isolation" &&
      issue.reason === "unreviewed-title-service-identity" &&
      typeof issue.observedIdentity === "string" &&
      /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(issue.observedIdentity) &&
      keys.length === 3
    );
  }
  if (state === "degraded") {
    return (
      [
        "permission-control",
        "sidebar-decoration",
        "fork-control",
        "usage-surface",
        "settings-surface",
      ].includes(issue.capability) &&
      issue.reason === "capability-unavailable" &&
      issue.observedIdentity === undefined &&
      keys.length === 2
    );
  }
  return false;
}

export function serializeDesktopControllerReadiness(readiness: DesktopControllerReadiness): string {
  if (
    readiness.schemaVersion !== 2 ||
    !["compatible", "compatible-with-warning", "degraded"].includes(readiness.state) ||
    !Array.isArray(readiness.issues) ||
    readiness.issues.length > 1 ||
    (readiness.state === "compatible" && readiness.issues.length !== 0) ||
    (readiness.state !== "compatible" &&
      (readiness.issues.length !== 1 ||
        !readiness.issues[0] ||
        !validCompatibilityIssue(readiness.state, readiness.issues[0]))) ||
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
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Execution context was destroyed") ||
      message.includes("Promise was collected")
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
    if (current === undefined) break;
  }
  return false;
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
  const configuration = `Object.defineProperty(window, "__codexhostProductionConfigV1", { configurable: true, value: { defaultAgent: ${JSON.stringify(options.defaultAgent)} } });`;
  const now = dependencies.now ?? Date.now;
  let session: RendererControlSession | undefined;
  let nextRecoveryAt = 0;
  let recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
  const recordRecoveryFailure = (): void => {
    nextRecoveryAt = now() + recoveryDelayMs;
    recoveryDelayMs = Math.min(recoveryDelayMs * 2, RECOVERY_RETRY_MAX_MS);
  };
  const recordRecoverySuccess = (): void => {
    nextRecoveryAt = 0;
    recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
  };
  const createSession = async (): Promise<RendererControlSession> => {
    startupTrace("reading Renderer bundle");
    const rendererSource = await dependencies.readRenderer(options.rendererPath);
    if (rendererSource.trim().length === 0) throw new Error("production Renderer Bundle is empty");
    startupTrace("installing Renderer Session");
    const installed = await installProductionSession(
      {
        inspectorEndpoint: options.inspectorEndpoint,
        rendererSource: `${configuration}\n${rendererSource}`,
        enabledAgents: ["codex", "pi", "claude-code", "deepseek-harness", "grok"],
        timeoutMs: PRODUCTION_INSTALL_TIMEOUT_MS,
      },
      dependencies,
    );
    startupTrace("Renderer Session installed");
    return installed;
  };
  startupTrace("initialization started");
  try {
    session = await createSession();
    recordRecoverySuccess();
  } catch (error) {
    startupTrace("initial Renderer Session unavailable", error);
    session = undefined;
    recordRecoveryFailure();
  }

  let operation = Promise.resolve<unknown>(undefined);
  const useSession = <T>(callback: () => Promise<T>): Promise<T> => {
    const next = operation.then(callback, callback);
    operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const resetSession = (): void => {
    session?.close();
    session = undefined;
  };
  const ensureSession = async (): Promise<RendererControlSession> => {
    if (!session) session = await createSession();
    else await session.ensureInstalled();
    return session;
  };
  const recoverSession = async (): Promise<RendererControlSession> => {
    try {
      const current = await ensureSession();
      recordRecoverySuccess();
      return current;
    } catch (error) {
      resetSession();
      recordRecoveryFailure();
      throw error;
    }
  };

  let attachmentServer: ControllerAttachmentServer | undefined;
  try {
    startupTrace("starting attachment server");
    attachmentServer = await dependencies.startAttachmentServer({
      port: options.attachmentPort,
      nonce: options.attachmentNonce,
      attach: () =>
        useSession(async () => {
          const current = await recoverSession();
          await current.activateDesktop();
        }),
      compatibilityUpdate: () =>
        useSession(async () => {
          const current = await recoverSession();
          return current.requestCompatibilityUpdate();
        }),
    });
    startupTrace("attachment server ready");
    const issues = session?.snapshot.titlePolicy.warnings ?? [];
    startupTrace("publishing readiness");
    dependencies.ready({
      schemaVersion: 2,
      state: issues.length === 0 ? "compatible" : "compatible-with-warning",
      issues,
    });
    while (!signal.aborted) {
      await dependencies.sleep(dependencies.monitorIntervalMs);
      if (signal.aborted) continue;
      await useSession(async () => {
        if (!session && now() < nextRecoveryAt) return;
        try {
          await recoverSession();
        } catch {
          // Renderer integration remains unavailable until a later bounded retry succeeds.
        }
      });
    }
  } finally {
    await attachmentServer?.close();
    await operation;
    resetSession();
  }
}
