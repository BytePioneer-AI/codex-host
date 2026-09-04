import { describe, expect, it } from "vitest";

import { encodePenguinModelRef } from "../src/model-catalog.js";
import { projectPenguinHistory, type PenguinSessionInfo } from "../src/penguin-history.js";

const session: PenguinSessionInfo = {
  sessionId: "session-1",
  projectId: "project-1",
  agentId: "agent-1",
  provider: "openai",
  modelId: "gpt-test",
};

describe("Penguin history projection", () => {
  it("maps user, reasoning, tool, and assistant messages into one Host Turn", () => {
    const snapshot = projectPenguinHistory(
      {
        messages: [
          { type: "model_msg", payload: { type: "text", role: "user", text: "Inspect" } },
          { type: "model_msg", payload: { type: "thinking", role: "assistant", text: "Plan" } },
          {
            type: "model_msg",
            payload: {
              type: "tool_call",
              role: "assistant",
              tool_call_id: "tool-1",
              name: "read_file",
              arguments: '{"path":"README.md"}',
            },
          },
          {
            type: "model_msg",
            payload: {
              type: "tool_call_output",
              role: "tool",
              tool_call_id: "tool-1",
              output: "file contents",
            },
          },
          { type: "model_msg", payload: { type: "text", role: "assistant", text: "Done" } },
          { type: "event_msg", payload: { type: "request_end", status: "completed" } },
        ],
      },
      session,
      encodePenguinModelRef({ provider: session.provider, modelId: session.modelId }),
    );

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.input).toEqual([{ type: "text", text: "Inspect" }]);
    expect(snapshot.turns[0]?.outcome).toEqual({ status: "succeeded" });
    expect(snapshot.turns[0]?.items).toHaveLength(3);
    expect(snapshot.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "reasoning",
      "toolExecution",
      "agentMessage",
    ]);
    const tool = snapshot.turns[0]?.items[1]?.item;
    expect(tool).toMatchObject({
      type: "toolExecution",
      toolName: "read_file",
      arguments: { path: "README.md" },
      output: { content: [{ type: "text", text: "file contents" }] },
    });
  });

  it("marks an aborted native task as cancelled", () => {
    const snapshot = projectPenguinHistory(
      {
        messages: [
          { type: "model_msg", payload: { type: "text", role: "user", text: "Stop" } },
          { type: "event_msg", payload: { type: "abort" } },
        ],
      },
      session,
      encodePenguinModelRef({ provider: session.provider, modelId: session.modelId }),
    );

    expect(snapshot.turns[0]?.outcome).toEqual({
      status: "cancelled",
      reason: "Penguin Task was aborted",
    });
  });
});
