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
  nativeModelIdByRef: ReadonlyMap<string, string>;
  contextWindowTokensByModel: ReadonlyMap<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Qwen Code reports native Model IDs such as `GLM-5.3-flash(openai)` or
 * `qwen-route:v1:...`, while Harness Model Refs only accept
 * `[A-Za-z0-9._~-]`. Ref IDs are therefore sanitized, and the native ID is
 * recovered through an explicit mapping when configuring the native CLI.
 */
export function sanitizeQwenCodeModelRefId(nativeModelId: string, taken: Set<string>): string {
  const sanitized = nativeModelId
    .replace(/[^A-Za-z0-9._~-]/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  const base = sanitized.length > 0 ? sanitized : "qwen-model";
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

export function parseQwenCodeModelState(value: unknown): QwenCodeModelState | null {
  if (
    !isRecord(value) ||
    !nonBlank(value.currentModelId) ||
    !Array.isArray(value.availableModels)
  ) {
    return null;
  }
  const nativeModelIdByRef = new Map<string, string>();
  const contextWindowTokensByModel = new Map<string, number>();
  const models: HarnessModelCatalog["models"] = [];
  const takenRefs = new Set<string>();
  let currentModel: HarnessModelRef | null = null;
  for (const candidate of value.availableModels) {
    if (!isRecord(candidate) || !nonBlank(candidate.modelId) || !nonBlank(candidate.name)) continue;
    if (nativeModelIdByRef.has(candidate.modelId) && candidate.modelId !== value.currentModelId) {
      continue;
    }
    const refId = sanitizeQwenCodeModelRefId(candidate.modelId, takenRefs);
    const ref = harnessModelRefSchema.safeParse({ id: refId });
    if (!ref.success) continue;
    takenRefs.add(refId);
    nativeModelIdByRef.set(refId, candidate.modelId);
    const metadata = isRecord(candidate._meta) ? candidate._meta : {};
    if (
      typeof metadata.contextLimit === "number" &&
      Number.isSafeInteger(metadata.contextLimit) &&
      metadata.contextLimit > 0
    ) {
      contextWindowTokensByModel.set(refId, metadata.contextLimit);
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
    nativeModelIdByRef,
    contextWindowTokensByModel,
    catalog: {
      models,
      defaultModel: currentModel,
      thinkingOptions: [],
    },
  };
}

export function nativeModelIdForRef(
  modelState: QwenCodeModelState,
  model: HarnessModelRef,
): string | undefined {
  return modelState.nativeModelIdByRef.get(model.id);
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
