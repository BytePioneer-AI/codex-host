import { describe, expect, it } from "vitest";

import { activeBranchIds, terminalChecks, userEntryIds } from "./live-helpers.mjs";

describe("Gate C Native Live evidence helpers", () => {
  it("uses the active parent chain rather than append order", () => {
    const entries = [
      { id: "u1", parentId: null, type: "message", message: { role: "user" } },
      { id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
      { id: "abandoned", parentId: "u1", type: "message", message: { role: "user" } },
      { id: "u2", parentId: "a1", type: "message", message: { role: "user" } },
    ];
    expect(activeBranchIds(entries, "u2")).toEqual(["u1", "a1", "u2"]);
    expect(userEntryIds(entries)).toEqual(["u1", "abandoned", "u2"]);
  });

  it("requires agent_end before exactly one settled event and idle state", () => {
    expect(
      terminalChecks([{ type: "agent_start" }, { type: "agent_end" }, { type: "agent_settled" }], {
        isStreaming: false,
      }),
    ).toEqual({
      agentStarted: true,
      agentEnded: true,
      agentSettled: true,
      endedBeforeSettled: true,
      nonStreamingState: true,
      singleSettled: true,
    });
  });
});
