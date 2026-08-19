import { describe, expect, it } from "vitest";

import {
  GROK_COMPACT_CONVERSATION_FALLBACK_METHOD,
  GROK_COMPACT_CONVERSATION_METHOD,
  parseGrokCompactResult,
} from "../src/grok-manual-compaction.js";

describe("Grok manual compact protocol helpers", () => {
  it("parses native compact success, failure, and cancellation results", () => {
    expect(
      parseGrokCompactResult({
        tokens_before: 401965,
        tokens_after: 10820,
        context_window: 500000,
      }),
    ).toEqual({
      outcome: "succeeded",
      tokensBefore: 401965,
      tokensAfter: 10820,
      contextWindowTokens: 500000,
    });
    expect(parseGrokCompactResult({ success: false, error_message: "quota exceeded" })).toEqual({
      outcome: "failed",
      errorMessage: "quota exceeded",
    });
    expect(parseGrokCompactResult({}, true)).toEqual({ outcome: "cancelled" });
  });

  it("keeps documented and underscored method names explicit", () => {
    expect(GROK_COMPACT_CONVERSATION_METHOD).toBe("x.ai/compact_conversation");
    expect(GROK_COMPACT_CONVERSATION_FALLBACK_METHOD).toBe("_x.ai/compact_conversation");
  });
});
