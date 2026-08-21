import { fileURLToPath } from "node:url";

import { UPDATE_RUNTIME_ENV } from "@codexhost/update-manager";

import {
  createExternalHarnessAdapters,
  prefetchClaudeCodeModelCatalog,
} from "./adapter-composition.js";
import { AppServerHost } from "./app-server-host.js";
import { createProductionExternalThreadStore } from "./external-thread-repository.js";
import {
  createRemoteAppServerWebSocketListener,
  isRemoteUnixListenerInvocation,
  remoteAppServerSocketPath,
  remoteUnixListenerUrl,
  stdioArgumentsForRemoteListener,
} from "./remote-app-server.js";
import { createHostUpdateCoordinator, type HostUpdateCoordinator } from "./update-coordinator.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const DEFAULT_AGENT_ENV = "CODEXHOST_DEFAULT_AGENT";

export function hasLauncherManagedUpdateRuntime(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment[UPDATE_RUNTIME_ENV.launcherPid]);
}

function requiredRuntimeConfiguration(environment: NodeJS.ProcessEnv): {
  stockCodexPath: string;
  defaultAgent: "codex" | "pi";
} {
  const stockCodexPath = environment[STOCK_CODEX_PATH_ENV];
  if (!stockCodexPath) throw new Error(`${STOCK_CODEX_PATH_ENV} is required`);
  const defaultAgent = environment[DEFAULT_AGENT_ENV];
  if (defaultAgent !== "codex" && defaultAgent !== "pi") {
    throw new Error(`${DEFAULT_AGENT_ENV} must be 'codex' or 'pi'`);
  }
  return { stockCodexPath, defaultAgent };
}

export async function runHostRuntime(input: {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  hostRuntimeUrl?: string;
  updateCoordinator?: HostUpdateCoordinator;
}): Promise<number> {
  const { stockCodexPath, defaultAgent } = requiredRuntimeConfiguration(input.environment);
  const updateCoordinator =
    input.updateCoordinator ??
    (input.hostRuntimeUrl && hasLauncherManagedUpdateRuntime(input.environment)
      ? createHostUpdateCoordinator({
          hostRuntimePath: fileURLToPath(input.hostRuntimeUrl),
          environment: input.environment,
        })
      : undefined);

  if (!isRemoteUnixListenerInvocation(input.arguments)) {
    const externalAdapters = createExternalHarnessAdapters(input.environment);
    const host = new AppServerHost({
      stockCodexPath,
      arguments: input.arguments,
      defaultAgent,
      environment: input.environment,
      externalAdapters,
      ...(updateCoordinator ? { updateCoordinator } : {}),
    });
    void prefetchClaudeCodeModelCatalog(externalAdapters);
    return host.run();
  }

  if (process.platform === "win32") {
    throw new Error("Remote Unix app-server listener is unavailable on Windows");
  }
  const listenUrl = remoteUnixListenerUrl(input.arguments);
  if (!listenUrl) throw new Error("Remote app-server listener URL is unavailable");
  const socketPath = remoteAppServerSocketPath(input.environment, listenUrl);
  const officialArguments = stdioArgumentsForRemoteListener(input.arguments);
  const mappingStore = createProductionExternalThreadStore(input.environment);
  await mappingStore.initialize();
  const listener = createRemoteAppServerWebSocketListener({
    socketPath,
    diagnosticOutput: process.stderr,
    createSession: ({ input: desktopInput, output: desktopOutput, diagnosticOutput }) => {
      const externalAdapters = createExternalHarnessAdapters(input.environment);
      void prefetchClaudeCodeModelCatalog(externalAdapters);
      return new AppServerHost({
        stockCodexPath,
        arguments: officialArguments,
        defaultAgent,
        environment: input.environment,
        desktopInput,
        desktopOutput,
        diagnosticOutput,
        externalAdapters,
        mappingStore,
        closeMappingStoreOnExit: false,
        ...(updateCoordinator ? { updateCoordinator } : {}),
      });
    },
  });

  const stop = (): void => {
    void listener.close();
  };
  try {
    await listener.listen();
    process.title = "codex app-server desktop-ssh-websocket-v0.sock";
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await listener.closed;
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await listener.close();
    } finally {
      await mappingStore.close();
    }
  }
}
