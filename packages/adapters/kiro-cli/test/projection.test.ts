import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  projectKiroPermission,
  projectKiroToolCall,
  projectKiroUserInput,
} from "../src/projection.js";

describe("kiro projection", () => {
  const turnId = hostTurnIdSchema.parse("turn-1");

  describe("user input question projection", () => {
    it("projects choice question when options are provided", () => {
      const projected = projectKiroUserInput("inter-1", turnId, {
        sessionId: "sess-1",
        question: "Which option do you prefer?",
        options: [
          { title: "Option A", description: "Use approach A" },
          { title: "Option B", description: "Use approach B" },
        ],
      });

      expect(projected.interaction.type).toBe("question");
      expect(projected.interaction.interactionId).toBe("inter-1");
      expect(projected.interaction.questions).toHaveLength(1);

      const question = projected.interaction.questions[0];
      expect(question?.type).toBe("choice");
      if (question?.type === "choice") {
        expect(question.prompt).toBe("Which option do you prefer?");
        expect(question.options).toHaveLength(2);
        expect(question.options[0]?.label).toBe("Option A");
        expect(question.options[1]?.label).toBe("Option B");
      }

      // Test resolution on answered
      const resolved = projected.resolve({
        type: "question",
        cancelled: false,
        answers: { "q-0": ["opt-0"] },
      });
      expect(resolved).toEqual({ action: "answered", answer: "Option A" });

      // Test resolution on cancelled
      const cancelled = projected.resolve({
        type: "question",
        cancelled: true,
        answers: {},
      });
      expect(cancelled).toEqual({ action: "dismissed" });
    });

    it("projects text question when options are not provided", () => {
      const projected = projectKiroUserInput("inter-2", turnId, {
        sessionId: "sess-1",
        question: "Enter API key:",
      });

      expect(projected.interaction.questions).toHaveLength(1);
      const question = projected.interaction.questions[0];
      expect(question?.type).toBe("text");
      if (question?.type === "text") {
        expect(question.prompt).toBe("Enter API key:");
      }

      const resolved = projected.resolve({
        type: "question",
        cancelled: false,
        answers: { "q-0": ["sk-12345"] },
      });
      expect(resolved).toEqual({ action: "answered", answer: "sk-12345" });
    });
  });

  describe("permission request projection", () => {
    it("projects permission options with allow once and deny", () => {
      const req: RequestPermissionRequest = {
        toolCall: { toolCallId: "tool-1", title: "Tool" },
        sessionId: "sess-1",
        options: [
          { optionId: "opt-allow", name: "Allow this time", kind: "allow_once" },
          { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
        ],
      };

      const projected = projectKiroPermission("inter-p1", turnId, req);
      expect(projected.interaction.type).toBe("approval");
      expect(projected.interaction.actions).toHaveLength(2);

      const allowAction = projected.interaction.actions.find((a) => a.id === "opt-allow");
      expect(allowAction?.effect).toBe("allowOnce");

      const denyAction = projected.interaction.actions.find((a) => a.id === "opt-deny");
      expect(denyAction?.effect).toBe("deny");

      // Resolve selected
      const res = projected.resolve("opt-allow");
      expect(res).toEqual({
        outcome: { outcome: "selected", optionId: "opt-allow" },
      });

      // Resolve cancelled
      const resCancelled = projected.resolve("opt-allow", true);
      expect(resCancelled).toEqual({
        outcome: { outcome: "cancelled" },
      });
    });

    it("detects two-stage turn approval metadata", () => {
      const req: RequestPermissionRequest = {
        toolCall: { toolCallId: "tool-2", title: "Tool" },
        sessionId: "sess-1",
        options: [{ optionId: "allow", name: "Accept changes", kind: "allow_once" }],
        _meta: {
          kiro: {
            type: "turn_approval",
          },
        },
      };

      const projected = projectKiroPermission("inter-p2", turnId, req);
      expect(projected.interaction.description).toBe("Review modified files for this turn");
    });
  });

  describe("tool call projection", () => {
    it("projects subagent delegation when metadata marks agent-subtask", () => {
      const item = projectKiroToolCall("item-sub", {
        toolCallId: "tc-sub",
        status: "running",
        rawInput: { prompt: "Implement unit tests", name: "subagent-coder" },
        metadata: {
          kiro: {
            kind: "agent-subtask",
            agentSubtaskId: "subtask-123",
          },
        },
      });

      expect(item.type).toBe("subagentDelegation");
      if (item.type === "subagentDelegation") {
        expect(item.operation).toBe("spawn");
        expect(item.subagents).toHaveLength(1);
        expect(item.subagents[0]?.subagentId).toBe("subtask-123");
        expect(item.subagents[0]?.description).toBe("Implement unit tests");
        expect(item.subagents[0]?.role).toBe("subagent-coder");
        expect(item.subagents[0]?.status).toBe("running");
      }
    });

    it("projects command execution for bash or execute tools", () => {
      const item = projectKiroToolCall("item-cmd", {
        toolCallId: "tc-cmd",
        name: "execute_bash",
        kind: "execute",
        rawInput: { command: "npm test" },
        rawOutput: { exitCode: 0, output: "All tests passed" },
      });

      expect(item.type).toBe("commandExecution");
      if (item.type === "commandExecution") {
        expect(item.command).toBe("npm test");
        expect(item.exitCode).toBe(0);
        expect(item.output).toBe("All tests passed");
      }
    });

    it("projects standard tool execution with json arguments and output", () => {
      const item = projectKiroToolCall("item-tool", {
        toolCallId: "tc-tool",
        name: "fetch_weather",
        rawInput: { city: "Tokyo" },
        rawOutput: "Sunny 22C",
      });

      expect(item.type).toBe("toolExecution");
      if (item.type === "toolExecution") {
        expect(item.toolName).toBe("fetch_weather");
        expect(item.arguments).toEqual({ city: "Tokyo" });
        expect(item.output?.content).toEqual([{ type: "text", text: "Sunny 22C" }]);
      }
    });
  });
});
