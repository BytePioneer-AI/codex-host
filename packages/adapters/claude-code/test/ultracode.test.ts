import { describe, expect, it } from "vitest";
import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

import {
  CLAUDE_THINKING_OPTION_IDS,
  claudeThinkingConfiguration,
  claudeThinkingFlagSettings,
} from "../src/thinking-options.js";
import {
  ClaudeUltracodeUnavailableError,
  claudeUltracodeFailure,
  claudeUltracodeUnavailableReason,
} from "../src/ultracode.js";

const configuration = (id: string) =>
  claudeThinkingConfiguration(harnessThinkingOptionIdSchema.parse(id));

describe("Claude Ultracode Thinking option", () => {
  it("is the last Thinking option and runs at Extra High effort", () => {
    expect(CLAUDE_THINKING_OPTION_IDS.at(-1)).toBe("ultracode");
    expect(configuration("ultracode")).toEqual({
      enabled: true,
      effort: "xhigh",
      ultracode: true,
    });
    expect(configuration("xhigh")).toEqual({ enabled: true, effort: "xhigh", ultracode: false });
    expect(configuration("off")).toEqual({ enabled: false, ultracode: false });
  });

  it("sends the Ultracode key only when entering or leaving Ultracode", () => {
    const ultracode = configuration("ultracode");
    expect(claudeThinkingFlagSettings(ultracode, null)).toEqual({
      alwaysThinkingEnabled: true,
      effortLevel: "xhigh",
      ultracode: true,
    });
    expect(claudeThinkingFlagSettings(ultracode, configuration("off"))).toEqual({
      alwaysThinkingEnabled: true,
      effortLevel: "xhigh",
      ultracode: true,
    });
    // Leaving must clear the flag: Claude Code keeps it when Thinking turns off or the
    // effort stays at Extra High.
    expect(claudeThinkingFlagSettings(configuration("xhigh"), ultracode)).toEqual({
      alwaysThinkingEnabled: true,
      effortLevel: "xhigh",
      ultracode: false,
    });
    expect(claudeThinkingFlagSettings(configuration("off"), ultracode)).toEqual({
      alwaysThinkingEnabled: false,
      ultracode: false,
    });
    expect(claudeThinkingFlagSettings(configuration("auto"), ultracode)).toEqual({
      alwaysThinkingEnabled: true,
      effortLevel: null,
      ultracode: false,
    });
    expect(claudeThinkingFlagSettings(configuration("medium"), configuration("high"))).toEqual({
      alwaysThinkingEnabled: true,
      effortLevel: "medium",
    });
    expect(claudeThinkingFlagSettings(configuration("off"), null)).toEqual({
      alwaysThinkingEnabled: false,
    });
  });
});

describe("Claude Ultracode readback", () => {
  it("accepts only an applied Ultracode state", () => {
    expect(
      claudeUltracodeUnavailableReason({
        applied: { ultracode: true, ultracodeRequested: true, ultracodeAvailable: true },
      }),
    ).toBeNull();
  });

  it("fails closed with the reason the native settings support", () => {
    expect(claudeUltracodeUnavailableReason(undefined)).toBe("unverifiable");
    expect(claudeUltracodeUnavailableReason({ effective: {} })).toBe("unverifiable");
    // Claude Code before 2.1.154 reports no Ultracode state.
    expect(claudeUltracodeUnavailableReason({ applied: { effort: "xhigh" } })).toBe(
      "unsupportedVersion",
    );
    // Some releases report only whether Ultracode is on.
    expect(claudeUltracodeUnavailableReason({ applied: { ultracode: false } })).toBe("notApplied");
    const unavailable = {
      applied: { ultracode: false, ultracodeRequested: true, ultracodeAvailable: false },
    };
    expect(claudeUltracodeUnavailableReason({ ...unavailable, effective: {} })).toBe("unavailable");
    expect(
      claudeUltracodeUnavailableReason({ ...unavailable, effective: { enableWorkflows: false } }),
    ).toBe("workflowsDisabled");
    expect(
      claudeUltracodeUnavailableReason(
        { ...unavailable, effective: { enableWorkflows: true } },
        { CLAUDE_CODE_DISABLE_WORKFLOWS: "1" },
      ),
    ).toBe("workflowsDisabled");
    expect(
      claudeUltracodeUnavailableReason(
        { ...unavailable, effective: { enableWorkflows: true } },
        { CLAUDE_CODE_DISABLE_WORKFLOWS: "0" },
      ),
    ).toBe("modelUnsupported");
    expect(
      claudeUltracodeUnavailableReason(
        { ...unavailable, effective: {} },
        { CLAUDE_CODE_WORKFLOWS: "1" },
      ),
    ).toBe("modelUnsupported");
    expect(
      claudeUltracodeUnavailableReason(
        { ...unavailable, effective: { enableWorkflows: true } },
        { CLAUDE_CODE_WORKFLOWS: "false" },
      ),
    ).toBe("workflowsDisabled");
  });

  it("maps each reason to an actionable Harness error", () => {
    expect(
      claudeUltracodeFailure(new ClaudeUltracodeUnavailableError("unsupportedVersion")),
    ).toEqual({
      code: "unsupported",
      message:
        "This Claude Code version does not support Ultracode; update Claude Code to 2.1.154 or later",
      retryable: false,
    });
    expect(
      claudeUltracodeFailure(new ClaudeUltracodeUnavailableError("workflowsDisabled")),
    ).toMatchObject({ code: "configurationRequired", retryable: true });
    expect(
      claudeUltracodeFailure(new ClaudeUltracodeUnavailableError("unavailable")),
    ).toMatchObject({ code: "configurationRequired", message: expect.stringContaining("/config") });
    expect(
      claudeUltracodeFailure(new ClaudeUltracodeUnavailableError("modelUnsupported")),
    ).toMatchObject({ code: "unsupported", retryable: false });
    expect(
      claudeUltracodeFailure(new ClaudeUltracodeUnavailableError("unverifiable")),
    ).toMatchObject({ code: "nativeFailure", retryable: true });
  });
});
