import { Buffer } from "node:buffer";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
} from "@codexhost/shared-contracts";

const MODEL_REF_PREFIX = "deepseek-harness-model-v2.";
const LEGACY_MODEL_REF_PREFIX = "deepseek-harness-model-v1.";

export interface DeepSeekNativeModelRef {
  provider: string;
  model: string;
}

export interface DeepSeekModelSelection extends DeepSeekNativeModelRef {
  reasoningEffort?: string;
}

export interface DeepSeekModelProviderGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly reasoning?: {
      readonly efforts: readonly {
        readonly id: string;
        readonly name: string;
        readonly description?: string;
      }[];
      readonly defaultEffort?: string;
    };
  }[];
}

export interface DeepSeekSessionModels {
  readonly current: DeepSeekModelSelection;
  readonly groups: readonly DeepSeekModelProviderGroup[];
}

export function encodeDeepSeekHarnessModelRef(model: DeepSeekNativeModelRef): HarnessModelRef {
  const provider = model.provider.trim();
  const modelId = model.model.trim();
  if (!provider || !modelId) throw new Error("DeepSeek Harness Model identity must not be empty");
  const encoded = Buffer.from(JSON.stringify([provider, modelId]), "utf8").toString("base64url");
  const id = `${MODEL_REF_PREFIX}${encoded}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("DeepSeek Harness Model is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeDeepSeekHarnessModelRef(ref: HarnessModelRef): DeepSeekNativeModelRef {
  const parsed = harnessModelRefSchema.parse(ref);
  if (parsed.id.startsWith(LEGACY_MODEL_REF_PREFIX)) {
    const encoded = parsed.id.slice(LEGACY_MODEL_REF_PREFIX.length);
    const model = Buffer.from(encoded, "base64url").toString("utf8");
    if (!encoded || !model) throw new Error("DeepSeek Harness legacy Model Ref is invalid");
    return { provider: "deepseek-official", model };
  }
  if (!parsed.id.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("DeepSeek Harness Model Ref belongs to another Adapter");
  }
  const encoded = parsed.id.slice(MODEL_REF_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("DeepSeek Harness Model Ref is invalid");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new Error("DeepSeek Harness Model Ref is invalid");
  }
  const native = { provider: decoded[0], model: decoded[1] };
  if (encodeDeepSeekHarnessModelRef(native).id !== parsed.id) {
    throw new Error("DeepSeek Harness Model Ref is not canonical");
  }
  return native;
}

/** Adapter-owned reasoning effort identifier when the Host reports one. */
export function parseDeepSeekThinkingOptionId(
  value: string | undefined,
): HarnessThinkingOption["id"] | undefined {
  if (value === undefined) return undefined;
  const parsed = harnessThinkingOptionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Thinking options advertised by the exact Model route the Session currently serves. */
export function normalizeDeepSeekThinkingOptions(
  models: DeepSeekSessionModels,
): HarnessThinkingOption[] {
  const group = models.groups.find((candidate) => candidate.id === models.current.provider);
  const model = group?.models.find((candidate) => candidate.id === models.current.model);
  return (model?.reasoning?.efforts ?? []).flatMap((effort) => {
    const parsedId = harnessThinkingOptionIdSchema.safeParse(effort.id);
    return parsedId.success ? [{ id: parsedId.data, label: effort.name }] : [];
  });
}

export function normalizeDeepSeekModelCatalog(
  groups: readonly DeepSeekModelProviderGroup[],
  selection?: DeepSeekModelSelection,
): HarnessModelCatalog {
  const thinkingOptions: HarnessThinkingOption[] = [];
  const knownEffortIds = new Set<string>();
  for (const group of groups) {
    for (const model of group.models) {
      for (const effort of model.reasoning?.efforts ?? []) {
        if (knownEffortIds.has(effort.id)) continue;
        const parsedId = harnessThinkingOptionIdSchema.safeParse(effort.id);
        if (!parsedId.success) continue;
        knownEffortIds.add(effort.id);
        thinkingOptions.push({ id: parsedId.data, label: effort.name });
      }
    }
  }
  const models = groups.flatMap((group) =>
    group.models.map((model) => ({
      ref: encodeDeepSeekHarnessModelRef({ provider: group.id, model: model.id }),
      label: `${group.name} / ${model.name}`,
      ...(model.reasoning && model.reasoning.efforts.length > 0
        ? { supportedThinkingOptionIds: model.reasoning.efforts.map((effort) => effort.id) }
        : {}),
    })),
  );
  const defaultModel = selection ? encodeDeepSeekHarnessModelRef(selection) : undefined;
  if (selection && defaultModel && !models.some((model) => model.ref.id === defaultModel.id)) {
    models.unshift({ ref: defaultModel, label: `${selection.provider} / ${selection.model}` });
  }
  const defaultReasoning = selection
    ? groups
        .find((group) => group.id === selection.provider)
        ?.models.find((model) => model.id === selection.model)?.reasoning
    : undefined;
  const defaultThinkingOptionId = parseDeepSeekThinkingOptionId(
    selection?.reasoningEffort ?? defaultReasoning?.defaultEffort,
  );
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions,
    ...(defaultThinkingOptionId &&
    defaultReasoning?.efforts.some((effort) => effort.id === defaultThinkingOptionId)
      ? { defaultThinkingOptionId }
      : {}),
  });
}
