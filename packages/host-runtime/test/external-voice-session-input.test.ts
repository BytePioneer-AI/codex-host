import { describe, expect, it } from "vitest";
import { voiceSessionInputFromTurns } from "../src/external-voice-session-input.js";

describe("voice session input from Thread Turns", () => {
  it("seeds user and agent messages and skips commentary and tools", () => {
    expect(
      voiceSessionInputFromTurns([
        {
          items: [
            {
              type: "userMessage",
              content: [{ type: "text", text: "what files did you just find?" }],
            },
            { type: "commandExecution", command: "ls" },
            { type: "agentMessage", text: "Checking.", phase: "commentary" },
            {
              type: "agentMessage",
              text: "Only empty outputs/ and work/.",
              phase: "final_answer",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "what files did you just find?" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Only empty outputs/ and work/." }],
      },
    ]);
  });

  it("returns no input for a Thread with no speakable history", () => {
    expect(voiceSessionInputFromTurns([])).toEqual([]);
    expect(voiceSessionInputFromTurns([{ items: [{ type: "commandExecution" }] }])).toEqual([]);
  });
});
