import {
  externalThreadForkParamsSchema,
  externalThreadForkResultSchema,
  harnessConfigurationStateSchema,
  harnessInspectParamsSchema,
  harnessInspectionSchema,
  harnessModelSelectionStateSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
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
  type HarnessConfigurationState,
  type HarnessInspection,
  type HarnessInspectParams,
  type HarnessModelSelectionState,
  type ThreadInspection,
  type ThreadInspectionParams,
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
export const THREAD_FORK_METHOD = "codexhost/thread/fork";
export const THREAD_INSPECT_METHOD = "codexhost/thread/inspect";
export const THREAD_MODEL_SELECT_METHOD = "codexhost/thread/model/select";
export const THREAD_THINKING_SELECT_METHOD = "codexhost/thread/thinking/select";
export const THREAD_PERMISSION_MODE_SELECT_METHOD = "codexhost/thread/permission-mode/select";
export const THREAD_OWNERSHIP_LIST_METHOD = "codexhost/thread/ownership/list";
export const THREAD_USAGE_INSPECT_METHOD = "codexhost/thread/usage/inspect";
export const UPDATE_CHECK_METHOD = "codexhost/update/check";
export const UPDATE_START_METHOD = "codexhost/update/start";
export const UPDATE_STATUS_METHOD = "codexhost/update/status";

interface RequestManagerCandidate {
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
}

export interface RendererModelClient {
  forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult>;
  inspectHarness(input: HarnessInspectParams): Promise<HarnessInspection>;
  inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection>;
  listThreadOwnership(input: ThreadOwnershipListParams): Promise<ThreadOwnershipListResult>;
  inspectThreadUsage(input: ThreadUsageInspectionParams): Promise<ThreadUsageInspection>;
  selectThreadModel(input: ThreadModelSelectParams): Promise<HarnessModelSelectionState>;
  selectThreadThinking(input: ThreadThinkingSelectParams): Promise<HarnessModelSelectionState>;
  selectThreadPermissionMode(
    input: ThreadPermissionModeSelectParams,
  ): Promise<HarnessConfigurationState>;
  checkUpdate(): Promise<UpdateCheckResult>;
  startUpdate(): Promise<UpdateStartResult>;
  readUpdateStatus(): Promise<UpdateStatusResult>;
}

export function createRendererModelClient(
  candidates: readonly RequestManagerCandidate[],
): RendererModelClient | null {
  const managers = candidates.filter(
    (candidate): candidate is Required<Pick<RequestManagerCandidate, "sendRequest">> =>
      typeof candidate.sendRequest === "function",
  );
  const manager = managers[0];
  if (managers.length !== 1 || !manager) return null;

  const inspectHarness = async (input: HarnessInspectParams): Promise<HarnessInspection> => {
    const params = harnessInspectParamsSchema.parse(input);
    const result = await manager.sendRequest(HARNESS_INSPECT_METHOD, params);
    return harnessInspectionSchema.parse(result);
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
    async forkThread(input: ExternalThreadForkParams): Promise<ExternalThreadForkResult> {
      const params = externalThreadForkParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_FORK_METHOD, params);
      return externalThreadForkResultSchema.parse(result);
    },
    inspectHarness,
    async inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection> {
      const params = threadInspectionParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_INSPECT_METHOD, params);
      return threadInspectionSchema.parse(result);
    },
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
