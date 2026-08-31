import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessPermissionModeId,
  HarnessSessionState,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";
import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

export interface GeminiModelState {
  catalog: HarnessModelCatalog;
  currentModel: HarnessModelRef;
  currentThinkingOptionId?: HarnessThinkingOptionId;
  contextWindowTokensByModel: ReadonlyMap<string, number>;
}

/**
 * Build the conservative catalog available before opening an ACP session.
 * Gemini exposes its authoritative catalog on session/new and session/load,
 * while Host inspection must not create a persisted native session.
 */
export function modelStateFromConfiguredOptions(
  configuredModel?: string,
  configuredModels?: readonly string[],
): GeminiModelState {
  const ids = [...new Set((configuredModels ?? []).filter(nonBlank))];
  const selectedId =
    configuredModel && ids.includes(configuredModel)
      ? configuredModel
      : (ids[0] ?? configuredModel ?? "auto");
  if (!ids.includes(selectedId)) ids.unshift(selectedId);
  const models = ids.map((id) => ({ ref: harnessModelRefSchema.parse({ id }), label: id }));
  const currentModel = models.find(({ ref }) => ref.id === selectedId)?.ref;
  if (!currentModel) throw new Error("Gemini configured model catalog is empty");
  return {
    currentModel,
    contextWindowTokensByModel: new Map(),
    catalog: { models, defaultModel: currentModel, thinkingOptions: [] },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function thinkingOptions(value: unknown): HarnessThinkingOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: HarnessThinkingOption[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonBlank(candidate.label)) continue;
    const id = harnessThinkingOptionIdSchema.safeParse(candidate.id ?? candidate.value);
    if (!id.success || seen.has(id.data)) continue;
    seen.add(id.data);
    options.push({ id: id.data, label: candidate.label });
  }
  return options;
}

export function parseGeminiModelState(value: unknown): GeminiModelState | null {
  if (!isRecord(value)) {
    return null;
  }
  const modelContainer =
    isRecord(value.models) && Array.isArray(value.models.availableModels) ? value.models : value;
  if (!nonBlank(modelContainer.currentModelId) || !Array.isArray(modelContainer.availableModels))
    return null;
  const currentModel = harnessModelRefSchema.safeParse({ id: modelContainer.currentModelId });
  if (!currentModel.success) return null;

  const allThinking = new Map<string, HarnessThinkingOption>();
  const contextWindowTokensByModel = new Map<string, number>();
  const models: HarnessModelCatalog["models"] = [];
  let currentThinkingOptionId: HarnessThinkingOptionId | undefined;
  for (const candidate of modelContainer.availableModels) {
    if (!isRecord(candidate)) continue;
    const modelId = candidate.modelId ?? candidate.id;
    const label = candidate.name ?? candidate.label ?? modelId;
    if (!nonBlank(modelId) || !nonBlank(label)) continue;
    const ref = harnessModelRefSchema.safeParse({ id: modelId });
    if (!ref.success) continue;
    const metadata = isRecord(candidate._meta) ? candidate._meta : {};
    const options = thinkingOptions(metadata.reasoningEfforts);
    if (
      typeof metadata.totalContextTokens === "number" &&
      Number.isSafeInteger(metadata.totalContextTokens) &&
      metadata.totalContextTokens > 0
    ) {
      contextWindowTokensByModel.set(ref.data.id, metadata.totalContextTokens);
    }
    for (const option of options) allThinking.set(option.id, option);
    if (modelId === modelContainer.currentModelId && nonBlank(metadata.reasoningEffort)) {
      const parsed = harnessThinkingOptionIdSchema.safeParse(metadata.reasoningEffort);
      if (parsed.success && options.some(({ id }) => id === parsed.data)) {
        currentThinkingOptionId = parsed.data;
      }
    }
    models.push({
      ref: ref.data,
      label,
      ...(options.length > 0 ? { supportedThinkingOptionIds: options.map(({ id }) => id) } : {}),
    });
  }
  if (!models.some(({ ref }) => ref.id === currentModel.data.id)) return null;
  const options = [...allThinking.values()];
  return {
    currentModel: currentModel.data,
    contextWindowTokensByModel,
    ...(currentThinkingOptionId ? { currentThinkingOptionId } : {}),
    catalog: {
      models,
      defaultModel: currentModel.data,
      thinkingOptions: options,
      ...(currentThinkingOptionId ? { defaultThinkingOptionId: currentThinkingOptionId } : {}),
    },
  };
}

export function modelStateFromInitialize(response: InitializeResponse): GeminiModelState | null {
  return parseGeminiModelState(isRecord(response._meta) ? response._meta.modelState : undefined);
}

export function modelStateFromSessionResponse(response: unknown): GeminiModelState | null {
  return parseGeminiModelState(isRecord(response) ? response.models : undefined);
}

export function stateForGeminiModel(
  modelState: GeminiModelState,
  nativeState: Pick<HarnessSessionState, "nativeRef">,
  model = modelState.currentModel,
  thinkingOptionId = modelState.currentThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
): HarnessSessionState {
  const selectedModel = model;
  const catalogModel = modelState.catalog.models.find(({ ref }) => ref.id === selectedModel.id);
  const availableThinkingOptions = catalogModel?.supportedThinkingOptionIds?.flatMap((id) => {
    const option = modelState.catalog.thinkingOptions.find((candidate) => candidate.id === id);
    return option ? [option] : [];
  });
  return {
    ...nativeState,
    effectiveModel: selectedModel,
    ...(thinkingOptionId ? { effectiveThinkingOptionId: thinkingOptionId } : {}),
    ...(permissionModeId ? { effectivePermissionModeId: permissionModeId } : {}),
    ...(availableThinkingOptions ? { availableThinkingOptions } : {}),
  };
}
