import { Buffer } from "node:buffer";

import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessPermissionModeId,
  HarnessSessionState,
  HarnessThinkingOption,
  HarnessThinkingOptionId,
} from "@codexhost/harness-adapter";
import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";

const GROK_MODEL_REF_PREFIX = "grok-model-v1.";

export interface GrokModelState {
  catalog: HarnessModelCatalog;
  currentModel: HarnessModelRef;
  currentThinkingOptionId?: HarnessThinkingOptionId;
  contextWindowTokensByModel: ReadonlyMap<string, number>;
  defaultContextWindowTokensByModel: ReadonlyMap<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function encodeGrokModelRef(value: string): HarnessModelRef {
  if (!nonBlank(value)) throw new Error("Grok Model ID must not be blank");
  const plain = harnessModelRefSchema.safeParse({ id: value });
  if (plain.success && !value.startsWith(GROK_MODEL_REF_PREFIX)) return plain.data;

  const id = `${GROK_MODEL_REF_PREFIX}${Buffer.from(value, "utf8").toString("base64url")}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("Grok Model ID is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeGrokModelRef(ref: HarnessModelRef): string {
  const parsed = harnessModelRefSchema.parse(ref);
  if (!parsed.id.startsWith(GROK_MODEL_REF_PREFIX)) return parsed.id;

  const encoded = parsed.id.slice(GROK_MODEL_REF_PREFIX.length);
  if (encoded.length === 0) throw new Error("Grok Model Ref is empty");
  let value: string;
  try {
    value = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("Grok Model Ref is malformed");
  }
  if (!nonBlank(value) || encodeGrokModelRef(value).id !== parsed.id) {
    throw new Error("Grok Model Ref is not canonical");
  }
  return value;
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

export function parseGrokModelState(value: unknown): GrokModelState | null {
  if (
    !isRecord(value) ||
    !nonBlank(value.currentModelId) ||
    !Array.isArray(value.availableModels)
  ) {
    return null;
  }
  let currentModel: HarnessModelRef;
  try {
    currentModel = encodeGrokModelRef(value.currentModelId);
  } catch {
    return null;
  }

  const allThinking = new Map<string, HarnessThinkingOption>();
  const contextWindowTokensByModel = new Map<string, number>();
  const defaultContextWindowTokensByModel = new Map<string, number>();
  const models: HarnessModelCatalog["models"] = [];
  let currentThinkingOptionId: HarnessThinkingOptionId | undefined;
  for (const candidate of value.availableModels) {
    if (!isRecord(candidate) || !nonBlank(candidate.modelId) || !nonBlank(candidate.name)) continue;
    let ref: HarnessModelRef;
    try {
      ref = encodeGrokModelRef(candidate.modelId);
    } catch {
      continue;
    }
    const metadata = isRecord(candidate._meta) ? candidate._meta : {};
    const options = thinkingOptions(metadata.reasoningEfforts);
    if (Array.isArray(metadata.contextWindows) && metadata.contextWindows.includes(500_000)) {
      defaultContextWindowTokensByModel.set(ref.id, 500_000);
    }
    if (
      typeof metadata.totalContextTokens === "number" &&
      Number.isSafeInteger(metadata.totalContextTokens) &&
      metadata.totalContextTokens > 0
    ) {
      contextWindowTokensByModel.set(ref.id, metadata.totalContextTokens);
    }
    for (const option of options) allThinking.set(option.id, option);
    if (candidate.modelId === value.currentModelId && nonBlank(metadata.reasoningEffort)) {
      const parsed = harnessThinkingOptionIdSchema.safeParse(metadata.reasoningEffort);
      if (parsed.success && options.some(({ id }) => id === parsed.data)) {
        currentThinkingOptionId = parsed.data;
      }
    }
    models.push({
      ref,
      label: candidate.name,
      ...(options.length > 0 ? { supportedThinkingOptionIds: options.map(({ id }) => id) } : {}),
    });
  }
  if (!models.some(({ ref }) => ref.id === currentModel.id)) return null;
  const options = [...allThinking.values()];
  return {
    currentModel,
    contextWindowTokensByModel,
    defaultContextWindowTokensByModel,
    ...(currentThinkingOptionId ? { currentThinkingOptionId } : {}),
    catalog: {
      models,
      defaultModel: currentModel,
      thinkingOptions: options,
      ...(currentThinkingOptionId ? { defaultThinkingOptionId: currentThinkingOptionId } : {}),
    },
  };
}

export function modelStateFromInitialize(response: InitializeResponse): GrokModelState | null {
  return parseGrokModelState(isRecord(response._meta) ? response._meta.modelState : undefined);
}

export function modelStateFromSessionResponse(response: unknown): GrokModelState | null {
  return parseGrokModelState(isRecord(response) ? response.models : undefined);
}

export function stateForGrokModel(
  modelState: GrokModelState,
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
