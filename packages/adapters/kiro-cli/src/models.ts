import type {
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelRef,
} from "@codexhost/harness-adapter";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
} from "@codexhost/shared-contracts";

export interface KiroModelState {
  catalog: HarnessModelCatalog;
  currentModel: HarnessModelRef;
}

export const KIRO_DEFAULT_MODELS: HarnessModel[] = [
  {
    ref: { id: "auto" as HarnessModelRef["id"] },
    label: "Auto",
  },
  {
    ref: { id: "claude-haiku-4.5" as HarnessModelRef["id"] },
    label: "Claude 3.5 Haiku",
  },
  {
    ref: { id: "claude-sonnet-4.5" as HarnessModelRef["id"] },
    label: "Claude 3.5 Sonnet",
  },
  {
    ref: { id: "claude-opus-4.5" as HarnessModelRef["id"] },
    label: "Claude 3.5 Opus",
  },
];

export const KIRO_DEFAULT_MODEL_CATALOG: HarnessModelCatalog = {
  models: KIRO_DEFAULT_MODELS,
  defaultModel: { id: "claude-haiku-4.5" as HarnessModelRef["id"] },
  thinkingOptions: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseKiroModelCatalog(
  configOptions?: unknown,
  fallback: HarnessModelCatalog = KIRO_DEFAULT_MODEL_CATALOG,
): HarnessModelCatalog {
  if (!Array.isArray(configOptions)) return fallback;

  const modelConfig = configOptions.find(
    (opt) => isRecord(opt) && opt.id === "model",
  );
  if (!modelConfig || !isRecord(modelConfig)) return fallback;

  const rawOptions = modelConfig.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return fallback;

  const models: HarnessModel[] = [];
  const seenRefs = new Set<string>();

  for (const option of rawOptions) {
    if (!isRecord(option)) continue;
    const value = option.value ?? option.id;
    const name = option.name ?? option.label ?? value;
    if (!nonBlank(value) || !nonBlank(name)) continue;

    const ref = harnessModelRefSchema.safeParse({ id: value });
    if (!ref.success || seenRefs.has(ref.data.id)) continue;
    seenRefs.add(ref.data.id);

    models.push({
      ref: ref.data,
      label: name,
    });
  }

  if (models.length === 0) return fallback;

  let defaultModel: HarnessModelRef | undefined;
  if (nonBlank(modelConfig.currentValue)) {
    const parsedDefault = harnessModelRefSchema.safeParse({
      id: modelConfig.currentValue,
    });
    if (parsedDefault.success && seenRefs.has(parsedDefault.data.id)) {
      defaultModel = parsedDefault.data;
    }
  }

  if (!defaultModel && models.length > 0) {
    defaultModel = models[0]?.ref;
  }

  const catalogCandidate = {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions: [],
  };

  const parsed = harnessModelCatalogSchema.safeParse(catalogCandidate);
  return parsed.success ? parsed.data : fallback;
}
