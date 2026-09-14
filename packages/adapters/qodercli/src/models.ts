import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessSessionCapabilities,
  type HarnessThinkingOption,
} from "@codexhost/shared-contracts";

import {
  QODER_DEFAULT_THINKING_OPTION_ID,
  QODER_THINKING_OPTIONS,
  thinkingOptionsForEfforts,
} from "./thinking.js";

const MODEL_REF_PREFIX = "qoder.";

export const QODER_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
  subagents: { observe: true, readTranscript: true },
};

export const qoderModelRef = (nativeId: string): HarnessModelRef =>
  harnessModelRefSchema.parse({
    id: `${MODEL_REF_PREFIX}${Buffer.from(nativeId, "utf8").toString("base64url")}`,
  });

export function decodeQoderModelRef(ref: HarnessModelRef | string): string {
  const id = typeof ref === "string" ? ref : ref.id;
  if (!id.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("Model is not in this Qoder session's native catalog");
  }
  return Buffer.from(id.slice(MODEL_REF_PREFIX.length), "base64url").toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQoderSdkModels(models: unknown): HarnessModelCatalog {
  if (!Array.isArray(models)) throw new Error("Qoder returned no native model catalog");
  const parsed: Array<{
    value: string;
    displayName?: string;
    isDefault?: boolean;
    efforts: string[];
    supportsDisabled: boolean;
    defaultEffort?: string;
  }> = [];
  for (const entry of models) {
    if (!isRecord(entry) || typeof entry.value !== "string" || entry.value.trim().length === 0) {
      continue;
    }
    if (entry.isEnabled === false) continue;
    const efforts = Array.isArray(entry.efforts)
      ? entry.efforts.filter((value): value is string => typeof value === "string")
      : entry.isReasoning === true
        ? ["low", "medium", "high", "max"]
        : [];
    parsed.push({
      value: entry.value,
      ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}),
      ...(entry.isDefault === true ? { isDefault: true } : {}),
      efforts,
      supportsDisabled: entry.supportsDisabled === true || efforts.length === 0,
      ...(typeof entry.defaultEffort === "string" ? { defaultEffort: entry.defaultEffort } : {}),
    });
  }
  if (parsed.length === 0) throw new Error("Qoder returned no native model catalog");
  const thinkingById = new Map<string, HarnessThinkingOption>();
  for (const model of parsed) {
    for (const option of thinkingOptionsForEfforts(model.efforts, model.supportsDisabled)) {
      thinkingById.set(option.id, option);
    }
  }
  const thinkingOptions =
    thinkingById.size > 0
      ? [...QODER_THINKING_OPTIONS.filter((option) => thinkingById.has(option.id))]
      : [];
  const catalogModels = parsed.map((model) => {
    const supported = thinkingOptionsForEfforts(model.efforts, model.supportsDisabled).map(
      (option) => option.id,
    );
    return {
      ref: qoderModelRef(model.value),
      label: model.displayName?.trim() || model.value,
      ...(supported.length > 0 ? { supportedThinkingOptionIds: supported } : {}),
    };
  });
  const defaultNative =
    parsed.find((model) => model.isDefault)?.value ??
    parsed.find((model) => /^auto$/iu.test(model.displayName ?? model.value))?.value ??
    parsed[0]?.value;
  const defaultThinking =
    thinkingOptions.find((option) => option.id === QODER_DEFAULT_THINKING_OPTION_ID)?.id ??
    thinkingOptions[0]?.id;
  return harnessModelCatalogSchema.parse({
    models: catalogModels,
    ...(defaultNative ? { defaultModel: qoderModelRef(defaultNative) } : {}),
    thinkingOptions,
    ...(defaultThinking ? { defaultThinkingOptionId: defaultThinking } : {}),
  });
}
