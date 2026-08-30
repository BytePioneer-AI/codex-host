import { describe, expect, it } from "vitest";

import { parseAntigravityModels, parseAntigravityStreamLine } from "../src/index.js";

describe("Antigravity Adapter", () => {
  it("parses the CLI Model catalog", () => {
    expect(
      parseAntigravityModels(
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
      ),
    ).toMatchObject({
      models: [
        { ref: { id: "gemini-3.7-flash-high" }, label: "Gemini 3.7 Flash (High)" },
        { ref: { id: "claude-sonnet-4-6" }, label: "Claude Sonnet 4.6 (Thinking)" },
      ],
      defaultModel: { id: "gemini-3.7-flash-high" },
      thinkingOptions: [],
    });
  });

  it("accepts typed stream events and ignores terminal noise", () => {
    expect(
      parseAntigravityStreamLine(
        '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"hi"}}',
      ),
    ).toMatchObject({ event: "step_update", step_update: { text_delta: "hi" } });
    expect(parseAntigravityStreamLine("permission warning")).toBeNull();
  });
});
