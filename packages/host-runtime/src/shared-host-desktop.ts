import type { IncomingMessage } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AppServerHost } from "./app-server-host.js";
import type { HostExtensionManager } from "./host-extension-manager.js";
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
import { createHostWebOpener } from "./web-opener.js";
import type { HostUpdateCoordinator } from "./update-coordinator.js";
import type { HostReleaseAnnouncement } from "./release-announcement.js";
import {
  isDesktopContextVariable,
  withoutDesktopToolContext,
} from "./desktop-context-environment.js";

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
    if (!isDesktopContextVariable(key) || typeof entry !== "string")
      throw new Error("Invalid Desktop runtime context field");
    context[key] = entry;
  }
  return {
    arguments: envelope.arguments as string[],
    environment: {
      ...withoutDesktopToolContext(base),
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
    hostExtensions?: HostExtensionManager | undefined;
    store: ExternalThreadStore;
    prices: ModelPriceCatalog;
    updateCoordinator?: HostUpdateCoordinator;
    releaseAnnouncement?: HostReleaseAnnouncement;
    delegation(): DelegationControlRegistration | undefined;
    register(api: DelegationControlRegistration): (() => void) | undefined;
    connected: Set<AppServerHost>;
    running: Set<Promise<number>>;
  },
  streams: RemoteAppServerSessionStreams,
  request?: IncomingMessage,
): RemoteAppServerSession {
  const { environment, arguments: nativeArguments } = desktopContext(options.environment, request);
  const stockCodexPath = environment.CODEXHOST_STOCK_CODEX_PATH ?? options.stockCodex;
  if (nativeArguments && !path.isAbsolute(stockCodexPath))
    throw new Error("Desktop requires an absolute native Codex executable");
  const runtime = environment.CODEXHOST_HOST_RUNTIME_PATH;
  const runtimePath = runtime && path.isAbsolute(runtime) ? runtime : undefined;
  const entry = runtimePath ? consoleEntrypoint(runtimePath) : null;
  const delegation = options.delegation();
  const webOpener = createHostWebOpener(options.environment);
  const createHost = () =>
    new AppServerHost({
      stockCodexPath: options.stockCodex,
      arguments: [],
      environment,
      hostExtensions: options.hostExtensions,
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
        ? {
            runtimeMaintenance: new RuntimeMaintenance({ runtimePath, remote: false, environment }),
          }
        : {}),
      ...(options.releaseAnnouncement ? { releaseAnnouncement: options.releaseAnnouncement } : {}),
      ...(options.updateCoordinator ? { updateCoordinator: options.updateCoordinator } : {}),
      ...(entry
        ? { consoleOpener: createHostConsoleOpener({ entrypoint: entry, environment }) }
        : {}),
      ...(webOpener ? { webOpener } : {}),
      onDelegationApi: options.register,
    });
  let host: AppServerHost | undefined;
  const attachment = new AbortController();
  return {
    run: async () => {
      let running: Promise<number> | undefined;
      try {
        if (nativeArguments) {
          await options.official.configureStartup(
            { stockCodexPath, arguments: nativeArguments, environment },
            attachment.signal,
          );
        }
        if (attachment.signal.aborted) return 0;
        host = createHost();
        options.connected.add(host);
        running = host.run();
        options.running.add(running);
        return await running;
      } finally {
        attachment.abort();
        if (host) options.connected.delete(host);
        if (running) options.running.delete(running);
      }
    },
    disconnect: () => {
      attachment.abort();
      host?.disconnect();
    },
    close: () => {
      attachment.abort();
      host?.close();
    },
  };
}
