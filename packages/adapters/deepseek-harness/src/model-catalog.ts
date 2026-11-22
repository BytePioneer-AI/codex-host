import { Buffer } from "node:buffer";
import { compositeModelRefIds } from "@codexhost/harness-adapter";

import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
} from "@codexhost/shared-contracts";

const MODEL_REF_PREFIX = "deepseek-harness-model-v2.";

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

function readableId({ provider, model }: DeepSeekNativeModelRef): string {
  return `${provider}/${model}`;
}

function legacyId({ provider, model }: DeepSeekNativeModelRef): string {
  return MODEL_REF_PREFIX + Buffer.from(JSON.stringify([provider, model])).toString("base64url");
}

function sameModel(a: DeepSeekNativeModelRef, b: DeepSeekNativeModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function modelIndex(models: DeepSeekNativeModelRef[]) {
  const ids = compositeModelRefIds(
    [...new Map(models.map((model) => [legacyId(model), model])).values()],
    legacyId,
  );
  const readable = new Set(models.map(readableId));
  const byIdentity = new Map<string, HarnessModelRef>();
  const byLegacy = new Map<string, HarnessModelRef | null>();
  for (const [id, model] of ids) {
    const ref = harnessModelRefSchema.parse({ id });
    byIdentity.set(legacyId(model), ref);
    const oldId = legacyId({ provider: model.provider.trim(), model: model.model.trim() });
    const other = byLegacy.get(oldId);
    byLegacy.set(oldId, other === undefined ? ref : null);
  }
  const encode = (model: DeepSeekNativeModelRef): HarnessModelRef => {
    if (!model.provider.trim() || !model.model.trim()) {
      throw new Error("DeepSeek Harness Model identity must not be empty");
    }
    const id = readableId(model);
    return (
      byIdentity.get(legacyId(model)) ??
      harnessModelRefSchema.parse({
        id: readable.has(id) ? legacyId(model) : id,
      })
    );
  };
  return { encode, ids, byLegacy };
}

export type DeepSeekModelIndex = ReturnType<typeof modelIndex>;

export function encodeDeepSeekHarnessModelRef(
  model: DeepSeekNativeModelRef,
  index?: DeepSeekModelIndex,
): HarnessModelRef {
  if (index) return index.encode(model);
  if (!model.provider.trim() || !model.model.trim()) {
    throw new Error("DeepSeek Harness Model identity must not be empty");
  }
  return harnessModelRefSchema.parse({ id: readableId(model) });
}

export function decodeDeepSeekHarnessModelRef(
  ref: HarnessModelRef,
  index: DeepSeekModelIndex,
): DeepSeekNativeModelRef {
  const model = !ref.serviceTier && index.ids.get(ref.id);
  if (!model) throw new Error("DeepSeek Harness Model is unavailable");
  return model;
}

export function normalizeStoredDeepSeekModelRef(ref: HarnessModelRef, index: DeepSeekModelIndex) {
  return ref.serviceTier ? undefined : (index.byLegacy.get(ref.id) ?? undefined);
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
): { catalog: HarnessModelCatalog; index: DeepSeekModelIndex } {
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
  const identities = groups.flatMap((group) =>
    group.models.map((model) => ({ provider: group.id, model: model.id })),
  );
  if (selection && !identities.some((model) => sameModel(model, selection))) {
    identities.push({ provider: selection.provider, model: selection.model });
  }
  const index = modelIndex(identities);
  const models = groups.flatMap((group) =>
    group.models.map((model) => ({
      ref: index.encode({ provider: group.id, model: model.id }),
      label: `${group.name} / ${model.name}`,
      ...(model.reasoning && model.reasoning.efforts.length > 0
        ? { supportedThinkingOptionIds: model.reasoning.efforts.map((effort) => effort.id) }
        : {}),
    })),
  );
  const defaultModel = selection ? index.encode(selection) : undefined;
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
  const catalog = harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions,
    ...(defaultThinkingOptionId &&
    defaultReasoning?.efforts.some((effort) => effort.id === defaultThinkingOptionId)
      ? { defaultThinkingOptionId }
      : {}),
  });
  return { catalog, index };
}
