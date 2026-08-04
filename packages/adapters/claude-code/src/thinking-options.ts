import {
  harnessThinkingOptionIdSchema,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

const option = (id: string, label: string): HarnessThinkingOption => ({
  id: harnessThinkingOptionIdSchema.parse(id),
  label,
});

export const CLAUDE_THINKING_OPTIONS = [
  option("off", "Off"),
  option("auto", "Auto"),
  option("low", "Low"),
  option("medium", "Medium"),
  option("high", "High"),
  option("xhigh", "Extra High"),
  option("max", "Max"),
] as const;

export const CLAUDE_THINKING_OPTION_IDS = CLAUDE_THINKING_OPTIONS.map(({ id }) => id);
export const CLAUDE_DEFAULT_THINKING_OPTION_ID = harnessThinkingOptionIdSchema.parse("auto");

export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeThinkingConfiguration {
  enabled: boolean;
  effort?: ClaudeEffortLevel;
}

export function parseClaudeThinkingOptionId(value: unknown): HarnessThinkingOptionId {
  const id = harnessThinkingOptionIdSchema.parse(value);
  if (!CLAUDE_THINKING_OPTION_IDS.includes(id)) {
    throw new Error("Claude Code Thinking option is invalid");
  }
  return id;
}

export function claudeThinkingConfiguration(
  optionId: HarnessThinkingOptionId,
): ClaudeThinkingConfiguration {
  const id = parseClaudeThinkingOptionId(optionId);
  if (id === "off") return { enabled: false };
  if (id === "auto") return { enabled: true };
  return { enabled: true, effort: id as ClaudeEffortLevel };
}
