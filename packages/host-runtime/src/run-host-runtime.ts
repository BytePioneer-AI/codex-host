import { randomBytes } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { UPDATE_RUNTIME_ENV } from "@codexhost/update-manager";

import { AppServerHost, officialEnvironment } from "./app-server-host.js";
import { prepareLocalCodex } from "./native-account-host.js";
import { SingleNativeCodexAccount } from "./account/codex-account-control.js";
import { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import { createOwnedUnixBackend } from "./codex-runtime/owned-official-backends.js";
import { DelegationControlRegistry } from "./delegation-control-registry.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import { startDelegationControlServer } from "./delegation-control-server.js";
import { delegationCliEnvironment } from "./delegation-cli-invocation.js";
import { installDelegationSkills } from "./delegation-skill.js";
import type { DelegationControlRegistration } from "./delegation-types.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
} from "./delegation-types.js";
import { createProductionExternalThreadStore } from "./external-thread-repository.js";
import {
  createRemoteControlAppServerPlan,
  publishRemoteControlAppServerDescriptor,
} from "./remote-control-app-server.js";
import {
  createRemoteAppServerWebSocketListener,
  isRemoteUnixListenerInvocation,
  officialListenerArgumentsForRemoteListener,
  prepareRemoteAppServerSocketDirectory,
  remoteAppServerSocketPath,
  remoteUnixListenerUrl,
} from "./remote-app-server.js";
import { remoteOfficialAppServerSocketPath } from "./remote-official-app-server.js";
import { startConsoleControlServer } from "./console-control-server.js";
import { consoleEntrypoint, createHostConsoleOpener } from "./console-opener.js";
import { createHostUpdateCoordinator, type HostUpdateCoordinator } from "./update-coordinator.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const DEFAULT_AGENT_ENV = "CODEXHOST_DEFAULT_AGENT";
export const MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE = "codexhost remote app-server listener";

export function createRemoteOfficialAppServerPlan(
  arguments_: readonly string[],
  desktopControlSocketPath: string,
  token?: string,
): {
  socketPath: string;
  listenerArguments: string[];
} {
  const socketPath = remoteOfficialAppServerSocketPath(desktopControlSocketPath, token);
  return {
    socketPath,
    listenerArguments: officialListenerArgumentsForRemoteListener(arguments_, socketPath),
  };
}

export function hasLauncherManagedUpdateRuntime(
  environment: NodeJS.ProcessEnv,
  hostRuntimePath?: string,
): boolean {
  if (!environment[UPDATE_RUNTIME_ENV.launcherPid]) return false;
  const npmPackageRoot = environment[UPDATE_RUNTIME_ENV.npmPackageRoot];
  if (!npmPackageRoot || !hostRuntimePath) return true;
  if (!path.isAbsolute(npmPackageRoot) || !path.isAbsolute(hostRuntimePath)) return false;
  const runtimePackageRoot = path.dirname(path.dirname(path.normalize(hostRuntimePath)));
  return path.relative(path.normalize(npmPackageRoot), runtimePackageRoot) === "";
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

async function prepareDelegationRuntime(input: {
  environment: NodeJS.ProcessEnv;
  createHost(
    environment: NodeJS.ProcessEnv,
    onDelegationApi: (api: DelegationControlRegistration) => (() => void) | undefined,
    registry: DelegationControlRegistry,
  ): Promise<number>;
}): Promise<number> {
  const registry = new DelegationControlRegistry({
    diagnose: (error) =>
      process.stderr.write(
        `codexhost delegation watch: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      ),
  });
  const token = randomBytes(32).toString("hex");
  const server = await startDelegationControlServer({ token, api: registry, watchApi: registry });
  const environment = {
    ...input.environment,
    ...delegationCliEnvironment(input.environment),
    [DELEGATION_RUNTIME_ENDPOINT_ENV]: server.endpoint,
    [DELEGATION_RUNTIME_TOKEN_ENV]: token,
  };
  await installDelegationSkills()
    .then((results) => {
      for (const result of results) {
        if (result.status === "conflict") {
          process.stderr.write(
            `codexhost delegation Skill conflict: preserving user-managed file at ${result.path}\n`,
          );
        }
      }
    })
    .catch((error) => {
      process.stderr.write(`codexhost delegation Skill installation failed: ${String(error)}\n`);
    });
  try {
    return await input.createHost(environment, (value) => registry.register(value), registry);
  } finally {
    registry.close();
    await server.close();
  }
}

/**
 * Exposes the Desktop-facing Host to the local console while it runs. Only the
 * Launcher-started local Host does; the channel is best effort.
 */
async function runWithConsoleControl(
  host: AppServerHost,
  enabled: boolean,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const control = enabled
    ? await startConsoleControlServer({ target: host, environment }).catch((error: unknown) => {
        process.stderr.write(
          `codexhost Host Runtime: console channel unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return undefined;
      })
    : undefined;
  try {
    return await host.run();
  } finally {
    await control?.close().catch(() => undefined);
  }
}

export async function runHostRuntime(input: {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  hostRuntimeUrl?: string;
  updateCoordinator?: HostUpdateCoordinator;
}): Promise<number> {
  const { stockCodexPath, defaultAgent } = requiredRuntimeConfiguration(input.environment);
  const hostRuntimePath = input.hostRuntimeUrl ? fileURLToPath(input.hostRuntimeUrl) : undefined;
  const updateCoordinator =
    input.updateCoordinator ??
    (hostRuntimePath && hasLauncherManagedUpdateRuntime(input.environment, hostRuntimePath)
      ? createHostUpdateCoordinator({
          hostRuntimePath,
          environment: input.environment,
        })
      : undefined);
  // Only a Launcher-started local Host can open the console on this machine.
  // The development entry does not pass its URL; the Launcher still exports the path.
  const consoleHostRuntimePath = hostRuntimePath ?? input.environment.CODEXHOST_HOST_RUNTIME_PATH;
  const consoleEntry =
    consoleHostRuntimePath &&
    path.isAbsolute(consoleHostRuntimePath) &&
    input.environment.CODEXHOST_LAUNCHER_EXECUTABLE &&
    input.environment.CODEXHOST_REMOTE_SSH_MANAGED !== "1"
      ? consoleEntrypoint(consoleHostRuntimePath)
      : null;
  const consoleOpener = consoleEntry
    ? createHostConsoleOpener({ entrypoint: consoleEntry, environment: input.environment })
    : undefined;

  if (!isRemoteUnixListenerInvocation(input.arguments)) {
    const remoteControlPlan = createRemoteControlAppServerPlan({
      arguments: input.arguments,
      environment: input.environment,
      ...(hostRuntimePath ? { hostRuntimePath } : {}),
    });
    const environment = remoteControlPlan?.environment ?? input.environment;
    return prepareDelegationRuntime({
      environment,
      createHost: async (delegationEnvironment, onDelegationApi, registry) => {
        const official = await prepareLocalCodex({
          stockCodexPath,
          arguments: remoteControlPlan?.officialArguments ?? input.arguments,
          environment: delegationEnvironment,
          diagnosticOutput: process.stderr,
        });
        const shared = {
          officialRuntimeScope: official.officialRuntimeScope,
          accountControl: official.accountControl,
        };
        if (!remoteControlPlan) {
          try {
            const host = new AppServerHost({
              stockCodexPath,
              arguments: input.arguments,
              defaultAgent,
              environment: delegationEnvironment,
              ...shared,
              ...installedHarnessPluginOptions(delegationEnvironment, false, input.hostRuntimeUrl),
              onDelegationApi,
              ...(updateCoordinator ? { updateCoordinator } : {}),
              ...(consoleOpener ? { consoleOpener } : {}),
            });
            return await runWithConsoleControl(
              host,
              consoleOpener !== undefined,
              delegationEnvironment,
            );
          } finally {
            await official.close();
          }
        }
        const mappingStore = createProductionExternalThreadStore(delegationEnvironment);
        let listener: ReturnType<typeof createRemoteAppServerWebSocketListener> | undefined;
        try {
          await mappingStore.initialize();
          const common = {
            stockCodexPath,
            defaultAgent,
            environment: delegationEnvironment,
            ...shared,
            ...installedHarnessPluginOptions(delegationEnvironment, false, input.hostRuntimeUrl),
            mappingStore,
            closeMappingStoreOnExit: false,
            ...(updateCoordinator ? { updateCoordinator } : {}),
            ...(consoleOpener ? { consoleOpener } : {}),
          };
          const host = new AppServerHost({
            ...common,
            arguments: input.arguments,
            onDelegationApi,
          });
          listener = createRemoteAppServerWebSocketListener({
            socketPath: remoteControlPlan.pipePath,
            diagnosticOutput: process.stderr,
            createSession: ({ input: desktopInput, output: desktopOutput, diagnosticOutput }) =>
              new AppServerHost({
                ...common,
                arguments: [],
                desktopInput,
                desktopOutput,
                diagnosticOutput,
                onDelegationApi: (api) => registry.register(api),
              }),
          });
          await listener.listen();
          await publishRemoteControlAppServerDescriptor(remoteControlPlan);
          // Official failure/replacement must never close this listener or external Harnesses.
          return await runWithConsoleControl(
            host,
            consoleOpener !== undefined,
            delegationEnvironment,
          );
        } finally {
          try {
            await listener?.close();
          } finally {
            try {
              await official.close();
            } finally {
              await mappingStore.close();
            }
          }
        }
      },
    });
  }

  if (process.platform === "win32") {
    throw new Error("Remote Unix app-server listener is unavailable on Windows");
  }
  const listenUrl = remoteUnixListenerUrl(input.arguments);
  if (!listenUrl) throw new Error("Remote app-server listener URL is unavailable");
  return prepareDelegationRuntime({
    environment: input.environment,
    createHost: async (delegationEnvironment, _onDelegationApi, registry) => {
      const socketPath = remoteAppServerSocketPath(delegationEnvironment, listenUrl);
      const officialPlan = createRemoteOfficialAppServerPlan(input.arguments, socketPath);
      const officialRuntimeScope = new OfficialRuntimeScope({
        permanentHome: path.resolve(
          delegationEnvironment.CODEX_HOME ?? path.join(homedir(), ".codex"),
        ),
        diagnosticOutput: process.stderr,
        createBackend: () =>
          createOwnedUnixBackend({
            stockCodexPath,
            arguments: officialPlan.listenerArguments,
            socketPath: officialPlan.socketPath,
            environment: officialEnvironment(delegationEnvironment),
            diagnosticOutput: process.stderr,
          }),
      });
      const accountControl = new SingleNativeCodexAccount(() => ({
        version: 2,
        currentAccountId: "remote-native",
        phase: officialRuntimeScope.gate.phase,
        revision: officialRuntimeScope.gate.revision,
        accounts: [{ accountId: "remote-native", label: "Remote native Codex Account" }],
      }));
      const mappingStore = createProductionExternalThreadStore(delegationEnvironment);
      await mappingStore.initialize();
      const listener = createRemoteAppServerWebSocketListener({
        socketPath,
        diagnosticOutput: process.stderr,
        createSession: ({ input: desktopInput, output: desktopOutput, diagnosticOutput }) => {
          return new AppServerHost({
            stockCodexPath,
            arguments: [],
            defaultAgent,
            environment: delegationEnvironment,
            desktopInput,
            desktopOutput,
            diagnosticOutput,
            ...installedHarnessPluginOptions(delegationEnvironment, true, input.hostRuntimeUrl),
            mappingStore,
            closeMappingStoreOnExit: false,
            officialRuntimeScope,
            accountControl,
            onDelegationApi: (api) => registry.register(api),
            ...(updateCoordinator ? { updateCoordinator } : {}),
          });
        },
      });

      let stopping = false;
      const officialState: { unexpectedExit: Error | null } = { unexpectedExit: null };
      const stop = (): void => {
        stopping = true;
        void listener.close();
      };
      try {
        await prepareRemoteAppServerSocketDirectory(socketPath);
        await officialRuntimeScope.start().catch(() => {
          officialRuntimeScope.gate.unavailable();
        });
        await listener.listen();
        void officialRuntimeScope.failure().then((result) => {
          if (!stopping) officialState.unexpectedExit = result;
          // Keep remote external Harness sessions alive when only native Codex fails.
        });
        process.title = MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE;
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await listener.closed;
        return officialState.unexpectedExit ? 1 : 0;
      } finally {
        stopping = true;
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        try {
          await listener.close();
        } finally {
          try {
            await officialRuntimeScope.close();
          } finally {
            await mappingStore.close();
          }
        }
      }
    },
  });
}
