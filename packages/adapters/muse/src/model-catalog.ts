import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

export const MUSE_THINKING_OPTIONS = [
  { id: "none", native: "none", label: "None" },
  { id: "minimal", native: "minimal", label: "Minimal" },
  { id: "low", native: "low", label: "Low" },
  { id: "medium", native: "medium", label: "Medium" },
  { id: "high", native: "high", label: "High" },
  { id: "xhigh", native: "xhigh", label: "Extra high" },
  { id: "ultra", native: "ultra", label: "Ultra" },
] as const;

export const MUSE_DEFAULT_THINKING_OPTION_ID = harnessThinkingOptionIdSchema.parse("high");

export type MuseReasoningEffort = (typeof MUSE_THINKING_OPTIONS)[number]["native"];

export interface MuseModelRow {
  readonly modelId: string;
  readonly displayLabel: string;
  readonly providerId?: string;
  readonly isDefault?: boolean;
}

export function museThinkingOptionId(value: string): HarnessThinkingOptionId {
  return harnessThinkingOptionIdSchema.parse(value);
}

export function decodeMuseThinkingOptionId(value: HarnessThinkingOptionId): MuseReasoningEffort {
  const option = MUSE_THINKING_OPTIONS.find((entry) => entry.id === value);
  if (!option) throw new Error("Muse Thinking option belongs to another Adapter");
  return option.native;
}

export function parseMuseModelCatalog(rows: readonly MuseModelRow[]): HarnessModelCatalog {
  const thinkingOptions = MUSE_THINKING_OPTIONS.map((option) => ({
    id: harnessThinkingOptionIdSchema.parse(option.id),
    label: option.label,
  }));
  const thinkingIds = thinkingOptions.map((option) => option.id);
  const models = rows.flatMap((row) => {
    const ref = harnessModelRefSchema.safeParse({ id: row.modelId });
    if (!ref.success) return [];
    return [
      {
        ref: ref.data,
        label: row.displayLabel || row.modelId,
        supportedThinkingOptionIds: thinkingIds,
      },
    ];
  });
  const defaultRow = rows.find((row) => row.isDefault) ?? rows[0];
  const defaultModel = defaultRow
    ? harnessModelRefSchema.safeParse({ id: defaultRow.modelId }).data
    : undefined;
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions,
    defaultThinkingOptionId: MUSE_DEFAULT_THINKING_OPTION_ID,
  });
}

export function museModelRef(modelId: string): HarnessModelRef {
  return harnessModelRefSchema.parse({ id: modelId });
}
