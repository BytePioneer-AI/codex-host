import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UPDATE_RUNTIME_ENV } from "@codexhost/update-manager";

import { AppServerHost, officialEnvironment } from "./app-server-host.js";
import { DelegationControlRegistry } from "./delegation-control-registry.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import { startDelegationControlServer } from "./delegation-control-server.js";
import { installDelegationSkills } from "./delegation-skill.js";
import type { DelegationControlRegistration } from "./delegation-types.js";
import {
  DELEGATION_CLI_PATH_ENV,
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
  officialLoopbackListenerArguments,
  officialListenerArgumentsForRemoteListener,
  prepareRemoteAppServerSocketDirectory,
  remoteAppServerSocketPath,
  remoteUnixListenerUrl,
} from "./remote-app-server.js";
import {
  createLoopbackOfficialAppServerListener,
  createRemoteOfficialAppServerListener,
  remoteOfficialAppServerSocketPath,
  type RemoteOfficialAppServerExit,
} from "./remote-official-app-server.js";
import { createRemoteOfficialAppServerConnection } from "./remote-official-connection.js";
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

export function createRemoteControlOfficialAppServerPlan(arguments_: readonly string[]): {
  listenerArguments: string[];
} {
  return { listenerArguments: officialLoopbackListenerArguments(arguments_) };
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

function delegationCliPath(environment: NodeJS.ProcessEnv): string | undefined {
  return environment[DELEGATION_CLI_PATH_ENV] ?? environment.CODEXHOST_LAUNCHER_EXECUTABLE;
}

async function prepareDelegationRuntime(input: {
  environment: NodeJS.ProcessEnv;
  createHost(
    environment: NodeJS.ProcessEnv,
    onDelegationApi: (api: DelegationControlRegistration) => (() => void) | undefined,
    registry: DelegationControlRegistry,
  ): Promise<number>;
}): Promise<number> {
  const registry = new DelegationControlRegistry();
  const token = randomBytes(32).toString("hex");
  const server = await startDelegationControlServer({ token, api: registry });
  const cliPath = delegationCliPath(input.environment);
  const environment = {
    ...input.environment,
    ...(cliPath ? { [DELEGATION_CLI_PATH_ENV]: cliPath } : {}),
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
    await server.close();
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

  if (!isRemoteUnixListenerInvocation(input.arguments)) {
    const remoteControlPlan = createRemoteControlAppServerPlan({
      arguments: input.arguments,
      environment: input.environment,
      ...(hostRuntimePath ? { hostRuntimePath } : {}),
    });
    const environment = remoteControlPlan?.environment ?? input.environment;
    if (!remoteControlPlan) {
      return prepareDelegationRuntime({
        environment,
        createHost: async (delegationEnvironment, onDelegationApi) => {
          const host = new AppServerHost({
            stockCodexPath,
            arguments: input.arguments,
            defaultAgent,
            environment: delegationEnvironment,
            ...installedHarnessPluginOptions(delegationEnvironment, false, input.hostRuntimeUrl),
            onDelegationApi,
            ...(updateCoordinator ? { updateCoordinator } : {}),
          });
          return host.run();
        },
      });
    }

    return prepareDelegationRuntime({
      environment,
      createHost: async (delegationEnvironment, onDelegationApi, registry) => {
        const officialPlan = createRemoteControlOfficialAppServerPlan(
          remoteControlPlan.officialArguments,
        );
        const officialListener = createLoopbackOfficialAppServerListener({
          stockCodexPath,
          arguments: officialPlan.listenerArguments,
          environment: officialEnvironment(delegationEnvironment),
          diagnosticOutput: process.stderr,
        });
        let officialEndpoint: string | null = null;
        const createOfficialConnection = () => {
          if (!officialEndpoint) {
            throw new Error("Shared official app-server endpoint is unavailable");
          }
          return createRemoteOfficialAppServerConnection(officialEndpoint);
        };
        const mappingStore = createProductionExternalThreadStore(delegationEnvironment);
        await mappingStore.initialize();
        const host = new AppServerHost({
          stockCodexPath,
          arguments: input.arguments,
          defaultAgent,
          environment: delegationEnvironment,
          ...installedHarnessPluginOptions(delegationEnvironment, false, input.hostRuntimeUrl),
          mappingStore,
          closeMappingStoreOnExit: false,
          createOfficialConnection,
          onDelegationApi,
          ...(updateCoordinator ? { updateCoordinator } : {}),
        });
        const listener = createRemoteAppServerWebSocketListener({
          socketPath: remoteControlPlan.pipePath,
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
              ...installedHarnessPluginOptions(delegationEnvironment, false, input.hostRuntimeUrl),
              mappingStore,
              closeMappingStoreOnExit: false,
              createOfficialConnection,
              onDelegationApi: (api) => registry.register(api),
              ...(updateCoordinator ? { updateCoordinator } : {}),
            });
          },
        });

        try {
          officialEndpoint = await officialListener.listen();
          await listener.listen();
          await publishRemoteControlAppServerDescriptor(remoteControlPlan);
          return await host.run();
        } finally {
          try {
            await listener.close();
          } finally {
            try {
              await officialListener.close();
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
      const officialListener = createRemoteOfficialAppServerListener({
        stockCodexPath,
        arguments: officialPlan.listenerArguments,
        socketPath: officialPlan.socketPath,
        environment: officialEnvironment(delegationEnvironment),
        diagnosticOutput: process.stderr,
      });
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
            createOfficialConnection: () =>
              createRemoteOfficialAppServerConnection(officialPlan.socketPath),
            onDelegationApi: (api) => registry.register(api),
            ...(updateCoordinator ? { updateCoordinator } : {}),
          });
        },
      });

      let stopping = false;
      const officialState: { unexpectedExit: RemoteOfficialAppServerExit | null } = {
        unexpectedExit: null,
      };
      const stop = (): void => {
        stopping = true;
        void listener.close();
      };
      try {
        await prepareRemoteAppServerSocketDirectory(socketPath);
        await officialListener.listen();
        await listener.listen();
        void officialListener.closed.then((result) => {
          if (stopping) return;
          officialState.unexpectedExit = result;
          void listener.close();
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
            await officialListener.close();
          } finally {
            await mappingStore.close();
          }
        }
      }
    },
  });
}
