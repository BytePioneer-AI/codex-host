import type { HarnessError } from "@codexhost/harness-adapter";

/** First Claude Code release whose Session settings report Ultracode. */
export const CLAUDE_ULTRACODE_MINIMUM_VERSION = "2.1.154";

/**
 * Why Claude Code did not put Ultracode into effect, as read back from the native
 * Session settings after the request:
 *
 * - `unsupportedVersion`: the settings have no Ultracode state at all.
 * - `workflowsDisabled`: Ultracode is unavailable and dynamic workflows are explicitly off.
 * - `modelUnsupported`: Ultracode is unavailable although dynamic workflows are explicitly on.
 * - `unavailable`: Ultracode is unavailable and the settings do not say which prerequisite fails.
 * - `notApplied`: Claude Code reports Ultracode off without saying it is unavailable.
 * - `unverifiable`: the settings could not be read.
 */
export type ClaudeUltracodeUnavailableReason =
  | "unsupportedVersion"
  | "workflowsDisabled"
  | "modelUnsupported"
  | "unavailable"
  | "notApplied"
  | "unverifiable";

const FAILURES: Record<ClaudeUltracodeUnavailableReason, HarnessError> = {
  unsupportedVersion: {
    code: "unsupported",
    message: `This Claude Code version does not support Ultracode; update Claude Code to ${CLAUDE_ULTRACODE_MINIMUM_VERSION} or later`,
    retryable: false,
  },
  workflowsDisabled: {
    code: "configurationRequired",
    message:
      "Ultracode needs dynamic workflows, which are turned off; turn on Dynamic workflows in Claude Code /config and retry",
    retryable: true,
  },
  modelUnsupported: {
    code: "unsupported",
    message:
      "Claude Code reports Ultracode is unavailable for the selected Model; choose another Model or Thinking option",
    retryable: false,
  },
  unavailable: {
    code: "configurationRequired",
    message:
      "Claude Code reports Ultracode is unavailable; turn on Dynamic workflows in Claude Code /config and use a Model that supports Ultracode",
    retryable: true,
  },
  notApplied: {
    code: "configurationRequired",
    message:
      "Claude Code did not turn on Ultracode; check that Dynamic workflows are on in Claude Code /config and the Model supports Ultracode",
    retryable: true,
  },
  unverifiable: {
    code: "nativeFailure",
    message: `Claude Code could not confirm that Ultracode is on; Ultracode needs Claude Code ${CLAUDE_ULTRACODE_MINIMUM_VERSION} or later`,
    retryable: true,
  },
};

export class ClaudeUltracodeUnavailableError extends Error {
  readonly reason: ClaudeUltracodeUnavailableReason;

  constructor(reason: ClaudeUltracodeUnavailableReason) {
    super(FAILURES[reason].message);
    this.name = "ClaudeUltracodeUnavailableError";
    this.reason = reason;
  }
}

export function claudeUltracodeFailure(error: ClaudeUltracodeUnavailableError): HarnessError {
  return { ...FAILURES[error.reason] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function environmentFlag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

/** Dynamic workflows as the Session settings and Claude Code's own environment switches set them. */
function workflowsSwitch(settings: Record<string, unknown>, environment: NodeJS.ProcessEnv) {
  const setting = isRecord(settings.effective) ? settings.effective.enableWorkflows : undefined;
  const enabledByEnvironment = environmentFlag(environment.CLAUDE_CODE_WORKFLOWS);
  if (
    setting === false ||
    enabledByEnvironment === false ||
    environmentFlag(environment.CLAUDE_CODE_DISABLE_WORKFLOWS) === true
  ) {
    return "off";
  }
  return setting === true || enabledByEnvironment === true ? "on" : "unknown";
}

/**
 * True when native Session settings report Ultracode on. Settings without Ultracode state
 * come from a Claude Code release that cannot run it.
 */
export function claudeUltracodeActive(settings: unknown): boolean {
  if (!isRecord(settings) || !isRecord(settings.applied)) {
    throw new ClaudeUltracodeUnavailableError("unverifiable");
  }
  return settings.applied.ultracode === true;
}

/**
 * Reads the effective Ultracode state from a native `get_settings` response. Ultracode counts
 * as on only when Claude Code reports `applied.ultracode === true`; anything else fails closed.
 */
export function claudeUltracodeUnavailableReason(
  settings: unknown,
  environment: NodeJS.ProcessEnv = {},
): ClaudeUltracodeUnavailableReason | null {
  if (!isRecord(settings) || !isRecord(settings.applied)) return "unverifiable";
  const applied = settings.applied;
  if (typeof applied.ultracode !== "boolean") return "unsupportedVersion";
  if (applied.ultracode) return null;
  if (applied.ultracodeAvailable !== false) return "notApplied";
  const workflows = workflowsSwitch(settings, environment);
  if (workflows === "off") return "workflowsDisabled";
  return workflows === "on" ? "modelUnsupported" : "unavailable";
}
