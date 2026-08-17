import { describe, expect, it } from "vitest";

import {
  GROK_REWIND_EXECUTE_METHOD,
  GROK_REWIND_POINTS_METHOD,
  buildGrokRewindParams,
  parseGrokRewindResponse,
} from "../src/grok-rewind.js";

describe("Grok Rewind ACP envelope", () => {
  it("uses the underscore-prefixed wire method and conversation-only force params", () => {
    expect(GROK_REWIND_EXECUTE_METHOD).toBe("_x.ai/rewind/execute");
    expect(GROK_REWIND_POINTS_METHOD).toBe("_x.ai/rewind/points");
    expect(
      buildGrokRewindParams({
        sessionId: "session",
        targetPromptIndex: 0,
      }),
    ).toEqual({
      sessionId: "session",
      targetPromptIndex: 0,
      force: true,
      mode: "conversation_only",
    });
  });

  it("parses a successful top-level response and a result-wrapped response", () => {
    expect(
      parseGrokRewindResponse({
        success: true,
        target_prompt_index: 1,
        mode: "conversation_only",
        prompt_text: "previous",
      }),
    ).toEqual({
      success: true,
      targetPromptIndex: 1,
      mode: "conversation_only",
      promptText: "previous",
    });
    expect(parseGrokRewindResponse({ result: { success: true, targetPromptIndex: 0 } })).toEqual({
      success: true,
      targetPromptIndex: 0,
    });
  });

  it("parses an unsuccessful Rewind without treating it as a missing payload", () => {
    expect(
      parseGrokRewindResponse({
        success: false,
        target_prompt_index: 1,
        mode: "all",
        error: null,
      }),
    ).toEqual({
      success: false,
      targetPromptIndex: 1,
      mode: "all",
      error: null,
    });
  });

  it("rejects a missing success flag or Prompt Index", () => {
    expect(parseGrokRewindResponse({})).toBeNull();
    expect(parseGrokRewindResponse({ result: {} })).toBeNull();
    expect(parseGrokRewindResponse({ success: true })).toBeNull();
    expect(parseGrokRewindResponse({ success: true, targetPromptIndex: -1 })).toBeNull();
  });
});
