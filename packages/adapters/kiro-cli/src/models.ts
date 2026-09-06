import type {
  HarnessModel,
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessSessionState,
  HarnessThinkingOption,
} from "@codexhost/harness-adapter";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionSchema,
} from "@codexhost/shared-contracts";

export interface KiroModelState {
  catalog: HarnessModelCatalog;
  currentModel: HarnessModelRef;
}

export const KIRO_DEFAULT_MODELS: HarnessModel[] = [];

export const KIRO_DEFAULT_MODEL_CATALOG: HarnessModelCatalog = {
  models: KIRO_DEFAULT_MODELS,
  thinkingOptions: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function thinkingOptions(values: unknown): HarnessThinkingOption[] {
  const options = new Map<string, HarnessThinkingOption>();
  for (const value of Array.isArray(values) ? values : []) {
    const option = typeof value === "string" ? { value, name: value } : value;
    if (!isRecord(option)) continue;
    const parsed = harnessThinkingOptionSchema.safeParse({
      id: option.value,
      label: option.name ?? option.label ?? option.value,
    });
    if (parsed.success) options.set(parsed.data.id, parsed.data);
  }
  return [...options.values()];
}

export function kiroThinkingState(
  configOptions: unknown,
): Pick<HarnessSessionState, "effectiveThinkingOptionId" | "availableThinkingOptions"> {
  const option = Array.isArray(configOptions)
    ? configOptions.find((entry) => isRecord(entry) && entry.id === "effortLevel")
    : undefined;
  const availableThinkingOptions =
    kiroConfigValue(configOptions, "model") === "auto" || !isRecord(option)
      ? []
      : thinkingOptions(option.options);
  const current = availableThinkingOptions.find(
    ({ id }) => id === kiroConfigValue(configOptions, "effortLevel"),
  );
  return {
    availableThinkingOptions,
    ...(current ? { effectiveThinkingOptionId: current.id } : {}),
  };
}

export function parseKiroModelCatalog(
  configOptions?: unknown,
  fallback: HarnessModelCatalog = KIRO_DEFAULT_MODEL_CATALOG,
): HarnessModelCatalog {
  if (!Array.isArray(configOptions)) return fallback;

  const modelConfig = configOptions.find((opt) => isRecord(opt) && opt.id === "model");
  if (!modelConfig || !isRecord(modelConfig)) return fallback;

  const rawOptions = modelConfig.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return fallback;

  const models: HarnessModel[] = [];
  const seenRefs = new Set<string>();
  const efforts = new Map<string, HarnessThinkingOption>();
  const currentThinking = kiroThinkingState(configOptions);
  let defaultEffort: unknown = currentThinking.effectiveThinkingOptionId;

  for (const option of rawOptions) {
    if (!isRecord(option)) continue;
    const value = option.value ?? option.id;
    const name = option.name ?? option.label ?? value;
    if (!nonBlank(value) || !nonBlank(name)) continue;

    const ref = harnessModelRefSchema.safeParse({ id: value });
    if (!ref.success || seenRefs.has(ref.data.id)) continue;
    seenRefs.add(ref.data.id);

    const meta =
      isRecord(option._meta) && isRecord(option._meta.kiro) ? option._meta.kiro : undefined;
    const currentEffortConfig = configOptions.some(
      (entry) => isRecord(entry) && entry.id === "effortLevel",
    );
    const supported =
      ref.data.id === "auto"
        ? []
        : ref.data.id === modelConfig.currentValue && currentEffortConfig
          ? (currentThinking.availableThinkingOptions ?? [])
          : meta?.hasEffort === false
            ? []
            : thinkingOptions(meta?.effortLevels);
    for (const effort of supported) efforts.set(effort.id, effort);
    if (
      ref.data.id === modelConfig.currentValue &&
      defaultEffort === undefined &&
      supported.some(({ id }) => id === meta?.defaultEffortLevel)
    ) {
      defaultEffort = meta?.defaultEffortLevel;
    }
    models.push({
      ref: ref.data,
      label: name,
      supportedThinkingOptionIds: supported.map(({ id }) => id),
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

  const catalogCandidate = {
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions: [...efforts.values()],
    ...(typeof defaultEffort === "string" && efforts.has(defaultEffort)
      ? { defaultThinkingOptionId: defaultEffort }
      : {}),
  };

  const parsed = harnessModelCatalogSchema.safeParse(catalogCandidate);
  return parsed.success ? parsed.data : fallback;
}

export function kiroConfigValue(configOptions: unknown, id: string): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find((value) => isRecord(value) && value.id === id);
  return isRecord(option) && nonBlank(option.currentValue) ? option.currentValue : undefined;
}

export function confirmedKiroConfig(result: unknown, id: string, value: string): unknown[] {
  const options = isRecord(result) ? result.configOptions : undefined;
  if (!Array.isArray(options) || kiroConfigValue(options, id) !== value) {
    throw new Error(`Kiro did not confirm ${id}=${value}`);
  }
  return options;
}

export function parseKiroCliModels(result: unknown): HarnessModelCatalog {
  const rows = isRecord(result) ? result.models : result;
  if (!Array.isArray(rows)) throw new Error("Kiro returned an invalid model catalog");
  const catalog = parseKiroModelCatalog([
    {
      id: "model",
      options: rows.map((row) =>
        isRecord(row)
          ? { value: row.model_id, name: row.model_name, _meta: row._meta ?? { kiro: row } }
          : row,
      ),
      ...(isRecord(result) ? { currentValue: result.default_model } : {}),
    },
  ]);
  if (catalog.models.length === 0) throw new Error("Kiro returned no valid models");
  return catalog;
}
