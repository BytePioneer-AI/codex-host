import { describe, expect, it } from "vitest";

import {
  allSessionsMatch,
  nativeToolResults,
  nativeToolUses,
  PushableInput,
  sdkUserMessage,
} from "./live-helpers.mjs";

describe("Claude live helpers", () => {
  it("preserves caller User identity through the pushable input", async () => {
    const input = new PushableInput();
    const message = sdkUserMessage("synthetic-session", "synthetic text", "synthetic-user");
    input.push(message);
    input.end();
    const values = [];
    for await (const value of input) values.push(value);
    expect(values).toEqual([message]);
  });

  it("correlates native Tool Uses and Tool Results", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tool-1", name: "Edit", input: {} }],
        },
      },
      {
        type: "user",
        parent_tool_use_id: "tool-1",
        tool_use_result: { structuredPatch: [] },
      },
    ];
    expect(nativeToolUses(messages).map(({ id }) => id)).toEqual(["tool-1"]);
    expect(nativeToolResults(messages).map(({ id }) => id)).toEqual(["tool-1"]);
  });

  it("requires at least one observed Session and rejects mismatches", () => {
    expect(allSessionsMatch([{ type: "result" }], "session-1")).toBe(false);
    expect(allSessionsMatch([{ session_id: "session-1" }], "session-1")).toBe(true);
    expect(allSessionsMatch([{ session_id: "session-2" }], "session-1")).toBe(false);
  });
});
