import {
  deepSeekModernSessionImportParamsSchema,
  deepSeekModernSessionImportResultSchema,
  deepSeekModernSessionListParamsSchema,
  deepSeekModernSessionListResultSchema,
  externalThreadForkParamsSchema,
  externalThreadForkResultSchema,
  harnessCommandCatalogSchema,
  harnessConfigurationStateSchema,
  harnessInspectParamsSchema,
  harnessInspectionSchema,
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
  type DeepSeekModernSessionImportParams,
  type DeepSeekModernSessionImportResult,
  type DeepSeekModernSessionListParams,
  type DeepSeekModernSessionListResult,
  type HarnessCommandCatalog,
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

export const HARNESS_INSPECT_METHOD = "codexhost/harness/inspect";
export const DEEPSEEK_MODERN_SESSION_LIST_METHOD = "codexhost/deepseek/modern-session/list";
export const DEEPSEEK_MODERN_SESSION_IMPORT_METHOD = "codexhost/deepseek/modern-session/import";
export const HARNESS_WEB_UI_OPEN_METHOD = "codexhost/harness/web-ui/open";
export const THREAD_FORK_METHOD = "codexhost/thread/fork";
export const THREAD_INSPECT_METHOD = "codexhost/thread/inspect";
export const THREAD_COMMANDS_INSPECT_METHOD = "codexhost/thread/commands/inspect";
export const THREAD_COMMAND_EXECUTE_METHOD = "codexhost/thread/command/execute";
export const THREAD_MODEL_SELECT_METHOD = "codexhost/thread/model/select";
export const THREAD_THINKING_SELECT_METHOD = "codexhost/thread/thinking/select";
export const THREAD_PERMISSION_MODE_SELECT_METHOD = "codexhost/thread/permission-mode/select";
export const THREAD_OWNERSHIP_LIST_METHOD = "codexhost/thread/ownership/list";
export const THREAD_USAGE_INSPECT_METHOD = "codexhost/thread/usage/inspect";
export const THREAD_USAGE_UPDATED_METHOD = "codexhost/thread/usage/updated";
export const THREAD_TOKEN_USAGE_UPDATED_METHOD = "thread/tokenUsage/updated";
export const UPDATE_CHECK_METHOD = "codexhost/update/check";
export const UPDATE_START_METHOD = "codexhost/update/start";
export const UPDATE_STATUS_METHOD = "codexhost/update/status";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notifiedThreadId(notification: unknown): ThreadUsageInspectionParams["threadId"] | null {
  if (
    !isRecord(notification) ||
    (notification.method !== THREAD_TOKEN_USAGE_UPDATED_METHOD &&
      notification.method !== THREAD_USAGE_UPDATED_METHOD)
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

export interface RendererModelClient {
  currentHostId?(): string | null;
  clientForHost?(hostId: string): RendererModelClient | null;
  listDeepSeekModernSessions?(
    input: DeepSeekModernSessionListParams,
  ): Promise<DeepSeekModernSessionListResult>;
  importDeepSeekModernSession?(
    input: DeepSeekModernSessionImportParams,
  ): Promise<DeepSeekModernSessionImportResult>;
  forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult>;
  inspectHarness(input: HarnessInspectParams): Promise<HarnessInspection>;
  openHarnessWebUi?(input: HarnessWebUiOpenParams): Promise<void>;
  inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection>;
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
  checkUpdate(): Promise<UpdateCheckResult>;
  startUpdate(): Promise<UpdateStartResult>;
  readUpdateStatus(): Promise<UpdateStatusResult>;
}

export function createThreadUsageSubscriptionRelay(): {
  connect(client: Pick<RendererModelClient, "subscribeThreadUsage">): void;
  subscribe(listener: (update: ThreadUsageInspection) => void): () => void;
  dispose(): void;
} {
  const listeners = new Set<(update: ThreadUsageInspection) => void>();
  let removeNotificationCallback: (() => void) | null = null;
  return {
    connect(client) {
      if (removeNotificationCallback || listeners.size === 0) return;
      try {
        removeNotificationCallback =
          client.subscribeThreadUsage?.((update) => {
            for (const listener of listeners) listener(update);
          }) ?? null;
      } catch {
        removeNotificationCallback = null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        removeNotificationCallback?.();
        removeNotificationCallback = null;
      };
    },
    dispose() {
      removeNotificationCallback?.();
      removeNotificationCallback = null;
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
  const manager = managers[0];
  if (managers.length !== 1 || !manager) return null;

  const inspectHarness = async (input: HarnessInspectParams): Promise<HarnessInspection> => {
    const params = harnessInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(HARNESS_INSPECT_METHOD, params);
    return harnessInspectionSchema.parse(result);
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
    async listDeepSeekModernSessions(
      input: DeepSeekModernSessionListParams,
    ): Promise<DeepSeekModernSessionListResult> {
      const params = deepSeekModernSessionListParamsSchema.parse(input);
      const result = await manager.sendRequest(DEEPSEEK_MODERN_SESSION_LIST_METHOD, params);
      return deepSeekModernSessionListResultSchema.parse(result);
    },
    async importDeepSeekModernSession(
      input: DeepSeekModernSessionImportParams,
    ): Promise<DeepSeekModernSessionImportResult> {
      const params = deepSeekModernSessionImportParamsSchema.parse(input);
      const result = await manager.sendRequest(DEEPSEEK_MODERN_SESSION_IMPORT_METHOD, params);
      return deepSeekModernSessionImportResultSchema.parse(result);
    },
    async forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult> {
      const params = externalThreadForkParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_FORK_METHOD, params);
      return externalThreadForkResultSchema.parse(result);
    },
    inspectHarness,
    async openHarnessWebUi(input: HarnessWebUiOpenParams): Promise<void> {
      const params = harnessWebUiOpenParamsSchema.parse(input);
      const result = await manager.sendRequest(HARNESS_WEB_UI_OPEN_METHOD, params);
      harnessWebUiOpenResultSchema.parse(result);
    },
    async inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection> {
      const params = threadInspectionParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_INSPECT_METHOD, params);
      return threadInspectionSchema.parse(result);
    },
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
      const notifications = notificationTarget(manager);
      if (!notifications?.addNotificationCallback) {
        throw new Error("Renderer Usage notification callback is unavailable");
      }
      let disposed = false;
      const generations = new Map<ThreadUsageInspectionParams["threadId"], number>();
      const removeNotificationCallback = notifications.addNotificationCallback(
        [THREAD_TOKEN_USAGE_UPDATED_METHOD, THREAD_USAGE_UPDATED_METHOD],
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
    async checkUpdate(): Promise<UpdateCheckResult> {
      const result = await manager.sendRequest(
        UPDATE_CHECK_METHOD,
        updateEmptyParamsSchema.parse({}),
      );
      return updateCheckResultSchema.parse(result);
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
  });
}
