import {
  CONSOLE_REMOTE_CONNECTIONS_METHOD,
  REMOTE_SSH_SETUP_METHOD,
  RUNTIME_STATUS_METHOD,
  codexSshConnectionSchema,
  remoteConnectionsRequestSchema,
  remoteSshSetupResultSchema,
  runtimeStatusSchema,
  type RemoteConnectionsRequest,
} from "@codexhost/shared-contracts";
import type { RemoteConnectionsControl } from "../remote-connections-control.js";
import type { hostRequestManager } from "./api.js";

/** Browser transport for the shared remote settings page. Codex remains the config owner. */
export function createConsoleRemoteConnections(
  manager: ReturnType<typeof hostRequestManager>,
): RemoteConnectionsControl {
  const request = (input: RemoteConnectionsRequest, signal?: AbortSignal) =>
    manager.sendRequest(
      CONSOLE_REMOTE_CONNECTIONS_METHOD,
      remoteConnectionsRequestSchema.parse(input),
      signal,
    );
  return {
    ssh: {
      async list(signal) {
        return codexSshConnectionSchema.array().parse(await request({ action: "list" }, signal));
      },
      async save(draft, previous, signal) {
        await request({ action: "save", draft, previous }, signal);
      },
      async remove(previous, signal) {
        await request({ action: "remove", previous }, signal);
      },
      async connect(hostId, enabled, signal) {
        await request({ action: "connect", hostId, enabled }, signal);
      },
      async state(hostId, signal) {
        const result = await request({ action: "state", hostId }, signal);
        if (
          !result ||
          typeof result !== "object" ||
          !("state" in result) ||
          typeof result.state !== "string"
        )
          throw new Error("Invalid Codex connection state");
        return {
          state: result.state,
          error: "error" in result && typeof result.error === "string" ? result.error : null,
        };
      },
    },
    async setup(connection, action, version, uninstallPackage) {
      return remoteSshSetupResultSchema.parse(
        await manager.sendRequest(REMOTE_SSH_SETUP_METHOD, {
          hostname: connection.sshAlias ?? connection.sshHost,
          port: connection.sshPort,
          identity: connection.identity,
          action,
          version: version ?? null,
          ...(action === "uninstall" ? { uninstallPackage: uninstallPackage ?? false } : {}),
        }),
      );
    },
    async runtime(hostId) {
      return runtimeStatusSchema.parse(
        await (hostId === "local"
          ? manager.sendRequest(RUNTIME_STATUS_METHOD, {})
          : request({ action: "runtime", hostId })),
      );
    },
    async update(hostId, version) {
      return runtimeStatusSchema.parse(await request({ action: "update", hostId, version }));
    },
  };
}
