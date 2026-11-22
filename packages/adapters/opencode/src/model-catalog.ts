import { Buffer } from "node:buffer";

import type { Model, Provider } from "@opencode-ai/sdk/v2";
import { compositeModelRefIds } from "@codexhost/harness-adapter";

import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

const MODEL_REF_PREFIX = "opencode-model-v1.";
const VARIANT_REF_PREFIX = "ocv.";
const DEFAULT_VARIANT_ID = harnessThinkingOptionIdSchema.parse("ocv.default");

export interface OpenCodeNativeModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenCodeProviderCatalog {
  all: Provider[];
  default: Record<string, string>;
  connected: string[];
}

function assertNonBlank(value: string, label: string): void {
  if (!value.trim()) throw new Error(`OpenCode ${label} must not be empty`);
}

function readableId({ providerID, modelID }: OpenCodeNativeModelRef): string {
  return `${providerID}/${modelID}`;
}

function legacyId({ providerID, modelID }: OpenCodeNativeModelRef): string {
  return (
    MODEL_REF_PREFIX + Buffer.from(JSON.stringify([providerID, modelID])).toString("base64url")
  );
}

export function openCodeModelIndex(models: OpenCodeNativeModelRef[]) {
  const entries = new Map(
    models.map((native) => [
      legacyId(native),
      {
        provider: native.providerID,
        model: native.modelID,
        native,
      },
    ]),
  );
  const ids = compositeModelRefIds([...entries.values()], ({ native }) => legacyId(native));
  const readable = new Set(models.map(readableId));
  const byLegacy = new Map<string, HarnessModelRef>();
  for (const [id, { native }] of ids) {
    byLegacy.set(legacyId(native), harnessModelRefSchema.parse({ id }));
  }
  const encode = (model: OpenCodeNativeModelRef): HarnessModelRef => {
    assertNonBlank(model.providerID, "Provider ID");
    assertNonBlank(model.modelID, "Model ID");
    const id = readableId(model);
    return (
      byLegacy.get(legacyId(model)) ??
      harnessModelRefSchema.parse({
        id: readable.has(id) ? legacyId(model) : id,
      })
    );
  };
  return { encode, ids, byLegacy };
}

export type OpenCodeModelIndex = ReturnType<typeof openCodeModelIndex>;

export interface OpenCodeModelCatalogSnapshot {
  readonly catalog: HarnessModelCatalog;
  readonly index: OpenCodeModelIndex;
}

export function encodeOpenCodeModelRef(
  model: OpenCodeNativeModelRef,
  index?: OpenCodeModelIndex,
): HarnessModelRef {
  if (index) return index.encode(model);
  assertNonBlank(model.providerID, "Provider ID");
  assertNonBlank(model.modelID, "Model ID");
  return harnessModelRefSchema.parse({ id: readableId(model) });
}

export function decodeOpenCodeModelRef(
  ref: HarnessModelRef,
  index: OpenCodeModelIndex,
): OpenCodeNativeModelRef {
  const model = !ref.serviceTier && index.ids.get(ref.id)?.native;
  if (!model) throw new Error("OpenCode Model is absent from the connected Provider catalog");
  return model;
}

export function normalizeStoredOpenCodeModelRef(ref: HarnessModelRef, index: OpenCodeModelIndex) {
  return ref.serviceTier ? undefined : index.byLegacy.get(ref.id);
}

export function encodeOpenCodeVariant(variant: string | undefined): HarnessThinkingOptionId {
  if (variant === undefined) return DEFAULT_VARIANT_ID;
  assertNonBlank(variant, "Model variant");
  return harnessThinkingOptionIdSchema.parse(
    `${VARIANT_REF_PREFIX}${Buffer.from(variant, "utf8").toString("base64url")}`,
  );
}

export function decodeOpenCodeVariant(id: HarnessThinkingOptionId): string | undefined {
  const parsed = harnessThinkingOptionIdSchema.parse(id);
  if (parsed === DEFAULT_VARIANT_ID) return undefined;
  if (!parsed.startsWith(VARIANT_REF_PREFIX)) {
    throw new Error("OpenCode Thinking option belongs to another Adapter");
  }
  const encoded = parsed.slice(VARIANT_REF_PREFIX.length);
  const variant = Buffer.from(encoded, "base64url").toString("utf8");
  if (!encoded || !variant || encodeOpenCodeVariant(variant) !== parsed) {
    throw new Error("OpenCode Thinking option is malformed");
  }
  return variant;
}

function variantOption(variant: string | undefined): HarnessThinkingOption {
  return harnessThinkingOptionSchema.parse({
    id: encodeOpenCodeVariant(variant),
    label: variant ?? "Default",
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function modelsForConnectedProviders(catalog: OpenCodeProviderCatalog): Array<{
  provider: Provider;
  model: Model;
}> {
  const connected = new Set(catalog.connected);
  return catalog.all.flatMap((provider) =>
    connected.has(provider.id)
      ? Object.values(provider.models).map((model) => ({ provider, model }))
      : [],
  );
}

export function normalizeOpenCodeModelCatalog(
  catalog: OpenCodeProviderCatalog,
): OpenCodeModelCatalogSnapshot {
  const nativeModels = modelsForConnectedProviders(catalog);
  const index = openCodeModelIndex(
    nativeModels.map(({ provider, model }) => ({ providerID: provider.id, modelID: model.id })),
  );
  const variants = new Set<string>();
  for (const { model } of nativeModels) {
    for (const variant of Object.keys(model.variants ?? {})) variants.add(variant);
  }
  const thinkingOptions = [
    variantOption(undefined),
    ...[...variants].sort(compareText).map((variant) => variantOption(variant)),
  ];
  const models = nativeModels
    .map(({ provider, model }) => ({
      ref: index.encode({ providerID: provider.id, modelID: model.id }),
      label: `${provider.name} / ${model.name}`,
      resolvedModelLabel: `${provider.id}/${model.id}`,
      supportedThinkingOptionIds: [
        DEFAULT_VARIANT_ID,
        ...Object.keys(model.variants ?? {})
          .sort(compareText)
          .map(encodeOpenCodeVariant),
      ],
    }))
    .sort(
      (left, right) =>
        compareText(left.label, right.label) || compareText(left.ref.id, right.ref.id),
    );
  const defaultNative = catalog.connected
    .map((providerID) => ({ providerID, modelID: catalog.default[providerID] }))
    .find(
      (candidate): candidate is OpenCodeNativeModelRef =>
        typeof candidate.modelID === "string" && candidate.modelID.length > 0,
    );
  const defaultModel = defaultNative ? index.encode(defaultNative) : undefined;
  return {
    catalog: harnessModelCatalogSchema.parse({
      models,
      ...(defaultModel && models.some(({ ref }) => ref.id === defaultModel.id)
        ? { defaultModel }
        : {}),
      thinkingOptions,
      defaultThinkingOptionId: DEFAULT_VARIANT_ID,
    }),
    index,
  };
}

export function openCodeContextWindow(
  catalog: OpenCodeProviderCatalog,
  model: OpenCodeNativeModelRef,
): number | undefined {
  const provider = catalog.all.find(({ id }) => id === model.providerID);
  const context = provider?.models[model.modelID]?.limit.context;
  return typeof context === "number" && Number.isSafeInteger(context) && context > 0
    ? context
    : undefined;
}
