import { Buffer } from "node:buffer";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

const MODEL_REF_PREFIX = "penguin-model-v1.";

export interface PenguinNativeModelRef {
  provider: string;
  modelId: string;
}

export interface PenguinModelInfo extends PenguinNativeModelRef {
  displayName?: string;
  contextWindow?: number;
  isDefault?: boolean;
}

export interface PenguinModelsResponse {
  models: PenguinModelInfo[];
  defaultModel?: PenguinNativeModelRef;
}

export const PENGUIN_THINKING_OPTION_IDS = ["none", "low", "medium", "high", "xhigh", "max"].map(
  (id) => harnessThinkingOptionIdSchema.parse(id),
) as readonly HarnessThinkingOptionId[];

const THINKING_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function assertNativePart(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`Penguin ${label} must not be empty`);
}

export function encodePenguinModelRef(model: PenguinNativeModelRef): HarnessModelRef {
  assertNativePart(model.provider, "Model provider");
  assertNativePart(model.modelId, "Model id");
  const encoded = Buffer.from(JSON.stringify([model.provider, model.modelId]), "utf8").toString(
    "base64url",
  );
  const id = `${MODEL_REF_PREFIX}${encoded}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("Penguin Model identity is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodePenguinModelRef(ref: HarnessModelRef): PenguinNativeModelRef {
  const parsedRef = harnessModelRefSchema.parse(ref);
  if (!parsedRef.id.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("Model Ref does not belong to PenguinAdapter");
  }
  const encoded = parsedRef.id.slice(MODEL_REF_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Penguin Model Ref is malformed");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new Error("Penguin Model Ref has an invalid native identity");
  }
  const native = { provider: decoded[0], modelId: decoded[1] };
  if (encodePenguinModelRef(native).id !== parsedRef.id) {
    throw new Error("Penguin Model Ref is not canonical");
  }
  return native;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nativeModel(value: unknown): PenguinNativeModelRef | null {
  if (!isRecord(value)) return null;
  const provider = value.provider ?? value.providerId;
  const modelId = value.modelId ?? value.id ?? value.model;
  return nonBlankString(provider) && nonBlankString(modelId) ? { provider, modelId } : null;
}

function modelInfo(value: unknown): PenguinModelInfo | null {
  const native = nativeModel(value);
  if (!native || !isRecord(value)) return null;
  const displayName = nonBlankString(value.displayName)
    ? value.displayName
    : nonBlankString(value.name)
      ? value.name
      : undefined;
  const contextWindow =
    typeof value.contextWindow === "number" &&
    Number.isSafeInteger(value.contextWindow) &&
    value.contextWindow > 0
      ? value.contextWindow
      : undefined;
  return {
    ...native,
    ...(displayName ? { displayName } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(value.isDefault === true ? { isDefault: true } : {}),
  };
}

function modelArray(value: unknown): PenguinModelInfo[] {
  if (Array.isArray(value))
    return value.map(modelInfo).filter((model): model is PenguinModelInfo => model !== null);
  if (!isRecord(value)) return [];
  const candidates = value.models;
  return Array.isArray(candidates)
    ? candidates.map(modelInfo).filter((model): model is PenguinModelInfo => model !== null)
    : [];
}

function shortLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 256 ? trimmed : trimmed.slice(0, 253) + "...";
}

export function normalizePenguinModelsResponse(value: unknown): PenguinModelsResponse {
  const models = modelArray(value);
  const rawDefault = isRecord(value) ? nativeModel(value.defaultModel) : null;
  const defaultEntry = rawDefault
    ? rawDefault
    : (models.find((model) => model.isDefault === true) ?? models[0]);
  return {
    models,
    ...(defaultEntry
      ? { defaultModel: { provider: defaultEntry.provider, modelId: defaultEntry.modelId } }
      : {}),
  };
}

export function normalizePenguinModelCatalog(value: unknown): HarnessModelCatalog {
  const response = normalizePenguinModelsResponse(value);
  const seen = new Set<string>();
  const models = response.models
    .map((model) => {
      const ref = encodePenguinModelRef(model);
      if (seen.has(ref.id)) return null;
      seen.add(ref.id);
      return {
        ref,
        label: shortLabel(model.displayName ?? `${model.provider} / ${model.modelId}`),
        resolvedModelLabel: shortLabel(`${model.provider}/${model.modelId}`),
        supportedThinkingOptionIds: [...PENGUIN_THINKING_OPTION_IDS],
      };
    })
    .filter((model): model is NonNullable<typeof model> => model !== null)
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.ref.id.localeCompare(right.ref.id),
    );
  const defaultModel = response.defaultModel
    ? encodePenguinModelRef(response.defaultModel)
    : undefined;
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel && models.some((model) => model.ref.id === defaultModel.id)
      ? { defaultModel }
      : {}),
    thinkingOptions: PENGUIN_THINKING_OPTION_IDS.map((id) =>
      harnessThinkingOptionSchema.parse({ id, label: THINKING_LABELS[id] ?? id }),
    ),
    defaultThinkingOptionId: harnessThinkingOptionIdSchema.parse("medium"),
  });
}
