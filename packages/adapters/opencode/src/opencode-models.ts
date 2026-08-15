import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessSessionState,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";
import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

export interface OpenCodeModelState {
  catalog: HarnessModelCatalog;
  currentModel: HarnessModelRef;
  currentThinkingOptionId?: HarnessThinkingOptionId;
  contextWindowTokensByModel: ReadonlyMap<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OPENCODE_MODEL_ID_ENCODINGS: ReadonlyArray<readonly [string, string]> = [
  ["~", "~7e"],
  ["/", "~2f"],
];

export function encodeOpenCodeModelId(id: string): string {
  return OPENCODE_MODEL_ID_ENCODINGS.reduce(
    (result, [literal, encoded]) => result.replaceAll(literal, encoded),
    id,
  );
}

export function decodeOpenCodeModelId(id: string): string {
  return OPENCODE_MODEL_ID_ENCODINGS.reduce(
    (result, [literal, encoded]) => result.replaceAll(encoded, literal),
    id,
  );
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionId(value: unknown): string | null {
  if (nonBlank(value)) return value;
  if (isRecord(value) && nonBlank(value.value)) return String(value.value);
  return null;
}

function thinkingOptions(value: unknown): HarnessThinkingOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: HarnessThinkingOption[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonBlank(candidate.label)) continue;
    const id = harnessThinkingOptionIdSchema.safeParse(optionId(candidate));
    if (!id.success || seen.has(id.data)) continue;
    seen.add(id.data);
    options.push({ id: id.data, label: candidate.label });
  }
  return options;
}

function selectOptions(value: unknown): Array<{ id: string; name: string }> {
  if (!isRecord(value) || !Array.isArray(value.options)) return [];
  const options: Array<{ id: string; name: string }> = [];
  for (const candidate of value.options) {
    if (!isRecord(candidate)) continue;
    const id = optionId(candidate);
    const name = nonBlank(candidate.name) ? candidate.name : id;
    if (id && name) options.push({ id: encodeOpenCodeModelId(id), name });
  }
  return options;
}

function currentValue(value: unknown): string | undefined {
  return isRecord(value) && nonBlank(value.currentValue) ? value.currentValue : undefined;
}

function isModelOption(category: unknown): boolean {
  return category === "model";
}

function isEffortOption(category: unknown): boolean {
  return category === "thought_level";
}

export function parseOpenCodeModelState(value: unknown): OpenCodeModelState | null {
  if (!Array.isArray(value)) return null;
  const modelOption = value.find((candidate) => isRecord(candidate) && isModelOption(candidate.category));
  const effortOption = value.find((candidate) => isRecord(candidate) && isEffortOption(candidate.category));
  const modelValues = modelOption ? selectOptions(modelOption) : [];
  const currentModelId = modelOption ? currentValue(modelOption) : undefined;
  if (!currentModelId || modelValues.length === 0) return null;
  const currentModel = harnessModelRefSchema.safeParse({
    id: encodeOpenCodeModelId(currentModelId),
  });
  if (!currentModel.success) return null;
  if (!modelValues.some(({ id }) => id === currentModel.data.id)) return null;

  const allThinking = new Map<string, HarnessThinkingOption>();
  const contextWindowTokensByModel = new Map<string, number>();
  const models: HarnessModelCatalog["models"] = [];
  let currentThinkingOptionId: HarnessThinkingOptionId | undefined;
  const effortValues = effortOption ? selectOptions(effortOption) : [];
  const effortOptions = thinkingOptions(
    effortValues.map(({ id, name }) => ({ value: id, label: name })),
  );
  for (const option of effortOptions) allThinking.set(option.id, option);
  const currentEffort = effortOption ? currentValue(effortOption) : undefined;
  if (currentEffort) {
    const parsed = harnessThinkingOptionIdSchema.safeParse(currentEffort);
    if (parsed.success && effortOptions.some(({ id }) => id === parsed.data)) {
      currentThinkingOptionId = parsed.data;
    }
  }
  const sharedThinkingOptionIds = effortOptions.map(({ id }) => id);
  for (const candidate of modelValues) {
    const ref = harnessModelRefSchema.safeParse({ id: candidate.id });
    if (!ref.success) continue;
    const metadata: Record<string, unknown> = isRecord(candidate) ? candidate : {};
    const options = thinkingOptions(metadata.supportedThinkingOptionIds ?? metadata.reasoningEfforts);
    for (const option of options) allThinking.set(option.id, option);
    const supportedThinkingOptionIds = [...sharedThinkingOptionIds, ...options.map(({ id }) => id)];
    if (
      typeof metadata.totalContextTokens === "number" &&
      Number.isSafeInteger(metadata.totalContextTokens) &&
      metadata.totalContextTokens > 0
    ) {
      contextWindowTokensByModel.set(ref.data.id, metadata.totalContextTokens);
    }
    models.push({
      ref: ref.data,
      label: candidate.name,
      ...(supportedThinkingOptionIds.length > 0
        ? { supportedThinkingOptionIds }
        : {}),
    });
  }
  const options = [...allThinking.values()];
  if (!currentThinkingOptionId && options.length > 0) {
    currentThinkingOptionId = options[0]?.id;
  }
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

export function modelStateFromInitialize(response: InitializeResponse): OpenCodeModelState | null {
  return parseOpenCodeModelState(isRecord(response._meta) ? response._meta.modelState : undefined);
}

export function modelStateFromSessionResponse(response: unknown): OpenCodeModelState | null {
  return parseOpenCodeModelState(
    isRecord(response) && Array.isArray(response.configOptions) ? response.configOptions : undefined,
  );
}

export function stateForOpenCodeModel(
  modelState: OpenCodeModelState,
  nativeState: Pick<HarnessSessionState, "nativeRef">,
  model = modelState.currentModel,
  thinkingOptionId = modelState.currentThinkingOptionId,
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
    ...(availableThinkingOptions ? { availableThinkingOptions } : {}),
  };
}
