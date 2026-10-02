/** Fixed native Codex SSH operations. Configuration stays owned by Codex. */
export interface CodexSshConnection {
  hostId: string;
  displayName: string;
  source: "codex-managed" | "discovered";
  sshAlias: string | null;
  sshHost: string;
  sshPort: number | null;
  identity: string | null;
  autoConnect: boolean;
  connectionAnalyticsId?: string;
}
export interface CodexSshDraft {
  displayName: string;
  hostname: string;
  sshPort: number | null;
  identity: string | null;
}
export interface CodexSshClient {
  list(signal?: AbortSignal): Promise<CodexSshConnection[]>;
  save(
    draft: CodexSshDraft,
    previous: CodexSshConnection | null,
    signal?: AbortSignal,
  ): Promise<void>;
  remove(previous: CodexSshConnection, signal?: AbortSignal): Promise<void>;
  connect(hostId: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  state(hostId: string, signal?: AbortSignal): Promise<{ state: string; error: string | null }>;
}

type Operation =
  | "refresh-remote-connections"
  | "save-codex-managed-remote-ssh-connections"
  | "set-remote-connection-auto-connect"
  | "app-server-connection-state";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createCodexSshClient(ownerWindow: Window): CodexSshClient {
  function request(operation: Operation, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const bridge = (
      ownerWindow as Window & {
        electronBridge?: { sendMessageFromView(message: unknown): unknown };
      }
    ).electronBridge;
    if (!bridge?.sendMessageFromView)
      return Promise.reject(new Error("Codex SSH settings are unavailable in this window"));
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const requestId = ownerWindow.crypto.randomUUID();
      const finish = (error: unknown, value?: unknown): void => {
        ownerWindow.clearTimeout(timer);
        ownerWindow.removeEventListener("message", receive);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = (): void => finish(new DOMException("Aborted", "AbortError"));
      const receive = (event: MessageEvent): void => {
        const message: unknown = event.data;
        if (
          !record(message) ||
          message.type !== "fetch-response" ||
          message.requestId !== requestId
        )
          return;
        if (
          message.responseType !== "success" ||
          typeof message.status !== "number" ||
          message.status < 200 ||
          message.status >= 300 ||
          typeof message.bodyJsonString !== "string"
        ) {
          finish(new Error("Codex SSH request failed; check the native Connections settings"));
          return;
        }
        try {
          finish(null, JSON.parse(message.bodyJsonString));
        } catch {
          finish(new Error("Invalid Codex SSH response"));
        }
      };
      const timer = ownerWindow.setTimeout(
        () => finish(new Error("Codex SSH request timed out; refresh before retrying")),
        15_000,
      );
      ownerWindow.addEventListener("message", receive);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        Promise.resolve(
          bridge.sendMessageFromView({
            type: "fetch",
            requestId,
            method: "POST",
            url: `vscode://codex/${operation}`,
            body: JSON.stringify(params),
            reportUploadProgress: false,
          }),
        ).catch((error: unknown) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }
  async function list(signal?: AbortSignal): Promise<CodexSshConnection[]> {
    const result = await request("refresh-remote-connections", {}, signal);
    if (!record(result) || !Array.isArray(result.remoteConnections))
      throw new Error("Invalid Codex SSH connection list");
    // Native refresh returns SSH, Remote Control, and WSL in one catalog.
    // Only SSH entries belong in the native SSH save operation.
    return result.remoteConnections
      .filter(
        (item: unknown) =>
          !(record(item) && ["wsl", "remote-control"].includes(String(item.source))),
      )
      .map((item: unknown) => {
        if (
          !record(item) ||
          typeof item.hostId !== "string" ||
          typeof item.displayName !== "string" ||
          !["codex-managed", "discovered"].includes(String(item.source)) ||
          typeof item.sshHost !== "string" ||
          typeof item.autoConnect !== "boolean" ||
          !(item.sshAlias == null || typeof item.sshAlias === "string") ||
          !(item.identity == null || typeof item.identity === "string") ||
          !(
            item.sshPort == null ||
            (Number.isInteger(item.sshPort) &&
              Number(item.sshPort) > 0 &&
              Number(item.sshPort) <= 65535)
          )
        ) {
          throw new Error(
            "This Codex version uses an unsupported SSH configuration; open native settings",
          );
        }
        return {
          ...item,
          sshAlias: item.sshAlias ?? null,
          identity: item.identity ?? null,
          sshPort: item.sshPort ?? null,
        } as unknown as CodexSshConnection;
      });
  }
  function saved(connection: CodexSshConnection): Record<string, unknown> {
    return {
      hostId: connection.hostId,
      displayName: connection.displayName,
      source: connection.source,
      alias: connection.sshAlias,
      hostname: connection.source === "discovered" ? null : connection.sshHost,
      sshPort: connection.source === "discovered" ? null : connection.sshPort,
      identity: connection.source === "discovered" ? null : connection.identity,
      ...(connection.connectionAnalyticsId
        ? { connectionAnalyticsId: connection.connectionAnalyticsId }
        : {}),
    };
  }
  async function mutate(
    previous: CodexSshConnection | null,
    draft: CodexSshDraft | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await list(signal);
    if (previous) {
      const latest = current.find((item) => item.hostId === previous.hostId);
      if (!latest || JSON.stringify(saved(latest)) !== JSON.stringify(saved(previous))) {
        throw new Error("This connection changed in Codex. Refresh and edit it again.");
      }
    }
    const next = current.filter((item) => item.hostId !== previous?.hostId).map(saved);
    if (draft) {
      const hostname = draft.hostname.trim();
      const displayName = draft.displayName.trim();
      if (
        !displayName ||
        !hostname ||
        hostname.startsWith("-") ||
        /\s/u.test(hostname) ||
        (draft.sshPort !== null &&
          (!Number.isInteger(draft.sshPort) || draft.sshPort < 1 || draft.sshPort > 65535))
      ) {
        throw new Error("Enter a name, SSH hostname (or alias), and a port between 1 and 65535");
      }
      if (
        current.some(
          (item) => item.hostId !== previous?.hostId && item.displayName.trim() === displayName,
        )
      ) {
        throw new Error("A connection with this name already exists");
      }
      // Existing SSH-config entries keep their native alias and identity.
      if (
        previous?.source === "discovered" &&
        (hostname !== previous.sshHost ||
          draft.sshPort !== previous.sshPort ||
          draft.identity !== previous.identity)
      ) {
        throw new Error("Edit SSH-config connection details in native Codex settings");
      }
      next.push(
        previous?.source === "discovered"
          ? { ...saved(previous), displayName }
          : {
              hostId:
                previous?.hostId ?? `remote-ssh-codex-managed:${ownerWindow.crypto.randomUUID()}`,
              displayName,
              source: "codex-managed",
              alias: null,
              hostname,
              sshPort: draft.sshPort,
              identity: draft.identity?.trim() || null,
              ...(previous?.connectionAnalyticsId
                ? { connectionAnalyticsId: previous.connectionAnalyticsId }
                : {}),
            },
      );
    }
    await request("save-codex-managed-remote-ssh-connections", { remoteConnections: next }, signal);
  }
  return {
    list,
    save: (draft, previous, signal) => mutate(previous, draft, signal),
    remove: (previous, signal) => mutate(previous, null, signal),
    async connect(hostId, enabled, signal) {
      await request("set-remote-connection-auto-connect", { hostId, autoConnect: enabled }, signal);
    },
    async state(hostId, signal) {
      const result = await request("app-server-connection-state", { hostId }, signal);
      if (!record(result) || typeof result.state !== "string")
        throw new Error("Invalid Codex connection state");
      return {
        state: result.state,
        error:
          typeof result.error === "string"
            ? result.error
            : record(result.error) && typeof result.error.message === "string"
              ? result.error.message
              : null,
      };
    },
  };
}
