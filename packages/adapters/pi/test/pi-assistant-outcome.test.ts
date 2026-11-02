import { describe, expect, it } from "vitest";

import { piAssistantPhase } from "../src/pi-assistant-outcome.js";

describe("Pi Assistant message phase", () => {
  const text = (phase?: string) => ({
    type: "text",
    text: "Visible text",
    ...(phase ? { textSignature: JSON.stringify({ v: 1, id: "native-message", phase }) } : {}),
  });

  it("uses the last nonempty text block's provider phase before the turn stop reason", () => {
    expect(
      piAssistantPhase({
        role: "assistant",
        stopReason: "stop",
        content: [
          text("final_answer"),
          text("commentary"),
          {
            type: "text",
            text: "",
            textSignature: JSON.stringify({ v: 1, id: "empty", phase: "final_answer" }),
          },
        ],
      }),
    ).toBe("commentary");
    expect(
      piAssistantPhase({
        role: "assistant",
        stopReason: "toolUse",
        content: [text("commentary"), text("final_answer")],
      }),
    ).toBe("final_answer");
  });

  it.each([
    ["toolUse", "commentary"],
    ["stop", "final_answer"],
    ["error", undefined],
    ["aborted", undefined],
    ["length", undefined],
  ])("uses terminal semantics only when no provider phase exists: %s", (stopReason, expected) => {
    expect(piAssistantPhase({ role: "assistant", stopReason, content: [text()] })).toBe(expected);
  });

  it("ignores malformed, unknown-version and unknown-phase signatures", () => {
    for (const signature of [
      "legacy-id",
      "{",
      JSON.stringify({ v: 2, id: "x", phase: "commentary" }),
      JSON.stringify({ v: 1, id: "x", phase: "unknown" }),
    ])
      expect(
        piAssistantPhase({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "answer", textSignature: signature }],
        }),
      ).toBe("final_answer");
  });

  it("does not assign an answer phase to hidden, empty or reasoning-only messages", () => {
    expect(
      piAssistantPhase({
        role: "custom",
        display: false,
        stopReason: "stop",
        content: [text("final_answer")],
      }),
    ).toBeUndefined();
    for (const content of [
      [],
      "",
      [{ type: "text", text: "  " }],
      [{ type: "thinking", thinking: "summary" }],
    ])
      expect(piAssistantPhase({ role: "assistant", stopReason: "stop", content })).toBeUndefined();
  });
});
