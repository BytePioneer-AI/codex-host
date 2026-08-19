import { describe, expect, it } from "vitest";

import {
  grokCompactionEventFromUpdate,
  isGrokExtensionSessionUpdateMethod,
} from "../src/grok-compaction.js";

describe("Grok auto-compact mapping", () => {
  it("maps snake_case auto-compact start and success", () => {
    expect(
      grokCompactionEventFromUpdate({
        sessionUpdate: "auto_compact_started",
        tokens_used: 401965,
        context_window: 500000,
        percentage: 80,
        reason: "Context window 80% full",
      }),
    ).toEqual({
      type: "compaction.started",
      tokensUsed: 401965,
      contextWindowTokens: 500000,
    });
    expect(
      grokCompactionEventFromUpdate({
        sessionUpdate: "auto_compact_completed",
        tokens_before: 401965,
        tokens_after: 10820,
        elapsed_ms: 51274,
        summary_preview: null,
      }),
    ).toEqual({
      type: "compaction.completed",
      outcome: "succeeded",
      tokensBefore: 401965,
      tokensAfter: 10820,
    });
  });

  it("maps camelCase fields and terminal failure or cancel", () => {
    expect(
      grokCompactionEventFromUpdate({
        sessionUpdate: "auto_compact_started",
        tokensUsed: 10,
        contextWindowTokens: 100,
      }),
    ).toEqual({
      type: "compaction.started",
      tokensUsed: 10,
      contextWindowTokens: 100,
    });
    expect(
      grokCompactionEventFromUpdate({
        sessionUpdate: "auto_compact_failed",
        error_message: "quota exceeded",
      }),
    ).toEqual({
      type: "compaction.completed",
      outcome: "failed",
      errorMessage: "quota exceeded",
    });
    expect(grokCompactionEventFromUpdate({ sessionUpdate: "auto_compact_cancelled" })).toEqual({
      type: "compaction.completed",
      outcome: "cancelled",
    });
  });

  it("ignores checkpoints and unknown updates", () => {
    expect(
      grokCompactionEventFromUpdate({
        sessionUpdate: "compaction_checkpoint",
        checkpoint_id: "ckpt-1",
      }),
    ).toBeNull();
    expect(grokCompactionEventFromUpdate({ sessionUpdate: "agent_thought_chunk" })).toBeNull();
    expect(grokCompactionEventFromUpdate({})).toBeNull();
  });

  it("recognizes observed and documented extension methods", () => {
    expect(isGrokExtensionSessionUpdateMethod("_x.ai/session/update")).toBe(true);
    expect(isGrokExtensionSessionUpdateMethod("x.ai/session_notification")).toBe(true);
    expect(isGrokExtensionSessionUpdateMethod("session/update")).toBe(false);
    expect(isGrokExtensionSessionUpdateMethod("x.ai/compact_conversation")).toBe(false);
  });
});
