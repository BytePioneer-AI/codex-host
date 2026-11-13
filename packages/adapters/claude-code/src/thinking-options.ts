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

/** Thinking fields of one native `ModelInfo` row; Claude Code includes a flag only when true. */
export interface ClaudeModelThinkingCapabilities {
  supportsEffort?: boolean | undefined;
  supportedEffortLevels?: readonly string[] | undefined;
  supportsAdaptiveThinking?: boolean | undefined;
  /** Reported by Claude Code but absent from the SDK `ModelInfo` type. */
  supportsThinkingOff?: boolean | undefined;
}

/**
 * The Thinking options one native Model accepts. Rows without any capability field come from a
 * Claude Code that does not report them, so every option stays available.
 *
 * Auto only turns Thinking on: Claude Code sends adaptive Thinking to Models that support it
 * and a token budget to the rest, so it is offered whatever `supportsAdaptiveThinking` says.
 */
export function claudeSupportedThinkingOptionIds(
  model: ClaudeModelThinkingCapabilities,
): HarnessThinkingOptionId[] {
  if (
    model.supportsEffort === undefined &&
    model.supportedEffortLevels === undefined &&
    model.supportsAdaptiveThinking === undefined &&
    model.supportsThinkingOff === undefined
  ) {
    return [...CLAUDE_THINKING_OPTION_IDS];
  }
  const efforts = new Set<string>(
    model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []),
  );
  return CLAUDE_THINKING_OPTION_IDS.filter((id) => {
    if (id === "off") return model.supportsThinkingOff !== false;
    if (id === "auto") return true;
    if (id === "ultracode") return efforts.has("xhigh");
    return efforts.has(id);
  });
}

const CLAUDE_EFFORT_ORDER: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The option a Session runs for `requested` on a Model that supports `supported` (undefined when
 * unknown). An unsupported effort clamps down to the highest supported level not above it
 * (Ultracode counts as Extra High); Auto, which every Model offers, covers the rest.
 */
export function fitClaudeThinkingOptionId(
  requested: HarnessThinkingOptionId,
  supported: readonly HarnessThinkingOptionId[] | undefined,
): HarnessThinkingOptionId {
  if (!supported || supported.includes(requested)) return requested;
  const ceiling = CLAUDE_EFFORT_ORDER.indexOf(requested === "ultracode" ? "xhigh" : requested);
  return (
    supported.findLast((id) => {
      const rank = CLAUDE_EFFORT_ORDER.indexOf(id);
      return rank >= 0 && rank <= ceiling;
    }) ?? CLAUDE_DEFAULT_THINKING_OPTION_ID
  );
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
