import { writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { discoverHostClientChannel, isHostClientChannelOnline } from "@codexhost/desktop-control";
import { AppServerHost } from "./app-server-host.js";
import { createProductionExternalThreadStore } from "./external-thread-repository.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import { prepareDelegationRuntime } from "./run-host-runtime.js";
import { prepareLocalCodex } from "./native-account-host.js";
import { startClientChannelServer } from "./client-channel-server.js";
import { startConsoleControlServer } from "./console-control-server.js";
import { SharedThreadOwner } from "./shared-thread-owner.js";
import { readNativeWorkspaceSnapshot } from "./native-workspace-snapshot.js";
import { sharedHostDesktop } from "./shared-host-desktop.js";
import type { DelegationControlRegistration } from "./delegation-types.js";
import { watchRemoteListenerSupervisor } from "./remote-listener-supervisor.js";
import { ModelPriceCatalog, defaultModelPriceDirectory } from "./model-prices.js";
import { UsageStatistics } from "./usage-statistics.js";
import {
  createRemoteControlAppServerPlan,
  publishRemoteControlAppServerDescriptor,
} from "./remote-control-app-server.js";
import { createRemoteAppServerWebSocketListener } from "./remote-app-server.js";

/** Rust owns the process tree. This owner outlives every Web/Desktop connection. */
export async function runSharedHostService(
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  runtimeUrl: string,
): Promise<number> {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      data: { type: "string" },
      plugins: { type: "string" },
      "codex-home": { type: "string" },
      "stock-codex": { type: "string" },
      "ready-file": { type: "string" },
      stop: { type: "boolean" },
    },
  });
  if (!values.data || !path.isAbsolute(values.data))
    throw new Error("Shared Host requires an absolute data directory");
  const ready = async (message: string) => {
    const file = values["ready-file"];
    if (!file) return;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, message, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const env = {
    ...environment,
    CODEXHOST_DATA_DIR: values.data,
    CODEX_HOME: values["codex-home"] ?? environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
  };
  const directory = path.join(values.data, "client-hosts");
  const existing = await discoverHostClientChannel(directory);
  if (values.stop) {
    if (!existing || !(await isHostClientChannelOnline(existing))) return 0;
    if (existing.owner !== "service") throw new Error("Refusing to stop a Desktop-owned Host");
    const response = await fetch(`http://127.0.0.1:${existing.port}/v1/shutdown`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${existing.token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Host did not confirm shutdown; do not retry automatically");
    await response.body?.cancel();
    return 0;
  }
  if (existing && (await isHostClientChannelOnline(existing))) {
    if (existing.owner !== "service") {
      await ready("A Desktop-owned Host is running; update and restart it first\n");
      return 1;
    }
    await ready("ready\n");
    return 0;
  }
  const store = createProductionExternalThreadStore(env);
  try {
    await store.initialize();
  } catch (error) {
    await ready(
      `Shared Host could not acquire its store: ${error instanceof Error ? error.message : "initialization failed"}\n`,
    );
    return 1;
  }
  const prices = new ModelPriceCatalog({
    directory: defaultModelPriceDirectory(env),
    diagnose: (message) => process.stderr.write(`${message}\n`),
  });
  void prices.start();
  const usageStatistics = new UsageStatistics({
    directory: path.join(defaultModelPriceDirectory(env), "usage-statistics"),
    prices,
    diagnose: (message) => process.stderr.write(`${message}\n`),
  });
  try {
    return await prepareDelegationRuntime({
      environment: env,
      createHost: async (delegationEnvironment, _register, registry) => {
        const remote = createRemoteControlAppServerPlan({
          arguments: ["app-server"],
          environment: delegationEnvironment,
          hostRuntimePath: environment.CODEXHOST_HOST_RUNTIME_PATH ?? "",
        });
        const hostEnvironment = remote?.environment ?? delegationEnvironment;
        // The same native scope/account control serves every Desktop connection.
        // Web-only use does not start stock Codex or depend on it being installed.
        const official = await prepareLocalCodex({
          stockCodexPath: values["stock-codex"] ?? "",
          arguments: remote?.officialArguments ?? ["app-server"],
          environment: hostEnvironment,
          diagnosticOutput: process.stderr,
          deferStart: true,
        });
        const owner = new SharedThreadOwner();
        const desktops = new Set<AppServerHost>();
        const desktopRuns = new Set<Promise<number>>();
        let delegation: DelegationControlRegistration | undefined;
        const installed = installedHarnessPluginOptions(hostEnvironment, false, runtimeUrl);
        const host = new AppServerHost({
          stockCodexPath: values["stock-codex"] ?? "",
          arguments: [],
          environment: hostEnvironment,
          desktopInput: owner.input,
          desktopOutput: owner.output,
          diagnosticOutput: process.stderr,
          externalOnly: true,
          mappingStore: store,
          closeMappingStoreOnExit: false,
          officialRuntimeScope: official.officialRuntimeScope,
          accountControl: official.accountControl,
          modelPrices: prices,
          usageStatistics,
          ...installed,
          ...(values.plugins
            ? { pluginRoots: [values.plugins, ...installed.pluginRoots.slice(1)] }
            : {}),
          onDelegationApi: (api) => {
            delegation = api;
            return registry.register(api, { harnessCatalog: true });
          },
        });
        const running = host.run();
        let stopping = false;
        const stop = () => {
          stopping = true;
          for (const desktop of desktops) desktop.close();
          host.close();
          owner.close();
        };
        void running.catch(stop);
        const desktopOptions = {
          environment: hostEnvironment,
          runtimeUrl,
          stockCodex: values["stock-codex"] ?? "",
          official,
          owner,
          store,
          prices,
          delegation: () => delegation,
          register: (api: DelegationControlRegistration) => registry.register(api),
          connected: desktops,
          running: desktopRuns,
        };
        let channel: Awaited<ReturnType<typeof startClientChannelServer>> | undefined;
        let console: Awaited<ReturnType<typeof startConsoleControlServer>> | undefined;
        let remoteListener: ReturnType<typeof createRemoteAppServerWebSocketListener> | undefined;
        const supervisor = watchRemoteListenerSupervisor({
          onLost: stop,
          supervisorRequired: true,
        });
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        try {
          channel = await startClientChannelServer({
            environment: env,
            owner: "service",
            shutdown: stop,
            desktopSession: (streams, request) => {
              if (stopping) throw new Error("Shared Host is stopping");
              return sharedHostDesktop(desktopOptions, streams, request);
            },
            target: {
              clientEvents: host.clientEvents,
              handleClientRequest: async (method, params) => {
                if (method !== "codexhost/workspace/read")
                  return host.handleClientRequest(method, params);
                const snapshot = await readNativeWorkspaceSnapshot(env);
                const owned = new Set(
                  (await store.listThreads()).map((thread) => String(thread.hostThreadId)),
                );
                return {
                  result: {
                    ...snapshot,
                    assignments: Object.fromEntries(
                      Object.entries(snapshot.assignments).filter(([id]) => owned.has(id)),
                    ),
                    projectless: snapshot.projectless.filter((id) => owned.has(id)),
                    pinned: snapshot.pinned.filter((id) => owned.has(id)),
                  },
                };
              },
              clientSnapshot: (id) => host.clientSnapshot(id),
              respondClient: (input) => host.respondClient(input),
            },
          });
          console = await startConsoleControlServer({
            environment: env,
            target: {
              handleConsoleRequest: (method, params) =>
                ([...desktops].at(-1) ?? host).handleConsoleRequest(method, params),
            },
          });
          if (remote) {
            remoteListener = createRemoteAppServerWebSocketListener({
              socketPath: remote.pipePath,
              diagnosticOutput: process.stderr,
              createSession: (streams) => sharedHostDesktop(desktopOptions, streams),
            });
            await remoteListener.listen();
            await publishRemoteControlAppServerDescriptor(remote);
          }
          await ready("ready\n");
          return await running;
        } finally {
          supervisor.close();
          process.removeListener("SIGTERM", stop);
          process.removeListener("SIGINT", stop);
          stop();
          await Promise.allSettled([channel?.close(), console?.close(), remoteListener?.close()]);
          try {
            await running;
            await Promise.allSettled([...desktopRuns]);
          } finally {
            owner.output.end();
            await official.close();
          }
        }
      },
    });
  } finally {
    prices.close();
    await store.close();
  }
}
