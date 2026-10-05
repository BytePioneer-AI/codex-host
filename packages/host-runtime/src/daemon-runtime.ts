import { setTimeout as delay } from "node:timers/promises";
import { PassThrough, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { AppServerHost } from "./app-server-host.js";
import { startConsoleControlServer, type ConsoleControlServer } from "./console-control-server.js";
import { daemonDesktopSocketPath } from "./daemon-desktop-bridge.js";
import { createDaemonOfficialRuntime } from "./daemon-official-runtime.js";
import {
  createProductionExternalThreadStore,
  createSharedOwnerFrontendStore,
} from "./external-thread-repository.js";
import { startExternalUiServer, type ExternalUiServer } from "./external-ui-server.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import {
  createRemoteAppServerWebSocketListener,
  type RemoteAppServerWebSocketListener,
} from "./remote-app-server.js";
import { SharedThreadBridge, sharedThreadSocketPath } from "./shared-thread-bridge.js";
import { SharedThreadOwner } from "./shared-thread-owner.js";
import { createHostUpdateCoordinator } from "./update-coordinator.js";

export const DAEMON_RUNTIME_ARGUMENT = "--codexhost-daemon";
export const DAEMON_PROCESS_TITLE = "codexhost daemon";

/**
 * Bound a stop-requested shutdown wait: if the app-server child does not settle
 * within this window, the CLI daemon force-exits instead of hanging forever.
 */
const DAEMON_SHUTDOWN_GRACE_MILLIS = 5_000;

export interface RunExternalHarnessDaemonOptions {
  environment: NodeJS.ProcessEnv;
  hostRuntimeUrl?: string;
  diagnosticOutput?: Writable;
  signal?: AbortSignal;
}

/**
 * Long-lived owner for External/Harness Threads and the single Official Codex
 * runtime. External Sessions stay on one SharedThreadOwner; each Desktop gets
 * a lightweight frontend AppServerHost so its native client protocol state is
 * independent while all frontends share the same OfficialRuntimeScope.
 */
export async function runExternalHarnessDaemon(
  options: RunExternalHarnessDaemonOptions,
): Promise<number> {
  const diagnosticOutput = options.diagnosticOutput ?? process.stderr;
  const environment = options.environment;
  const mappingStore = createProductionExternalThreadStore(environment);
  const updateCoordinator = options.hostRuntimeUrl
    ? createHostUpdateCoordinator({
        hostRuntimePath: fileURLToPath(options.hostRuntimeUrl),
        environment,
      })
    : undefined;

  // Mapping Store already has a cross-process PID-aware lock. Acquiring it
  // before publishing either listener gives the daemon a single-instance gate
  // and prevents a failed second daemon from replacing runtime.json.
  await mappingStore.initialize();

  const owner = new SharedThreadOwner();
  const official = await createDaemonOfficialRuntime({
    environment,
    diagnosticOutput,
  });
  const host = new AppServerHost({
    externalOnly: true,
    stockCodexPath: environment.CODEXHOST_STOCK_CODEX_PATH ?? process.execPath,
    arguments: ["app-server"],
    defaultAgent: "codex",
    environment,
    desktopInput: owner.input,
    desktopOutput: owner.output,
    diagnosticOutput,
    ...installedHarnessPluginOptions(environment, false, options.hostRuntimeUrl),
    mappingStore,
    closeMappingStoreOnExit: false,
  });

  const controlInput = new PassThrough();
  const controlOutput = new PassThrough();
  controlOutput.resume();
  const controlHost = new AppServerHost({
    externalOnly: true,
    stockCodexPath: process.execPath,
    arguments: [],
    defaultAgent: "codex",
    environment,
    desktopInput: controlInput,
    desktopOutput: controlOutput,
    diagnosticOutput,
    sharedThreads: new SharedThreadBridge({
      connect: async () => owner.connect(),
      delegateCreates: true,
      diagnose: (error) =>
        diagnosticOutput.write(
          `codexhost daemon console shared Threads: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
    }),
    mappingStore: createSharedOwnerFrontendStore(),
    closeMappingStoreOnExit: false,
    officialRuntimeScope: official.scope,
    accountControl: official.accountControl,
    ...(updateCoordinator ? { updateCoordinator } : {}),
  });
  const controlHostRunning = controlHost.run();
  const attachOfficial = async (attach: {
    stockCodexPath: string;
    arguments: string[];
    defaultAgent: "codex" | "pi";
  }): Promise<void> => {
    await official.attach(attach);
    await controlHost.enableOfficialRuntime(attach.defaultAgent);
  };

  let externalUi: ExternalUiServer | undefined;
  let sharedListener: RemoteAppServerWebSocketListener | undefined;
  let desktopListener: RemoteAppServerWebSocketListener | undefined;
  let consoleControl: ConsoleControlServer | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let signalCount = 0;
  const hostRunning = host.run();

  // Resolves after a stop-requested shutdown finished so runExternalHarnessDaemon
  // can return even when host.run() never settles (e.g. an uncooperative server
  // child keeps its desktop-input loop open).
  const shutdownGate = Promise.withResolvers<undefined>();

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await Promise.allSettled([
        externalUi?.close(),
        sharedListener?.close(),
        desktopListener?.close(),
        consoleControl?.close(),
      ]);
      owner.close();
      host.close();
      controlHost.close();
      // run() settles once its desktop-input loop ends; bound the wait so a
      // stuck child cannot keep the daemon alive indefinitely.
      await Promise.race([
        Promise.allSettled([hostRunning, controlHostRunning]),
        delay(DAEMON_SHUTDOWN_GRACE_MILLIS),
      ]);
      owner.output.end();
      controlOutput.end();
      await official.close().catch((error: unknown) => {
        diagnosticOutput.write(
          `codexhost daemon Official Runtime close: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
      await mappingStore.close().catch((error: unknown) => {
        diagnosticOutput.write(
          `codexhost daemon Mapping Store close: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
      shutdownGate.resolve(undefined);
    })();
    return shutdownPromise;
  };

  const onSignal = (): void => {
    signalCount++;
    if (signalCount > 1) {
      // The first signal already requested a graceful stop; a repeated signal
      // force-exits immediately instead of being silently ignored.
      diagnosticOutput.write("codexhost: daemon forced exit (repeated signal)\n");
      process.exit(130);
      return;
    }

    diagnosticOutput.write("codexhost: daemon shutdown requested\n");
    // Listener close() can wait on sockets independently of host.run(). Bound
    // the whole graceful shutdown so one stuck listener cannot keep the
    // foreground daemon alive forever after Ctrl+C or SIGTERM.
    const forceExitTimer = setTimeout(() => {
      diagnosticOutput.write("codexhost: daemon forced exit (shutdown timed out)\n");
      process.exit(130);
    }, DAEMON_SHUTDOWN_GRACE_MILLIS);
    void shutdown()
      .catch((error: unknown) => {
        diagnosticOutput.write(
          `codexhost daemon shutdown: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .then(() => {
        clearTimeout(forceExitTimer);
        diagnosticOutput.write("codexhost: daemon stopped\n");
        process.exit(0);
      });
  };
  const onAbort = (): void => {
    // Library-safe stop: shutdown() runs and the daemon resolves via
    // shutdownGate; an abort never force-exits the embedding process.
    void shutdown().catch((error: unknown) => {
      diagnosticOutput.write(
        `codexhost daemon shutdown: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (process.platform !== "win32") {
      sharedListener = createRemoteAppServerWebSocketListener({
        socketPath: sharedThreadSocketPath(environment),
        diagnosticOutput,
        createSession: (streams) => owner.createSession(streams),
      });
      await sharedListener.listen();

      desktopListener = createRemoteAppServerWebSocketListener({
        socketPath: daemonDesktopSocketPath(environment),
        diagnosticOutput,
        createSession: ({ input: desktopInput, output: desktopOutput, diagnosticOutput }) =>
          new AppServerHost({
            externalOnly: true,
            stockCodexPath: process.execPath,
            arguments: [],
            defaultAgent: "codex",
            environment,
            desktopInput,
            desktopOutput,
            diagnosticOutput,
            sharedThreads: new SharedThreadBridge({
              connect: async () => owner.connect(),
              delegateCreates: true,
              diagnose: (error) =>
                diagnosticOutput.write(
                  `codexhost daemon shared Threads: ${error instanceof Error ? error.message : String(error)}\n`,
                ),
            }),
            mappingStore: createSharedOwnerFrontendStore(),
            closeMappingStoreOnExit: false,
            officialRuntimeScope: official.scope,
            accountControl: official.accountControl,
            onRuntimeAttach: attachOfficial,
            ...(updateCoordinator ? { updateCoordinator } : {}),
          }),
      });
      await desktopListener.listen();
    }

    externalUi = await startExternalUiServer({
      environment,
      diagnosticOutput,
      createSession: (streams) => owner.createSession(streams),
    });

    consoleControl = await startConsoleControlServer({
      target: controlHost,
      environment,
    }).catch((error: unknown) => {
      diagnosticOutput.write(
        `codexhost daemon console control unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    });

    process.title = DAEMON_PROCESS_TITLE;
    diagnosticOutput.write(
      `codexhost: daemon ready external-ui=ws://${externalUi.descriptor.host}:${externalUi.descriptor.port}${process.platform === "win32" ? "" : ` shared-threads=${sharedThreadSocketPath(environment)} desktop=${daemonDesktopSocketPath(environment)}`}\n`,
    );

    // Race the app-server against stop completion: once a signal (or abort)
    // finished shutdown, return the stop code instead of hanging on run().
    return await Promise.race([hostRunning, shutdownGate.promise.then(() => 0)]);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    options.signal?.removeEventListener("abort", onAbort);
    // Idempotent: shutdown() owns the bounded hostRunning wait, the owner
    // output end, and the Mapping Store close.
    await shutdown().catch((error: unknown) => {
      diagnosticOutput.write(
        `codexhost daemon shutdown: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }
}
