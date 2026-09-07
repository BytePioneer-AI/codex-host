import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { projectCodexApprovalRequest } from "@codexhost/protocol-core";
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
    function scopedRequest() {
      return {
        sessionId: "sess-1",
        toolCall: { toolCallId: "git-1", title: "git add sample.txt" },
        options: [
          { optionId: "accept", name: "Allow", kind: "allow_once" },
          { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
          { optionId: "reject", name: "Deny", kind: "reject_once" },
          { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
        ],
        _meta: {
          kiro: {
            toolId: "execute_bash",
            consent: {
              capability: "shell",
              resource: "git add sample.txt",
              askType: "implicit",
              workspaceRoot: "/workspace",
            },
          },
        },
      } satisfies RequestPermissionRequest;
    }

    it("offers only command-specific approvals without a scope cross-product", () => {
      const projected = projectKiroPermission("scoped", turnId, scopedRequest());
      expect(projected.interaction.actions.map(({ label }) => label)).toEqual([
        "Allow",
        "Deny",
        "Allow (this session) - Exact command: git add sample.txt",
        "Allow (save for workspace) - Exact command: git add sample.txt",
        "Allow (save for workspace) - Command prefix: git add *",
        "Allow (save for workspace) - Program prefix: git *",
      ]);
      const wire = projectCodexApprovalRequest({
        threadId: "thread-1",
        interaction: projected.interaction,
        serverName: "Kiro CLI",
      });
      expect(wire.request.params).toMatchObject({
        requestedSchema: {
          properties: {
            actionId: {
              oneOf: projected.interaction.actions.map(({ id, label }) => ({
                const: id,
                title: label,
              })),
            },
          },
        },
      });
      for (const action of projected.interaction.actions) {
        const response = projected.resolve(action.id);
        if (action.id === "accept" || action.id === "reject") {
          expect(response).toEqual({ outcome: { outcome: "selected", optionId: action.id } });
          continue;
        }
        const [optionId, scope] = JSON.parse(action.id.slice("kiro-consent:".length));
        expect(response).toMatchObject({
          outcome: { outcome: "selected", optionId },
          _meta: { kiro: { consent: { scope, capability: "shell", workspaceRoot: "/workspace" } } },
        });
        expect(action.effect).toBe(
          optionId === "always-reject"
            ? "deny"
            : scope === "session"
              ? "allowForSession"
              : "allowAlways",
        );
        const consent = response._meta?.kiro as { consent: { resource: string } };
        expect(["git add sample.txt", "git add *", "git *"]).toContain(consent.consent.resource);
        expect(action.label).toContain(consent.consent.resource);
      }
      const grants = projected.interaction.actions.filter((action) =>
        ["allowForSession", "allowAlways"].includes(action.effect),
      );
      expect(grants).toHaveLength(4);
      expect(projected.resolve("not-offered")).toEqual({ outcome: { outcome: "cancelled" } });
      const grant = grants[0];
      if (!grant) throw new Error("Expected a persistent grant");
      expect(projected.resolve(grant.id, true)).toEqual({ outcome: { outcome: "cancelled" } });
      expect(projected.interaction.actions.find((action) => action.effect === "deny")?.id).toBe(
        "reject",
      );
    });

    it("keeps Write File approval to tool choices, not file or command rules", () => {
      const request = scopedRequest();
      request.toolCall.title = "Write File";
      request._meta.kiro.toolId = "fs_write";
      request._meta.kiro.consent.capability = "fs:write";
      request._meta.kiro.consent.resource = "test_tool_demo.py";
      const projected = projectKiroPermission("write", turnId, request);
      expect(projected.interaction.actions.map(({ label }) => label)).toEqual([
        "Allow",
        "Deny",
        "Allow (this session) - Entire tool (*)",
        "Allow (save for workspace) - Entire tool (*)",
      ]);
      const saved = projected.interaction.actions.find(({ effect }) => effect === "allowAlways");
      if (!saved) throw new Error("Missing saved tool approval");
      const wire = projectCodexApprovalRequest({
        threadId: "thread-1",
        interaction: projected.interaction,
        serverName: "Kiro CLI",
      });
      expect(wire.request.params).toMatchObject({
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
      });
      expect(wire.parseResponse({ action: "accept", _meta: { persist: "always" } })).toEqual({
        type: "approval",
        actionId: saved.id,
      });
      expect(wire.parseResponse({ action: "cancel" })).toEqual({
        type: "approval",
        actionId: "reject",
      });
      expect(projected.resolve(saved.id)).toEqual({
        outcome: { outcome: "selected", optionId: "always-accept" },
        _meta: {
          kiro: {
            consent: {
              capability: "fs:write",
              resource: "*",
              scope: "workspace",
              workspaceRoot: "/workspace",
            },
          },
        },
      });
      expect(projected.resolve("always-reject")).toEqual({ outcome: { outcome: "cancelled" } });
    });

    it("does not replace an absent workspace with a global saved rule", () => {
      const request = scopedRequest();
      request._meta.kiro.consent.workspaceRoot = "";
      const projected = projectKiroPermission("no-workspace", turnId, request);
      expect(projected.interaction.actions.map(({ label }) => label)).toEqual([
        "Allow",
        "Deny",
        "Allow (this session) - Exact command: git add sample.txt",
      ]);
    });

    it.each(["", "*"])("does not offer blanket shell access for resource %j", (resource) => {
      const request = scopedRequest();
      request._meta.kiro.consent.resource = resource;
      const projected = projectKiroPermission("missing-command", turnId, request);
      expect(projected.interaction.actions.map(({ label }) => label)).toEqual(["Allow", "Deny"]);
    });

    it.each([
      ["explicit ask", { askType: "explicit" }],
      ["non-persistable consent", { persistableConsent: false }],
    ])("does not offer persistent allows for %s", (_name, restrictions) => {
      const request = scopedRequest();
      const kiro = request._meta.kiro;
      Object.assign(kiro.consent, restrictions);
      const projected = projectKiroPermission("restricted", turnId, request);
      expect(
        projected.interaction.actions.some((action) =>
          ["allowForSession", "allowAlways"].includes(action.effect),
        ),
      ).toBe(false);
    });

    it.each(["sudo git add sample.txt", "git add a; rm b", 'git add "a b"', "git add a\nrm b"])(
      "does not guess a shell prefix for %s",
      (command) => {
        const request = scopedRequest();
        const kiro = request._meta.kiro;
        kiro.consent.resource = command;
        const projected = projectKiroPermission("complex", turnId, request);
        expect(
          projected.interaction.actions.some((action) => action.label.includes("prefix:")),
        ).toBe(false);
      },
    );

    it("rejects duplicate native action IDs", () => {
      const request = scopedRequest();
      const option = request.options[0];
      if (!option) throw new Error("Expected a native option");
      request.options.push(option);
      expect(() => projectKiroPermission("duplicate", turnId, request)).toThrow(
        "duplicate approval",
      );
    });

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
