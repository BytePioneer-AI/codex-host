import { Buffer } from "node:buffer";

import type { Model, Provider } from "@opencode-ai/sdk/v2";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
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

export function encodeOpenCodeModelRef(model: OpenCodeNativeModelRef): HarnessModelRef {
  assertNonBlank(model.providerID, "Provider ID");
  assertNonBlank(model.modelID, "Model ID");
  const encoded = Buffer.from(JSON.stringify([model.providerID, model.modelID]), "utf8").toString(
    "base64url",
  );
  const id = `${MODEL_REF_PREFIX}${encoded}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("OpenCode Model identity is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeOpenCodeModelRef(ref: HarnessModelRef): OpenCodeNativeModelRef {
  const parsed = harnessModelRefSchema.parse(ref);
  if (!parsed.id.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("OpenCode Model Ref belongs to another Adapter");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(parsed.id.slice(MODEL_REF_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("OpenCode Model Ref is malformed");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new Error("OpenCode Model Ref has an invalid native identity");
  }
  const native = { providerID: decoded[0], modelID: decoded[1] };
  if (encodeOpenCodeModelRef(native).id !== parsed.id) {
    throw new Error("OpenCode Model Ref is not canonical");
  }
  return native;
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
): HarnessModelCatalog {
  const nativeModels = modelsForConnectedProviders(catalog);
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
      ref: encodeOpenCodeModelRef({ providerID: provider.id, modelID: model.id }),
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
  const defaultModel = defaultNative ? encodeOpenCodeModelRef(defaultNative) : undefined;
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel && models.some(({ ref }) => ref.id === defaultModel.id)
      ? { defaultModel }
      : {}),
    thinkingOptions,
    defaultThinkingOptionId: DEFAULT_VARIANT_ID,
  });
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
