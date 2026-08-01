import {
  harnessInspectParamsSchema,
  harnessInspectionSchema,
  harnessModelSelectionStateSchema,
  threadInspectionParamsSchema,
  threadInspectionSchema,
  threadModelSelectParamsSchema,
  type HarnessInspection,
  type HarnessInspectParams,
  type HarnessModelSelectionState,
  type ThreadInspection,
  type ThreadInspectionParams,
  type ThreadModelSelectParams,
} from "@codexhost/shared-contracts";

export const HARNESS_INSPECT_METHOD = "codexhost/harness/inspect";
export const THREAD_INSPECT_METHOD = "codexhost/thread/inspect";
export const THREAD_MODEL_SELECT_METHOD = "codexhost/thread/model/select";

interface RequestManagerCandidate {
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
}

export interface RendererModelClient {
  inspectPi(input: HarnessInspectParams): Promise<HarnessInspection>;
  inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection>;
  selectPiThreadModel(input: ThreadModelSelectParams): Promise<HarnessModelSelectionState>;
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

  return Object.freeze({
    async inspectPi(input: HarnessInspectParams): Promise<HarnessInspection> {
      const params = harnessInspectParamsSchema.parse(input);
      const result = await manager.sendRequest(HARNESS_INSPECT_METHOD, params);
      return harnessInspectionSchema.parse(result);
    },
    async inspectThread(input: ThreadInspectionParams): Promise<ThreadInspection> {
      const params = threadInspectionParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_INSPECT_METHOD, params);
      return threadInspectionSchema.parse(result);
    },
    async selectPiThreadModel(input: ThreadModelSelectParams): Promise<HarnessModelSelectionState> {
      const params = threadModelSelectParamsSchema.parse(input);
      const result = await manager.sendRequest(THREAD_MODEL_SELECT_METHOD, params);
      return harnessModelSelectionStateSchema.parse(result);
    },
  });
}
