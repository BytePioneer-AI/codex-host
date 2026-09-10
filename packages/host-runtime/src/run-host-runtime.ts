import { randomBytes } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { UPDATE_RUNTIME_ENV } from "@codexhost/update-manager";

import { AppServerHost, officialEnvironment } from "./app-server-host.js";
import { CodexCredentialFiles } from "./account/codex-credential-files.js";
import { FileCredentialSwitchJournal } from "./account/credential-switch-journal.js";
import {
  adoptLegacyAccountLayout,
  canAdoptLegacyLayout,
  inspectLegacyAccountLayout,
} from "./account/legacy-account-layout.js";
import { CodexAccountSwitcher } from "./account/codex-account-switcher.js";
import {
  ManagedCodexAccounts,
  SingleNativeCodexAccount,
  UnavailableCodexAccounts,
} from "./account/managed-codex-accounts.js";
import { ManagedCodexAccountQuotas } from "./account/managed-codex-account-quotas.js";
import { OfficialAccountRuntime } from "./account/official-account-runtime.js";
import { SavedCodexAccounts } from "./account/saved-codex-accounts.js";
import { readOfficialCliVersion } from "./codex-runtime/official-cli-version.js";
import { OfficialProcessRecord } from "./codex-runtime/official-process-record.js";
import {
  createSharedConnectionBackend,
  OfficialRuntimeScope,
} from "./codex-runtime/official-runtime-scope.js";
import {
  createOwnedLoopbackBackend,
  createOwnedStdioBackend,
} from "./codex-runtime/owned-official-backends.js";
import { NativePrivateFiles } from "./native-private-files.js";
import { readNativeProcessIdentity } from "./native-process-identity.js";
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
  createRemoteOfficialAppServerListener,
  remoteOfficialAppServerSocketPath,
  type RemoteOfficialAppServerExit,
} from "./remote-official-app-server.js";
import { createRemoteOfficialAppServerConnection } from "./remote-official-connection.js";
import { createHostUpdateCoordinator, type HostUpdateCoordinator } from "./update-coordinator.js";

const STOCK_CODEX_PATH_ENV = "CODEXHOST_STOCK_CODEX_PATH";
const DEFAULT_AGENT_ENV = "CODEXHOST_DEFAULT_AGENT";
export const MANAGED_REMOTE_APP_SERVER_PROCESS_TITLE = "codexhost remote app-server listener";

export function officialAccountDeploymentKind(
  arguments_: readonly string[],
): "managed-shared-home" | "ssh-single-account" {
  return isRemoteUnixListenerInvocation(arguments_) ? "ssh-single-account" : "managed-shared-home";
}

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

function unavailableAccountReason(
  error: unknown,
): "unsupported-storage" | "unsupported-version" | "recovery-required" {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "unsupported-storage" || error.code === "unsupported-version")
  )
    return error.code;
  return "recovery-required";
}

function reportUnavailableOfficialRuntime(error: unknown): void {
  // Native failures can include private paths or authentication material. Keep the
  // Host diagnostic actionable without logging the raw error.
  process.stderr.write(
    `codexhost managed official runtime is unavailable: ${unavailableAccountReason(error)}\n`,
  );
}

function unavailableOfficialRuntime(
  reason: "unsupported-storage" | "unsupported-version" | "recovery-required" = "recovery-required",
): {
  scope: OfficialRuntimeScope;
  accounts: UnavailableCodexAccounts;
  close(): Promise<void>;
} {
  const scope = new OfficialRuntimeScope({
    diagnosticOutput: process.stderr,
    createBackend: () => {
      throw new Error("Official Codex is unavailable");
    },
  });
  return {
    scope,
    accounts: new UnavailableCodexAccounts(reason, () => ({
      phase: scope.gate.phase,
      revision: scope.gate.revision,
    })),
    close: () => scope.close(),
  };
}

async function createManagedOfficialRuntime(input: {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  loopback: boolean;
}): Promise<{
  scope: OfficialRuntimeScope;
  accounts: ManagedCodexAccounts;
  close(): Promise<void>;
}> {
  const launcher = input.environment.CODEXHOST_LAUNCHER_EXECUTABLE;
  if (!launcher || !path.isAbsolute(launcher))
    throw new Error("Official process supervision is unavailable");
  const dataDirectory = path.resolve(
    input.environment.CODEXHOST_DATA_DIR ?? path.join(homedir(), ".codexhost"),
  );
  const sharedCodexHome = path.resolve(
    input.environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  const privateFiles = new NativePrivateFiles({ launcher });
  // The official Windows home grants CodexSandboxUsers read/traverse access.
  // Accept that native ACL only for files in CODEX_HOME; all Host-owned state
  // stays below a separately created strict private directory.
  const sharedHomeFiles = new NativePrivateFiles({
    launcher,
    allowReadOnlyAccess: process.platform === "win32",
  });
  const accountDirectory = path.join(dataDirectory, "codex-account-credentials");
  const runtimePrivateDirectory = path.join(sharedCodexHome, ".codexhost-native-accounts");
  const credentials = new CodexCredentialFiles({
    files: privateFiles,
    sharedHomeFiles,
    directory: accountDirectory,
    sharedCodexHome,
    lockDirectory: runtimePrivateDirectory,
  });
  const credentialLease = await credentials.initialize();
  let scope: OfficialRuntimeScope | undefined;
  try {
    const processRecord = new OfficialProcessRecord({
      files: privateFiles,
      sharedCodexHome: runtimePrivateDirectory,
      identity: (pid) => readNativeProcessIdentity(launcher, pid),
      assertOwnership: () => credentials.assertOwnership(),
      supervisorExitClosesProcessTree: process.platform === "win32",
    });
    await processRecord.reconcile();
    const processEnvironment = {
      ...officialEnvironment(input.environment),
      CODEX_HOME: sharedCodexHome,
    };
    scope = new OfficialRuntimeScope({
      diagnosticOutput: process.stderr,
      createBackend: () =>
        processRecord.wrap((receipt) =>
          input.loopback
            ? createOwnedLoopbackBackend({
                stockCodexPath: input.stockCodexPath,
                arguments: input.arguments,
                cwd: process.cwd(),
                environment: processEnvironment,
                diagnosticOutput: process.stderr,
                supervision: { launcher, files: privateFiles, receipt },
              })
            : createOwnedStdioBackend({
                stockCodexPath: input.stockCodexPath,
                arguments: input.arguments,
                cwd: process.cwd(),
                environment: processEnvironment,
                supervision: { launcher, files: privateFiles, receipt },
              }),
        ),
    });
    const runtime = new OfficialAccountRuntime({
      owner: scope.owner,
      credentials,
      environment: processEnvironment,
      nativeVersion: () => readOfficialCliVersion(input.stockCodexPath, processEnvironment),
      reconcilePreviousWriter: () => processRecord.reconcile(),
      persistentManagementClient: input.loopback,
    });
    const legacyInventory = await inspectLegacyAccountLayout(dataDirectory, sharedCodexHome);
    const legacyRegistryFile =
      legacyInventory.kind === "legacy" && !canAdoptLegacyLayout(legacyInventory)
        ? legacyInventory.registryFile
        : undefined;
    const savedAccounts = new SavedCodexAccounts({
      directory: path.join(dataDirectory, "codex-global-accounts"),
      sharedCodexHome,
      ...(legacyRegistryFile ? { legacyRegistryFile } : {}),
    });
    if (legacyInventory.kind === "legacy" && canAdoptLegacyLayout(legacyInventory)) {
      const launcherPid = Number(input.environment.CODEXHOST_LAUNCHER_PID);
      const launcherTakeoverConfirmed =
        Number.isSafeInteger(launcherPid) &&
        launcherPid > 0 &&
        (await readNativeProcessIdentity(launcher, launcherPid)) !== null;
      await adoptLegacyAccountLayout({
        inventory: legacyInventory,
        files: privateFiles,
        sourceCredentialFiles: sharedHomeFiles,
        migrationDirectory: accountDirectory,
        accounts: savedAccounts,
        credentials,
        oldOfficialBackendsExited: launcherTakeoverConfirmed,
        validateMigratedThreads: (threadIds) => runtime.validateMigratedThreads(threadIds),
      });
    }
    const journal = new FileCredentialSwitchJournal(privateFiles, accountDirectory);
    const runtimeGate = scope.gate;
    const switcher = new CodexAccountSwitcher({
      accounts: savedAccounts,
      credentials,
      runtime,
      journal,
      gate: runtimeGate,
    });
    const quotas = new ManagedCodexAccountQuotas({
      files: privateFiles,
      directory: accountDirectory,
      credentials,
      admitCredentialRefresh: (accountId) => {
        if (savedAccounts.getCurrentAccountId() === accountId) {
          throw new Error("Current Codex Account credentials are owned by the official backend");
        }
        return runtimeGate.admit();
      },
    });
    const accounts = new ManagedCodexAccounts({
      accounts: savedAccounts,
      credentials,
      runtime,
      switcher,
      journal,
      gate: runtimeGate,
      quotas,
    });
    await accounts.initialize();
    const readyScope = scope;
    return {
      scope: readyScope,
      accounts,
      async close() {
        try {
          await readyScope.close();
        } finally {
          await credentialLease.release();
        }
      },
    };
  } catch (error) {
    try {
      await scope?.close();
    } finally {
      await credentialLease.release();
    }
    throw error;
  }
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

  if (officialAccountDeploymentKind(input.arguments) === "managed-shared-home") {
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
          const managed = await createManagedOfficialRuntime({
            stockCodexPath,
            arguments: input.arguments,
            environment: delegationEnvironment,
            loopback: false,
          }).catch((error: unknown) => {
            reportUnavailableOfficialRuntime(error);
            return unavailableOfficialRuntime(unavailableAccountReason(error));
          });
          const host = new AppServerHost({
            stockCodexPath,
            arguments: input.arguments,
            defaultAgent,
            environment: delegationEnvironment,
            ...installedHarnessPluginOptions(delegationEnvironment, false, input.hostRuntimeUrl),
            accountControl: managed.accounts,
            officialRuntimeScope: managed.scope,
            onDelegationApi,
            ...(updateCoordinator ? { updateCoordinator } : {}),
          });
          try {
            return await host.run();
          } finally {
            await managed.close();
          }
        },
      });
    }

    return prepareDelegationRuntime({
      environment,
      createHost: async (delegationEnvironment, onDelegationApi, registry) => {
        const officialPlan = createRemoteControlOfficialAppServerPlan(
          remoteControlPlan.officialArguments,
        );
        const managed = await createManagedOfficialRuntime({
          stockCodexPath,
          arguments: officialPlan.listenerArguments,
          environment: delegationEnvironment,
          loopback: true,
        }).catch((error: unknown) => {
          reportUnavailableOfficialRuntime(error);
          return unavailableOfficialRuntime(unavailableAccountReason(error));
        });
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
          accountControl: managed.accounts,
          officialRuntimeScope: managed.scope,
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
              accountControl: managed.accounts,
              officialRuntimeScope: managed.scope,
              onDelegationApi: (api) => registry.register(api),
              ...(updateCoordinator ? { updateCoordinator } : {}),
            });
          },
        });

        try {
          await listener.listen();
          await publishRemoteControlAppServerDescriptor(remoteControlPlan);
          return await host.run();
        } finally {
          try {
            await listener.close();
          } finally {
            try {
              await managed.close();
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
      const officialScope = new OfficialRuntimeScope({
        diagnosticOutput: process.stderr,
        createBackend: () =>
          createSharedConnectionBackend(
            () => createRemoteOfficialAppServerConnection(officialPlan.socketPath),
            officialListener.closed,
          ),
      });
      const accountControl = new SingleNativeCodexAccount(() => ({
        version: 2,
        currentAccountId: "00000000-0000-4000-8000-000000000001",
        phase: officialScope.gate.phase,
        revision: officialScope.gate.revision,
        capabilities: {
          manage: false,
          switch: false,
          login: false,
          delete: false,
          reason: "ssh-single-account",
        },
        accounts: [
          {
            accountId: "00000000-0000-4000-8000-000000000001",
            label: "SSH Codex Account",
          },
        ],
      }));
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
            accountControl,
            officialRuntimeScope: officialScope,
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
        await officialScope.start();
        officialScope.gate.initialized();
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
            await officialScope.close();
          } finally {
            try {
              await officialListener.close();
            } finally {
              await mappingStore.close();
            }
          }
        }
      }
    },
  });
}
