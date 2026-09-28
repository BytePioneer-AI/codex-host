import { describe, expect, it } from "vitest";

import {
  projectKimiCommandsUpdate,
  projectKimiTextUpdate,
  projectKimiToolUpdate,
} from "../src/acp-transport.js";

describe("Kimi ACP transport projection", () => {
  it("reads agent message and thought text from ACP content blocks", () => {
    expect(
      projectKimiTextUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "KIMI_PROBE_DONE" },
      }),
    ).toEqual({ type: "agent.text", text: "KIMI_PROBE_DONE" });

    expect(
      projectKimiTextUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking the workspace" },
      }),
    ).toEqual({ type: "agent.thought", text: "Checking the workspace" });
  });

  it("reads tool identity and input from ACP tool fields", () => {
    expect(
      projectKimiToolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "2:toolu_bash",
        title: "Bash",
        kind: "execute",
        rawInput: { command: "cat probe.txt" },
      }),
    ).toEqual({
      type: "tool.call",
      toolCallId: "2:toolu_bash",
      name: "Bash",
      kind: "execute",
      args: { command: "cat probe.txt" },
    });
  });

  it("reads native command descriptors from availableCommands", () => {
    expect(
      projectKimiCommandsUpdate({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "compact",
            description: "Compact the current session",
            input: { hint: "optional instructions" },
          },
        ],
      }),
    ).toEqual({
      type: "commands.update",
      commands: [
        {
          name: "compact",
          description: "Compact the current session",
          input: { hint: "optional instructions" },
        },
      ],
    });
  });
});
