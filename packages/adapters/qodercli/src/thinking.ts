import {
  harnessThinkingOptionIdSchema,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

const option = (id: string, label: string): HarnessThinkingOption => ({
  id: harnessThinkingOptionIdSchema.parse(id),
  label,
});

export const QODER_THINKING_OPTIONS = [
  option("off", "Off"),
  option("low", "Low"),
  option("medium", "Medium"),
  option("high", "High"),
  option("max", "Max"),
] as const;

export const QODER_THINKING_OPTION_IDS = QODER_THINKING_OPTIONS.map(({ id }) => id);
export const QODER_DEFAULT_THINKING_OPTION_ID = harnessThinkingOptionIdSchema.parse("off");

export type QoderEffortLevel = "low" | "medium" | "high" | "max";

export interface QoderThinkingConfiguration {
  enabled: boolean;
  effort?: QoderEffortLevel;
}

const EFFORTS = new Set<string>(["low", "medium", "high", "max"]);

export function isQoderEffortLevel(value: string): value is QoderEffortLevel {
  return EFFORTS.has(value);
}

export function parseQoderThinkingOptionId(value: unknown): HarnessThinkingOptionId {
  const id = harnessThinkingOptionIdSchema.parse(value);
  if (!QODER_THINKING_OPTION_IDS.includes(id)) {
    throw new Error("Qoder Thinking option is invalid");
  }
  return id;
}

export function qoderThinkingConfiguration(
  optionId: HarnessThinkingOptionId,
): QoderThinkingConfiguration {
  const id = parseQoderThinkingOptionId(optionId);
  if (id === "off") return { enabled: false };
  return { enabled: true, effort: id as QoderEffortLevel };
}

export function thinkingOptionsForEfforts(
  efforts: readonly string[],
  supportsDisabled: boolean,
): HarnessThinkingOption[] {
  const selected = QODER_THINKING_OPTIONS.filter((entry) => {
    if (entry.id === "off") return supportsDisabled;
    return efforts.some((effort) => effort === entry.id);
  });
  return selected;
}
