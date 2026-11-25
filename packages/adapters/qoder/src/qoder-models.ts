import { normalizeLegacyBase64ModelRef } from "@codexhost/harness-adapter";
import {
  HARNESS_MODEL_LABEL_MAX_LENGTH,
  catalogModelForRef,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModel,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

export const QODER_STANDARD_MODELS = [
  { value: "auto", label: "Auto (Recommended)" },
  { value: "ultimate", label: "Ultimate" },
  { value: "performance", label: "Performance" },
  { value: "efficient", label: "Efficient" },
  { value: "lite", label: "Lite" },
] as const;

export function qoderModelRef(id: string): HarnessModelRef {
  return harnessModelRefSchema.parse({ id });
}

export const QODER_DEFAULT_MODEL_REF = qoderModelRef("auto");

export const QODER_EFFORT_LABELS: ReadonlyMap<string, string> = new Map([
  ["off", "Off"],
  ["none", "Off"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
  ["max", "Max"],
]);

const PREFERRED_EFFORT_ORDER = ["off", "none", "low", "medium", "high", "xhigh", "max"];

function effortLabel(id: string): string {
  const standard = QODER_EFFORT_LABELS.get(id.toLowerCase());
  if (standard) return standard;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function extractModelEfforts(raw: Record<string, unknown>): {
  supportedEffortIds: HarnessThinkingOptionId[];
  defaultEffortId?: HarnessThinkingOptionId;
} {
  const effortIds = new Set<HarnessThinkingOptionId>();
  let defaultEffortId: HarnessThinkingOptionId | undefined;

  if (typeof raw.thinking_config === "object" && raw.thinking_config !== null) {
    const tc = raw.thinking_config as Record<string, unknown>;
    if (tc.disabled) {
      const parsed = harnessThinkingOptionIdSchema.safeParse("off");
      if (parsed.success) effortIds.add(parsed.data);
    }
    if (typeof tc.enabled === "object" && tc.enabled !== null) {
      const enabled = tc.enabled as Record<string, unknown>;
      if (typeof enabled.efforts === "object" && enabled.efforts !== null) {
        for (const [key, entry] of Object.entries(enabled.efforts)) {
          const parsed = harnessThinkingOptionIdSchema.safeParse(key);
          if (parsed.success) {
            effortIds.add(parsed.data);
            if (
              typeof entry === "object" &&
              entry !== null &&
              (entry as Record<string, unknown>).is_default === true
            ) {
              defaultEffortId = parsed.data;
            }
          }
        }
      }
    }
  }

  if (Array.isArray(raw.efforts)) {
    for (const effort of raw.efforts) {
      if (typeof effort === "string" && effort.trim().length > 0) {
        const parsed = harnessThinkingOptionIdSchema.safeParse(effort.trim());
        if (parsed.success) effortIds.add(parsed.data);
      }
    }
  }

  if (raw.supportsDisabled === true) {
    const parsed = harnessThinkingOptionIdSchema.safeParse("off");
    if (parsed.success) effortIds.add(parsed.data);
  }

  if (effortIds.size === 0 && raw.isReasoning === true) {
    for (const std of ["low", "medium", "high", "max"]) {
      const parsed = harnessThinkingOptionIdSchema.safeParse(std);
      if (parsed.success) effortIds.add(parsed.data);
    }
    if (raw.supportsDisabled === true) {
      const parsed = harnessThinkingOptionIdSchema.safeParse("off");
      if (parsed.success) effortIds.add(parsed.data);
    }
  }

  if (
    !defaultEffortId &&
    typeof raw.defaultEffort === "string" &&
    raw.defaultEffort.trim().length > 0
  ) {
    const parsed = harnessThinkingOptionIdSchema.safeParse(raw.defaultEffort.trim());
    if (parsed.success && effortIds.has(parsed.data)) {
      defaultEffortId = parsed.data;
    }
  }

  const sorted = [...effortIds].sort((a, b) => {
    const idxA = PREFERRED_EFFORT_ORDER.indexOf(a);
    const idxB = PREFERRED_EFFORT_ORDER.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  if (!defaultEffortId && sorted.length > 0) {
    if (sorted.includes("medium" as HarnessThinkingOptionId)) {
      defaultEffortId = "medium" as HarnessThinkingOptionId;
    } else {
      defaultEffortId = sorted.find((id) => id !== "off" && id !== "none") ?? sorted[0];
    }
  }

  return {
    supportedEffortIds: sorted,
    ...(defaultEffortId ? { defaultEffortId } : {}),
  };
}

export function qoderModelValue(ref: HarnessModelRef): string | undefined {
  return harnessModelRefSchema.safeParse(ref).data?.id;
}

export function normalizeStoredQoderModelRef(
  ref: HarnessModelRef,
  catalog: HarnessModelCatalog,
): HarnessModelRef | undefined {
  return normalizeLegacyBase64ModelRef(ref, catalog, "qoder-model-v1.");
}

export function parseQoderModelCatalog(rawModels?: unknown[]): HarnessModelCatalog {
  const models: HarnessModel[] = [];
  const seenRefs = new Set<string>();
  const allThinkingOptions = new Map<HarnessThinkingOptionId, HarnessThinkingOption>();
  let nativeDefault: HarnessModelRef | undefined;
  let nativeDefaultEffortId: HarnessThinkingOptionId | undefined;
  let firstModelEffortId: HarnessThinkingOptionId | undefined;

  if (Array.isArray(rawModels)) {
    for (const item of rawModels) {
      if (typeof item === "object" && item !== null) {
        const raw = item as Record<string, unknown>;
        const value =
          typeof raw.value === "string" && raw.value.length > 0
            ? raw.value
            : typeof raw.modelId === "string" && raw.modelId.length > 0
              ? raw.modelId
              : typeof raw.id === "string"
                ? raw.id
                : undefined;
        if (!value) continue;

        const labelCandidate =
          typeof raw.displayName === "string" && raw.displayName.trim().length > 0
            ? raw.displayName.trim()
            : typeof raw.name === "string" && raw.name.trim().length > 0
              ? raw.name.trim()
              : value;
        const label = labelCandidate.slice(0, HARNESS_MODEL_LABEL_MAX_LENGTH);

        const { supportedEffortIds, defaultEffortId } = extractModelEfforts(raw);
        for (const effortId of supportedEffortIds) {
          allThinkingOptions.set(effortId, { id: effortId, label: effortLabel(effortId) });
        }

        const ref = qoderModelRef(value);
        if (!seenRefs.has(ref.id)) {
          seenRefs.add(ref.id);
          models.push({
            ref,
            label,
            ...(supportedEffortIds.length > 0
              ? { supportedThinkingOptionIds: supportedEffortIds }
              : {}),
          });
          if (models.length === 1 && defaultEffortId) {
            firstModelEffortId = defaultEffortId;
          }
          if (!nativeDefault && raw.isDefault === true) {
            nativeDefault = ref;
            if (defaultEffortId) nativeDefaultEffortId = defaultEffortId;
          }
        }
      }
    }
  }

  const defaultModel = nativeDefault ?? models[0]?.ref;
  const sortedThinkingOptions = [...allThinkingOptions.values()].sort((a, b) => {
    const idxA = PREFERRED_EFFORT_ORDER.indexOf(a.id);
    const idxB = PREFERRED_EFFORT_ORDER.indexOf(b.id);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.id.localeCompare(b.id);
  });

  let defaultThinkingOptionId: HarnessThinkingOptionId | undefined =
    nativeDefaultEffortId ?? firstModelEffortId;
  if (!defaultThinkingOptionId && sortedThinkingOptions.length > 0) {
    if (sortedThinkingOptions.some((o) => o.id === "medium")) {
      defaultThinkingOptionId = harnessThinkingOptionIdSchema.parse("medium");
    } else {
      defaultThinkingOptionId =
        sortedThinkingOptions.find((o) => o.id !== "off" && o.id !== "none")?.id ??
        sortedThinkingOptions[0]?.id;
    }
  }

  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions: sortedThinkingOptions,
    ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
  });
}

export function qoderAvailableThinkingOptions(
  catalog: HarnessModelCatalog | undefined,
  model: HarnessModelRef | undefined,
): HarnessThinkingOption[] | undefined {
  if (!catalog) return undefined;
  const supported = catalogModelForRef(catalog, model)?.supportedThinkingOptionIds;
  if (!supported || supported.length === 0) return undefined;
  const options = supported.flatMap((id) => {
    const option = catalog.thinkingOptions.find((candidate) => candidate.id === id);
    return option ? [option] : [];
  });
  return options.length > 0 ? options : undefined;
}
