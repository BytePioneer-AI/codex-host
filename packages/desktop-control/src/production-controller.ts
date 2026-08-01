import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  installRendererControlSession,
  type RendererControlSession,
} from "./renderer-control-session.js";

export interface DesktopControllerOptions {
  inspectorEndpoint: string;
  rendererPath: string;
  defaultAgent: "codex" | "pi";
}

export interface DesktopControllerDependencies {
  readRenderer(filePath: string): Promise<string>;
  install(options: {
    inspectorEndpoint: string;
    rendererSource: string;
    enabledAgents: readonly string[];
    timeoutMs: number;
  }): Promise<RendererControlSession>;
  ready(): void;
  sleep(milliseconds: number): Promise<void>;
  monitorIntervalMs: number;
}

const PRODUCTION_INSTALL_TIMEOUT_MS = 90_000;
const TRANSIENT_INSTALL_ATTEMPTS = 3;
const TRANSIENT_INSTALL_RETRY_MS = 250;

const defaultDependencies: DesktopControllerDependencies = {
  readRenderer: (filePath) => readFile(filePath, "utf8"),
  install: installRendererControlSession,
  ready: () => {
    process.stdout.write("ready\n");
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
    throw new Error(`unknown Desktop Controller option: ${argument}`);
  }
  if (endpoint === undefined) throw new Error("--inspector-endpoint is required");
  if (rendererPath === undefined) throw new Error("--renderer is required");
  if (defaultAgent === undefined) throw new Error("--default-agent is required");
  return { inspectorEndpoint: endpoint, rendererPath, defaultAgent };
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
      enabledAgents: ["codex", "pi"],
      timeoutMs: PRODUCTION_INSTALL_TIMEOUT_MS,
    },
    dependencies,
  );
  try {
    dependencies.ready();
    while (!signal.aborted) {
      await dependencies.sleep(dependencies.monitorIntervalMs);
      if (!signal.aborted) await session.ensureInstalled();
    }
  } finally {
    session.close();
  }
}
