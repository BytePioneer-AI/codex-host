import type {
  DelegationReadParams,
  RemoteSshSetupParams,
  RemoteSshSetupResult,
  RuntimeStatus,
} from "@codexhost/shared-contracts";
import {
  createCodexSshClient,
  type CodexSshClient,
  type CodexSshConnection,
} from "./codex-ssh-adapter.js";

export interface RemoteRuntimeClient {
  readDelegationThread?(input: DelegationReadParams): Promise<unknown>;
  setupSsh?(input: RemoteSshSetupParams): Promise<RemoteSshSetupResult>;
  runtimeStatus?(): Promise<RuntimeStatus>;
  updateRemote?(version: string): Promise<RuntimeStatus>;
}
export interface RemoteConnectionsControl {
  ssh: CodexSshClient;
  readThread?(hostId: string, input: DelegationReadParams): Promise<unknown>;
  setup(
    connection: CodexSshConnection,
    action: RemoteSshSetupParams["action"],
    version?: string,
    uninstallPackage?: boolean,
  ): Promise<RemoteSshSetupResult>;
  runtime(hostId: string): Promise<RuntimeStatus>;
  update(hostId: string, version: string): Promise<RuntimeStatus>;
}

export function remoteUpdateTarget(
  local: RuntimeStatus | null,
  remote: RuntimeStatus,
): string | null {
  if (
    !remote.updateSupported ||
    !remote.remote ||
    !remote.installedVersion ||
    !local?.runningVersion
  )
    return null;
  if (["installing", "restarting", "failed"].includes(remote.update.phase)) return null;
  // Unpublished prereleases need an explicit action; don't infer ordering from a label.
  const stable = /^(\d+)\.(\d+)\.(\d+)$/u;
  if (!stable.test(local.runningVersion) || !stable.test(remote.installedVersion)) return null;
  const left = local.runningVersion.split(".").map(Number);
  const right = remote.installedVersion.split(".").map(Number);
  const index = left.findIndex((part, index) => part !== right[index]);
  if (index >= 0 && (left[index] ?? 0) > (right[index] ?? 0)) return local.runningVersion;
  if (index < 0 && remote.restartRequired) return remote.installedVersion;
  return null;
}

export function createRemoteConnectionsControl(
  ownerWindow: Window,
  getClient: (hostId: string) => RemoteRuntimeClient | null,
): RemoteConnectionsControl {
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: number | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = ownerWindow.setTimeout(
            () => reject(new Error("Remote service did not respond; reconnect and retry")),
            8_000,
          );
        }),
      ]);
    } finally {
      ownerWindow.clearTimeout(timer);
    }
  }
  const control: RemoteConnectionsControl = {
    ssh: createCodexSshClient(ownerWindow),
    async readThread(hostId, input) {
      if (!hostId || hostId === "local") throw new Error("Choose an explicit remote Host");
      const client = getClient(hostId);
      if (!client?.readDelegationThread)
        throw new Error("Remote Thread reading is unavailable; update codexhost and reconnect");
      return bounded(client.readDelegationThread(input));
    },
    async setup(connection, action, version, uninstallPackage) {
      const client = getClient("local");
      if (!client?.setupSsh)
        throw new Error("SSH installation is unavailable; update local codexhost and restart");
      return client.setupSsh({
        hostname: connection.sshAlias ?? connection.sshHost,
        port: connection.sshPort,
        identity: connection.identity,
        action,
        version: version ?? null,
        ...(action === "uninstall" ? { uninstallPackage: uninstallPackage ?? false } : {}),
      });
    },
    async runtime(hostId) {
      const client = getClient(hostId);
      if (!client?.runtimeStatus)
        throw new Error(
          "Version management is unavailable; update codexhost on this host and reconnect",
        );
      return bounded(client.runtimeStatus());
    },
    async update(hostId, version) {
      if (hostId === "local") throw new Error("Choose a remote SSH connection");
      const client = getClient(hostId);
      if (!client?.updateRemote)
        throw new Error("Remote update is unavailable; update this remote once and reconnect");
      return bounded(client.updateRemote(version));
    },
  };
  return control;
}
