import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessPermissionModeId,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";

export interface QwenCodeModelState {
  catalog: HarnessModelCatalog;
  currentModel: HarnessModelRef;
  contextWindowTokensByModel: ReadonlyMap<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function legacyAliasBase(id: string): string {
  return id.replace(/[^A-Za-z0-9._~-]/gu, "-").replace(/^-+|-+$/gu, "") || "qwen-model";
}

export function normalizeStoredQwenCodeModelRef(
  ref: HarnessModelRef,
  catalog: HarnessModelCatalog,
): HarnessModelRef | undefined {
  if (ref.serviceTier) return undefined;
  const matches = catalog.models.filter(
    ({ ref: candidate }) => !candidate.serviceTier && legacyAliasBase(candidate.id) === ref.id,
  );
  return matches.length === 1 ? matches[0]?.ref : undefined;
}

export function parseQwenCodeModelState(value: unknown): QwenCodeModelState | null {
  if (
    !isRecord(value) ||
    typeof value.currentModelId !== "string" ||
    !Array.isArray(value.availableModels)
  ) {
    return null;
  }
  const contextWindowTokensByModel = new Map<string, number>();
  const models: HarnessModelCatalog["models"] = [];
  const seenNativeModelIds = new Set<string>();
  let currentModel: HarnessModelRef | null = null;
  for (const candidate of value.availableModels) {
    if (!isRecord(candidate) || !nonBlank(candidate.name)) continue;
    const ref = harnessModelRefSchema.safeParse({ id: candidate.modelId });
    if (!ref.success || seenNativeModelIds.has(ref.data.id)) continue;
    seenNativeModelIds.add(ref.data.id);
    const metadata = isRecord(candidate._meta) ? candidate._meta : {};
    if (
      typeof metadata.contextLimit === "number" &&
      Number.isSafeInteger(metadata.contextLimit) &&
      metadata.contextLimit > 0
    ) {
      contextWindowTokensByModel.set(ref.data.id, metadata.contextLimit);
    }
    const model: HarnessModelCatalog["models"][number] = { ref: ref.data, label: candidate.name };
    models.push(model);
    if (candidate.modelId === value.currentModelId) {
      currentModel = ref.data;
    }
  }
  if (!currentModel) return null;
  return {
    currentModel,
    contextWindowTokensByModel,
    catalog: {
      models,
      defaultModel: currentModel,
      thinkingOptions: [],
    },
  };
}

export function stateForQwenCodeModel(
  modelState: QwenCodeModelState,
  nativeState: Pick<HarnessSessionState, "nativeRef">,
  model = modelState.currentModel,
  permissionModeId?: HarnessPermissionModeId,
): HarnessSessionState {
  return {
    ...nativeState,
    effectiveModel: model,
    ...(permissionModeId ? { effectivePermissionModeId: permissionModeId } : {}),
  };
}
