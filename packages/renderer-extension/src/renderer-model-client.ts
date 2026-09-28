import {
  HARNESS_LAUNCH_SETTINGS_GET_METHOD,
  HARNESS_LAUNCH_SETTINGS_SET_METHOD,
  harnessLaunchSettingsGetSchema,
  harnessLaunchSettingsSetSchema,
  harnessLaunchSettingsSchema,
  type HarnessLaunchSettings,
  type HarnessLaunchSettingsGet,
  type HarnessLaunchSettingsSet,
  IDLE_RELEASE_SETTINGS_METHOD,
  LOADED_SESSIONS_METHOD,
  loadedSessionsSchema,
  type LoadedSession,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
  harnessAccountInspectParamsSchema,
  harnessAccountInspectResultSchema,
  harnessAccountSourceListResultSchema,
  type HarnessAccountInspectParams,
  type HarnessAccountInspectResult,
  type HarnessAccountSourceListResult,
  harnessAccountListParamsSchema,
  harnessAccountListResultSchema,
  type HarnessAccountListParams,
  type HarnessAccountListResult,
  codexAccountUsageParamsSchema,
  codexAccountUsageResultSchema,
  type CodexAccountUsageParams,
  type CodexAccountUsageResult,
  codexAccountChangedSchema,
  codexAccountListResultSchema,
  externalThreadForkParamsSchema,
  externalThreadForkResultSchema,
  harnessCommandCatalogSchema,
  harnessCommandsInspectParamsSchema,
  harnessConfigurationStateSchema,
  harnessInspectParamsSchema,
  harnessInspectionSchema,
  harnessPluginListResultSchema,
  type HarnessPluginListResult,
  harnessWebUiOpenParamsSchema,
  harnessWebUiOpenResultSchema,
  harnessModelSelectionStateSchema,
  hostThreadIdSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadCommandExecuteParamsSchema,
  threadCommandExecuteResultSchema,
  threadCommandsInspectParamsSchema,
  threadModelSelectParamsSchema,
  threadPermissionModeSelectParamsSchema,
  threadThinkingSelectParamsSchema,
  threadOwnershipListParamsSchema,
  threadOwnershipListResultSchema,
  threadUsageInspectionParamsSchema,
  threadUsageInspectionSchema,
  updateCheckResultSchema,
  updateEmptyParamsSchema,
  updateStartResultSchema,
  updateStatusResultSchema,
  type ExternalThreadForkParams,
  type ExternalThreadForkResult,
  type CodexAccountChanged,
  type CodexAccountListResult,
  type HarnessCommandCatalog,
  type HarnessCommandsInspectParams,
  type HarnessConfigurationState,
  type HarnessInspection,
  type HarnessInspectParams,
  type HarnessWebUiOpenParams,
  type HarnessModelSelectionState,
  type ThreadInspection,
  type ThreadInspectionParams,
  type ThreadCommandExecuteParams,
  type ThreadCommandExecuteResult,
  type ThreadCommandsInspectParams,
  type ThreadModelSelectParams,
  type ThreadPermissionModeSelectParams,
  type ThreadThinkingSelectParams,
  type ThreadOwnershipListParams,
  type ThreadOwnershipListResult,
  type ThreadUsageInspection,
  type ThreadUsageInspectionParams,
  type UpdateCheckResult,
  type UpdateStartResult,
  type UpdateStatusResult,
} from "@codexhost/shared-contracts";

import {
  createRendererRequestSender,
  RendererMethodUnavailableError,
  type RendererRequestOptions,
} from "./renderer-request-sender.js";
import {
  createRendererSessionImportClient,
  type RendererSessionImportClient,
} from "./renderer-session-import-client.js";

export const HARNESS_INSPECT_METHOD = "codexhost/harness/inspect";
export const HARNESS_PLUGIN_LIST_METHOD = "codexhost/harness/plugins/list";
import {
  CREDENTIAL_IMPORTS_METHOD,
  credentialImportsParamsSchema,
  credentialImportsResultSchema,
  type CredentialImportsRequest,
  type CredentialImportsResult,
} from "@codexhost/shared-contracts";

export const HARNESS_ACCOUNT_SOURCES_METHOD = "codexhost/harness/accounts/sources";
export const HARNESS_ACCOUNT_INSPECT_METHOD = "codexhost/harness/accounts/inspect";
export const HARNESS_WEB_UI_OPEN_METHOD = "codexhost/harness/web-ui/open";
export const THREAD_FORK_METHOD = "codexhost/thread/fork";
export const THREAD_INSPECT_METHOD = "codexhost/thread/inspect";
export const HARNESS_COMMANDS_INSPECT_METHOD = "codexhost/harness/commands/inspect";
export const THREAD_COMMANDS_INSPECT_METHOD = "codexhost/thread/commands/inspect";
export const THREAD_COMMAND_EXECUTE_METHOD = "codexhost/thread/command/execute";
export const THREAD_MODEL_SELECT_METHOD = "codexhost/thread/model/select";
export const THREAD_THINKING_SELECT_METHOD = "codexhost/thread/thinking/select";
export const THREAD_PERMISSION_MODE_SELECT_METHOD = "codexhost/thread/permission-mode/select";
export const THREAD_OWNERSHIP_LIST_METHOD = "codexhost/thread/ownership/list";
export const THREAD_USAGE_INSPECT_METHOD = "codexhost/thread/usage/inspect";
export const THREAD_USAGE_UPDATED_METHOD = "codexhost/thread/usage/updated";
export const THREAD_TOKEN_USAGE_UPDATED_METHOD = "thread/tokenUsage/updated";
/**
 * Codex Desktop does not dispatch the custom `codexhost/thread/usage/updated`
 * notification to renderer callbacks, and the native token-usage carrier is
 * only projected once Context usage is known. Turn completion is dispatched,
 * so it is the guaranteed point to re-read account quota after a reply.
 */
export const TURN_COMPLETED_METHOD = "turn/completed";
const THREAD_USAGE_REFRESH_METHODS = [
  THREAD_TOKEN_USAGE_UPDATED_METHOD,
  THREAD_USAGE_UPDATED_METHOD,
  TURN_COMPLETED_METHOD,
] as const;
export const UPDATE_CHECK_METHOD = "codexhost/update/check";
export const UPDATE_START_METHOD = "codexhost/update/start";
export const UPDATE_STATUS_METHOD = "codexhost/update/status";
export const CODEX_ACCOUNT_LIST_METHOD = "codexhost/account/list";
export const CODEX_ACCOUNT_REFRESH_METHOD = "codexhost/account/refresh";
export const CODEX_ACCOUNT_CHANGED_METHOD = "codexhost/account/changed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notifiedThreadId(notification: unknown): ThreadUsageInspectionParams["threadId"] | null {
  if (
    !isRecord(notification) ||
    !(THREAD_USAGE_REFRESH_METHODS as readonly unknown[]).includes(notification.method)
  ) {
    return null;
  }
  const params = notification.params;
  if (!isRecord(params)) return null;
  const parsed = hostThreadIdSchema.safeParse(params.threadId);
  return parsed.success ? parsed.data : null;
}

interface RequestManagerCandidate {
  addNotificationCallback?: (
    method: string | readonly string[],
    callback: (notification: unknown) => void,
  ) => () => void;
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
  requestClient?: RequestManagerCandidate;
}

function notificationTarget(manager: RequestManagerCandidate): RequestManagerCandidate | null {
  if (typeof manager.addNotificationCallback === "function") return manager;
  const nested = manager.requestClient;
  return nested && typeof nested.addNotificationCallback === "function" ? nested : null;
}

export interface RendererModelClient extends Partial<RendererSessionImportClient> {
  getHarnessLaunchSettings?(input: HarnessLaunchSettingsGet): Promise<HarnessLaunchSettings>;
  setHarnessLaunchSettings?(input: HarnessLaunchSettingsSet): Promise<HarnessLaunchSettings>;
  setIdleReleaseSettings?(settings: IdleReleaseSettings): Promise<IdleReleaseSettings>;
  listLoadedSessions?(): Promise<LoadedSession[]>;
  currentHostId?(): string | null;
  listHarnessPlugins?(): Promise<HarnessPluginListResult>;
  clientForHost?(hostId: string): RendererModelClient | null;
  forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult>;
  inspectHarness(
    input: HarnessInspectParams,
    options?: RendererRequestOptions,
  ): Promise<HarnessInspection>;
  openHarnessWebUi?(input: HarnessWebUiOpenParams): Promise<void>;
  inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection>;
  inspectHarnessCommands(input: HarnessCommandsInspectParams): Promise<HarnessCommandCatalog>;
  inspectThreadCommands(input: ThreadCommandsInspectParams): Promise<HarnessCommandCatalog>;
  executeThreadCommand(input: ThreadCommandExecuteParams): Promise<ThreadCommandExecuteResult>;
  listThreadOwnership(input: ThreadOwnershipListParams): Promise<ThreadOwnershipListResult>;
  inspectThreadUsage(input: ThreadUsageInspectionParams): Promise<ThreadUsageInspection>;
  subscribeThreadUsage?(listener: (update: ThreadUsageInspection) => void): () => void;
  selectThreadModel(input: ThreadModelSelectParams): Promise<HarnessModelSelectionState>;
  selectThreadThinking(input: ThreadThinkingSelectParams): Promise<HarnessModelSelectionState>;
  selectThreadPermissionMode(
    input: ThreadPermissionModeSelectParams,
  ): Promise<HarnessConfigurationState>;
  checkUpdate(): Promise<UpdateCheckResult | null>;
  startUpdate(): Promise<UpdateStartResult>;
  readUpdateStatus(): Promise<UpdateStatusResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  listHarnessAccountSources?(): Promise<HarnessAccountSourceListResult>;
  inspectHarnessAccount?(input: HarnessAccountInspectParams): Promise<HarnessAccountInspectResult>;
  listHarnessAccounts?(input?: HarnessAccountListParams): Promise<HarnessAccountListResult>;
  credentialImports?(
    request: CredentialImportsRequest,
    targetHarnessId?: string,
  ): Promise<CredentialImportsResult>;
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts(): Promise<CodexAccountListResult>;
  subscribeCodexAccounts?(listener: (state: CodexAccountChanged) => void): () => void;
}

export function createThreadUsageSubscriptionRelay(): {
  connect(client: Pick<RendererModelClient, "subscribeThreadUsage"> | null): void;
  subscribe(listener: (update: ThreadUsageInspection) => void): () => void;
  dispose(): void;
} {
  const listeners = new Set<(update: ThreadUsageInspection) => void>();
  let removeNotificationCallback: (() => void) | null = null;
  let connectedClient: Pick<RendererModelClient, "subscribeThreadUsage"> | null = null;
  let generation = 0;
  const disconnect = (): void => {
    generation += 1;
    removeNotificationCallback?.();
    removeNotificationCallback = null;
    connectedClient = null;
  };
  return {
    connect(client) {
      if (client === connectedClient && removeNotificationCallback) return;
      disconnect();
      if (!client || listeners.size === 0) return;
      connectedClient = client;
      const subscriptionGeneration = generation;
      try {
        removeNotificationCallback =
          client.subscribeThreadUsage?.((update) => {
            if (subscriptionGeneration !== generation) return;
            for (const listener of listeners) listener(update);
          }) ?? null;
      } catch {
        disconnect();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        disconnect();
      };
    },
    dispose() {
      disconnect();
      listeners.clear();
    },
  };
}

export function createRendererModelClient(
  candidates: readonly RequestManagerCandidate[],
): RendererModelClient | null {
  const managers = candidates.filter(
    (
      candidate,
    ): candidate is RequestManagerCandidate &
      Required<Pick<RequestManagerCandidate, "sendRequest">> =>
      typeof candidate.sendRequest === "function",
  );
  const source = managers[0];
  if (managers.length !== 1 || !source) return null;
  const manager = {
    sendRequest: createRendererRequestSender((method, params, options) =>
      options === undefined
        ? source.sendRequest(method, params)
        : source.sendRequest(method, params, options),
    ),
  };

  const inspectHarness = async (
    input: HarnessInspectParams,
    options?: RendererRequestOptions,
  ): Promise<HarnessInspection> => {
    const params = harnessInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(HARNESS_INSPECT_METHOD, params, options);
    return harnessInspectionSchema.parse(result);
  };
  const inspectHarnessCommands = async (
    input: HarnessCommandsInspectParams,
  ): Promise<HarnessCommandCatalog> => {
    const params = harnessCommandsInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(HARNESS_COMMANDS_INSPECT_METHOD, params);
    return harnessCommandCatalogSchema.parse(result);
  };
  const inspectThreadCommands = async (
    input: ThreadCommandsInspectParams,
  ): Promise<HarnessCommandCatalog> => {
    const params = threadCommandsInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_COMMANDS_INSPECT_METHOD, params);
    return harnessCommandCatalogSchema.parse(result);
  };
  const executeThreadCommand = async (
    input: ThreadCommandExecuteParams,
  ): Promise<ThreadCommandExecuteResult> => {
    const params = threadCommandExecuteParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_COMMAND_EXECUTE_METHOD, params);
    return threadCommandExecuteResultSchema.parse(result);
  };
  const inspectThreadUsage = async (
    input: ThreadUsageInspectionParams,
  ): Promise<ThreadUsageInspection> => {
    const params = threadUsageInspectionParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_USAGE_INSPECT_METHOD, params);
    return threadUsageInspectionSchema.parse(result);
  };
  const selectThreadModel = async (
    input: ThreadModelSelectParams,
  ): Promise<HarnessModelSelectionState> => {
    const params = threadModelSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_MODEL_SELECT_METHOD, params);
    return harnessModelSelectionStateSchema.parse(result);
  };
  const selectThreadThinking = async (
    input: ThreadThinkingSelectParams,
  ): Promise<HarnessModelSelectionState> => {
    const params = threadThinkingSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_THINKING_SELECT_METHOD, params);
    return harnessModelSelectionStateSchema.parse(result);
  };
  const selectThreadPermissionMode = async (
    input: ThreadPermissionModeSelectParams,
  ): Promise<HarnessConfigurationState> => {
    const params = threadPermissionModeSelectParamsSchema.parse(input);
    const result = await manager.sendRequest(THREAD_PERMISSION_MODE_SELECT_METHOD, params);
    return harnessConfigurationStateSchema.parse(result);
  };

  return Object.freeze({
    async getHarnessLaunchSettings(
      input: HarnessLaunchSettingsGet,
    ): Promise<HarnessLaunchSettings> {
      return harnessLaunchSettingsSchema.parse(
        await manager.sendRequest(
          HARNESS_LAUNCH_SETTINGS_GET_METHOD,
          harnessLaunchSettingsGetSchema.parse(input),
        ),
      );
    },
    async setHarnessLaunchSettings(
      input: HarnessLaunchSettingsSet,
    ): Promise<HarnessLaunchSettings> {
      return harnessLaunchSettingsSchema.parse(
        await manager.sendRequest(
          HARNESS_LAUNCH_SETTINGS_SET_METHOD,
          harnessLaunchSettingsSetSchema.parse(input),
        ),
      );
    },
    async listLoadedSessions(): Promise<LoadedSession[]> {
      return loadedSessionsSchema.parse(await manager.sendRequest(LOADED_SESSIONS_METHOD, {}));
    },
    async setIdleReleaseSettings(settings: IdleReleaseSettings): Promise<IdleReleaseSettings> {
      const params = idleReleaseSettingsSchema.parse(settings);
      return idleReleaseSettingsSchema.parse(
        await manager.sendRequest(IDLE_RELEASE_SETTINGS_METHOD, params),
      );
    },
    ...createRendererSessionImportClient(async (method, params) =>
      manager.sendRequest(method, params),
    ),
    async forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult> {
      const params = externalThreadForkParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_FORK_METHOD, params);
      return externalThreadForkResultSchema.parse(result);
    },
    inspectHarness,
    async listHarnessPlugins(): Promise<HarnessPluginListResult> {
      return harnessPluginListResultSchema.parse(
        await manager.sendRequest(HARNESS_PLUGIN_LIST_METHOD, {}),
      );
    },
    async openHarnessWebUi(input: HarnessWebUiOpenParams): Promise<void> {
      const params = harnessWebUiOpenParamsSchema.parse(input);
      const result = await manager.sendRequest(HARNESS_WEB_UI_OPEN_METHOD, params);
      harnessWebUiOpenResultSchema.parse(result);
    },
    async inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection> {
      const params = threadInspectionParamsSchema.parse(input);
      let result: unknown;
      try {
        result = await manager.sendRequest(THREAD_INSPECT_METHOD, params);
      } catch (error) {
        if (!(error instanceof RendererMethodUnavailableError)) throw error;

        // Stock Codex has no Host inspection API. Verify its native Thread on
        // this same connection; neither an RPC failure nor a missing Account
        // establishes ownership. Match the external markers used by the Host.
        const native = await manager.sendRequest("thread/read", {
          threadId: params.threadId,
          includeTurns: false,
        });
        const thread = isRecord(native) ? native.thread : null;
        if (
          !isRecord(thread) ||
          thread.id !== params.threadId ||
          typeof thread.modelProvider !== "string" ||
          !thread.modelProvider ||
          thread.modelProvider === "codexhost" ||
          typeof thread.cliVersion !== "string" ||
          !thread.cliVersion ||
          thread.cliVersion === "codexhost"
        ) {
          throw new Error("Native Thread response cannot establish Codex ownership");
        }
        return { owner: "codex", locked: true };
      }
      return threadInspectionSchema.parse(result);
    },
    inspectHarnessCommands,
    inspectThreadCommands,
    executeThreadCommand,
    async listThreadOwnership(
      input: ThreadOwnershipListParams,
    ): Promise<ThreadOwnershipListResult> {
      const params = threadOwnershipListParamsSchema.parse(input);
      const value = await manager.sendRequest(THREAD_OWNERSHIP_LIST_METHOD, params);
      const result = threadOwnershipListResultSchema.parse(value);
      if (
        result.threads.length !== params.threadIds.length ||
        result.threads.some((thread, index) => thread.threadId !== params.threadIds[index])
      ) {
        throw new Error("Thread ownership-list result does not match the requested IDs");
      }
      return result;
    },
    inspectThreadUsage,
    subscribeThreadUsage(listener: (update: ThreadUsageInspection) => void): () => void {
      const notifications = notificationTarget(source);
      if (!notifications?.addNotificationCallback) {
        throw new Error("Renderer Usage notification callback is unavailable");
      }
      let disposed = false;
      const generations = new Map<ThreadUsageInspectionParams["threadId"], number>();
      const removeNotificationCallback = notifications.addNotificationCallback(
        THREAD_USAGE_REFRESH_METHODS,
        (notification) => {
          const threadId = notifiedThreadId(notification);
          if (!threadId) return;
          const generation = (generations.get(threadId) ?? 0) + 1;
          generations.set(threadId, generation);
          void inspectThreadUsage({ threadId })
            .then((update) => {
              if (!disposed && generations.get(threadId) === generation) listener(update);
            })
            .catch(() => undefined);
        },
      );
      return () => {
        if (disposed) return;
        disposed = true;
        generations.clear();
        removeNotificationCallback();
      };
    },
    selectThreadModel,
    selectThreadThinking,
    selectThreadPermissionMode,
    async checkUpdate(): Promise<UpdateCheckResult | null> {
      const result = await manager.sendRequest(
        UPDATE_CHECK_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateCheckResultSchema.nullable().parse(result);
    },
    async startUpdate(): Promise<UpdateStartResult> {
      const result = await manager.sendRequest(
        UPDATE_START_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateStartResultSchema.parse(result);
    },
    async readUpdateStatus(): Promise<UpdateStatusResult> {
      const result = await manager.sendRequest(
        UPDATE_STATUS_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateStatusResultSchema.parse(result);
    },
    async inspectCodexAccountUsage(
      input: CodexAccountUsageParams,
    ): Promise<CodexAccountUsageResult> {
      const result = await manager.sendRequest(
        "codexhost/account/usage/inspect",
        codexAccountUsageParamsSchema.parse(input),
      );
      return codexAccountUsageResultSchema.parse(result);
    },
    async listHarnessAccountSources(): Promise<HarnessAccountSourceListResult> {
      return harnessAccountSourceListResultSchema.parse(
        await manager.sendRequest(HARNESS_ACCOUNT_SOURCES_METHOD, {}),
      );
    },
    async inspectHarnessAccount(
      input: HarnessAccountInspectParams,
    ): Promise<HarnessAccountInspectResult> {
      return harnessAccountInspectResultSchema.parse(
        await manager.sendRequest(
          HARNESS_ACCOUNT_INSPECT_METHOD,
          harnessAccountInspectParamsSchema.parse(input),
        ),
      );
    },
    async credentialImports(
      request: CredentialImportsRequest,
      targetHarnessId?: string,
    ): Promise<CredentialImportsResult> {
      return credentialImportsResultSchema.parse(
        await manager.sendRequest(
          CREDENTIAL_IMPORTS_METHOD,
          credentialImportsParamsSchema.parse({ request, targetHarnessId }),
        ),
      );
    },
    async listHarnessAccounts(
      input: HarnessAccountListParams = {},
    ): Promise<HarnessAccountListResult> {
      return harnessAccountListResultSchema.parse(
        await manager.sendRequest(
          "codexhost/harness/accounts/list",
          harnessAccountListParamsSchema.parse(input),
        ),
      );
    },
    async listCodexAccounts(): Promise<CodexAccountListResult> {
      const result = await manager.sendRequest(CODEX_ACCOUNT_LIST_METHOD, {});
      return codexAccountListResultSchema.parse(result);
    },
    async refreshCodexAccounts(): Promise<CodexAccountListResult> {
      const result = await manager.sendRequest(CODEX_ACCOUNT_REFRESH_METHOD, {});
      return codexAccountListResultSchema.parse(result);
    },
    subscribeCodexAccounts(listener: (state: CodexAccountChanged) => void): () => void {
      const notifications = notificationTarget(source);
      if (!notifications?.addNotificationCallback) {
        throw new Error("Renderer Account notification callback is unavailable");
      }
      return notifications.addNotificationCallback(CODEX_ACCOUNT_CHANGED_METHOD, (notification) => {
        if (!isRecord(notification) || notification.method !== CODEX_ACCOUNT_CHANGED_METHOD) return;
        const state = codexAccountChangedSchema.safeParse(notification.params);
        if (state.success) listener(state.data);
      });
    },
  });
}
