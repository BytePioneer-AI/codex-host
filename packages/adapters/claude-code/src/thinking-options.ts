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

/**
 * Thinking budget used when Thinking is re-armed mid-session. Adaptive Models
 * read any non-zero budget as "adaptive" (so they keep deciding depth for
 * themselves, guided by the effort level); older Models get a concrete ceiling.
 * Matches the budget Claude Code's own maximum Thinking keyword uses.
 */
export const CLAUDE_THINKING_BUDGET_TOKENS = 31999;

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
