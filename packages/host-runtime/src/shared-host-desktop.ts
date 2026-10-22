import type { IncomingMessage } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AppServerHost } from "./app-server-host.js";
import { SharedThreadBridge } from "./shared-thread-bridge.js";
import type { SharedThreadOwner } from "./shared-thread-owner.js";
import type { ExternalThreadStore } from "./external-thread-repository.js";
import type { PreparedLocalCodex } from "./native-account-host.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";
import type { DelegationControlRegistration } from "./delegation-types.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
} from "./delegation-types.js";
import type { ModelPriceCatalog } from "./model-prices.js";
import { RuntimeMaintenance } from "./runtime-maintenance.js";
import { consoleEntrypoint, createHostConsoleOpener } from "./console-opener.js";
import { createHostUpdateCoordinator } from "./update-coordinator.js";
import { hasLauncherManagedUpdateRuntime } from "./run-host-runtime.js";

/** Runtime/control context is private to an authenticated Desktop connection. It
 * cannot change the service's data root, native account home or execution owner. */
function desktopContext(
  base: NodeJS.ProcessEnv,
  request?: IncomingMessage,
): { environment: NodeJS.ProcessEnv; arguments: string[] | undefined } {
  const raw = request?.headers["x-codexhost-desktop-context"];
  if (raw === undefined) return { environment: base, arguments: undefined };
  if (typeof raw !== "string" || raw.length > 16_000)
    throw new Error("Invalid Desktop runtime context");
  const value: unknown = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Desktop runtime context");
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 1 ||
    !Array.isArray(envelope.arguments) ||
    !envelope.arguments.every((argument) => typeof argument === "string") ||
    !envelope.environment ||
    typeof envelope.environment !== "object" ||
    Array.isArray(envelope.environment)
  )
    throw new Error("Invalid Desktop runtime context");
  const context: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(envelope.environment)) {
    if (!key.startsWith("CODEXHOST_") || typeof entry !== "string")
      throw new Error("Invalid Desktop runtime context field");
    context[key] = entry;
  }
  return {
    arguments: envelope.arguments as string[],
    environment: {
      ...base,
      ...context,
      CODEXHOST_DATA_DIR: base.CODEXHOST_DATA_DIR,
      CODEX_HOME: base.CODEX_HOME,
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: base[DELEGATION_RUNTIME_ENDPOINT_ENV],
      [DELEGATION_RUNTIME_TOKEN_ENV]: base[DELEGATION_RUNTIME_TOKEN_ENV],
    },
  };
}

export function sharedHostDesktop(
  options: {
    environment: NodeJS.ProcessEnv;
    runtimeUrl: string;
    stockCodex: string;
    official: PreparedLocalCodex;
    owner: SharedThreadOwner;
    store: ExternalThreadStore;
    prices: ModelPriceCatalog;
    delegation(): DelegationControlRegistration | undefined;
    register(api: DelegationControlRegistration): (() => void) | undefined;
    connected: Set<AppServerHost>;
    running: Set<Promise<number>>;
  },
  streams: RemoteAppServerSessionStreams,
  request?: IncomingMessage,
): RemoteAppServerSession {
  const { environment, arguments: nativeArguments } = desktopContext(options.environment, request);
  if (nativeArguments) {
    const stockCodexPath = environment.CODEXHOST_STOCK_CODEX_PATH ?? options.stockCodex;
    if (!path.isAbsolute(stockCodexPath))
      throw new Error("Desktop requires an absolute native Codex executable");
    options.official.configureStartup({ stockCodexPath, arguments: nativeArguments, environment });
  }
  const runtime = environment.CODEXHOST_HOST_RUNTIME_PATH;
  const runtimePath = runtime && path.isAbsolute(runtime) ? runtime : undefined;
  const entry = runtimePath ? consoleEntrypoint(runtimePath) : null;
  const delegation = options.delegation();
  const host = new AppServerHost({
    stockCodexPath: options.stockCodex,
    arguments: [],
    environment,
    desktopInput: streams.input,
    desktopOutput: streams.output,
    diagnosticOutput: streams.diagnosticOutput,
    officialRuntimeScope: options.official.officialRuntimeScope,
    accountControl: options.official.accountControl,
    mappingStore: options.store,
    closeMappingStoreOnExit: false,
    modelPrices: options.prices,
    sharedThreads: new SharedThreadBridge({
      connect: async () => options.owner.connect(),
      delegateCreates: true,
      diagnose: (error) => streams.diagnosticOutput.write(`Shared Host: ${String(error)}\n`),
    }),
    ...(delegation ? { sharedDelegation: delegation } : {}),
    ...installedHarnessPluginOptions(
      environment,
      false,
      runtimePath ? pathToFileURL(runtimePath).href : options.runtimeUrl,
    ),
    ...(runtimePath
      ? { runtimeMaintenance: new RuntimeMaintenance({ runtimePath, remote: false, environment }) }
      : {}),
    ...(runtimePath && hasLauncherManagedUpdateRuntime(environment, runtimePath)
      ? {
          updateCoordinator: createHostUpdateCoordinator({
            hostRuntimePath: runtimePath,
            environment,
          }),
        }
      : {}),
    ...(entry
      ? { consoleOpener: createHostConsoleOpener({ entrypoint: entry, environment }) }
      : {}),
    onDelegationApi: options.register,
  });
  return {
    run: async () => {
      options.connected.add(host);
      const running = host.run();
      options.running.add(running);
      try {
        return await running;
      } finally {
        options.connected.delete(host);
        options.running.delete(running);
      }
    },
    disconnect: () => host.disconnect(),
    close: () => host.close(),
  };
}
