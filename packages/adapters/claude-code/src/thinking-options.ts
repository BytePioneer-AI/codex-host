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
  // Session-scoped Workflow orchestration on top of Extra High effort.
  option("ultracode", "Ultracode"),
] as const;

export const CLAUDE_THINKING_OPTION_IDS = CLAUDE_THINKING_OPTIONS.map(({ id }) => id);
export const CLAUDE_DEFAULT_THINKING_OPTION_ID = harnessThinkingOptionIdSchema.parse("auto");

export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeThinkingConfiguration {
  enabled: boolean;
  effort?: ClaudeEffortLevel;
  /** Claude Code's session-scoped `ultracode` flag setting. */
  ultracode: boolean;
}

/** The native flag settings `applyFlagSettings` merges for one Thinking selection. */
export type ClaudeThinkingFlagSettings = {
  alwaysThinkingEnabled: boolean;
  effortLevel?: ClaudeEffortLevel | null;
  ultracode?: boolean;
};

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
  if (id === "off") return { enabled: false, ultracode: false };
  if (id === "auto") return { enabled: true, ultracode: false };
  if (id === "ultracode") return { enabled: true, effort: "xhigh", ultracode: true };
  return { enabled: true, effort: id as ClaudeEffortLevel, ultracode: false };
}

/**
 * Builds the flag settings that move a live Session from `previous` to `next`.
 *
 * The `ultracode` key is sent only when entering or leaving Ultracode. Claude Code keeps a
 * requested Ultracode flag when Thinking is turned off or the effort stays at Extra High, so
 * leaving must clear it explicitly; other selections never mention the key, which keeps them
 * unchanged on Claude Code versions that predate Ultracode.
 */
export function claudeThinkingFlagSettings(
  next: ClaudeThinkingConfiguration,
  previous: ClaudeThinkingConfiguration | null,
): ClaudeThinkingFlagSettings {
  if (next.ultracode) {
    return { alwaysThinkingEnabled: true, effortLevel: "xhigh", ultracode: true };
  }
  const leaving = previous?.ultracode === true ? { ultracode: false } : {};
  return next.enabled
    ? { alwaysThinkingEnabled: true, effortLevel: next.effort ?? null, ...leaving }
    : { alwaysThinkingEnabled: false, ...leaving };
}
