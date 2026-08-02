import { describe, expect, it } from "vitest";
import type { HostApprovalInteraction } from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { CodexTurnProjector, projectCodexApprovalRequest } from "../src/index.js";

const interaction = (
  overrides: Partial<HostApprovalInteraction> = {},
): HostApprovalInteraction => ({
  type: "approval",
  interactionId: hostInteractionIdSchema.parse("approval-1"),
  turnId: hostTurnIdSchema.parse("turn-1"),
  title: "Allow Claude Code native action?",
  description: "One-shot native Harness approval",
  subject: { type: "nativeAction" },
  actions: [
    { id: "allow", label: "Allow once", effect: "allowOnce" },
    { id: "reject", label: "Deny", effect: "deny" },
  ],
  ...overrides,
});

describe("Codex native Approval wire projection", () => {
  it("projects the reviewed MCP Tool Approval shape and exact one-shot responses", () => {
    const projected = projectCodexApprovalRequest({
      threadId: "thread-1",
      interaction: interaction(),
      serverName: "Claude Code",
    });

    expect(projected.request).toEqual({
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "Claude Code",
        threadId: "thread-1",
        turnId: "turn-1",
        mode: "form",
        message: "Allow Claude Code native action?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          reason: "One-shot native Harness approval",
        },
      },
    });
    expect(projected.parseResponse({ action: "accept", content: {}, _meta: null })).toEqual({
      type: "approval",
      actionId: "allow",
    });
    expect(projected.parseResponse({ action: "decline", content: null, _meta: null })).toEqual({
      type: "approval",
      actionId: "reject",
    });
    expect(projected.parseResponse({ action: "cancel" })).toEqual(projected.denyResponse);
  });

  it("projects and parses only declared Session and always scopes", () => {
    const projected = projectCodexApprovalRequest({
      threadId: "thread-1",
      interaction: interaction({
        actions: [
          { id: "allow", label: "Allow once", effect: "allowOnce" },
          {
            id: "session",
            label: "Allow this conversation",
            effect: "allowForSession",
          },
          { id: "always", label: "Always allow", effect: "allowAlways" },
          { id: "reject", label: "Deny", effect: "deny" },
        ],
      }),
      serverName: "Claude Code",
    });

    expect(projected.request).toMatchObject({
      params: { _meta: { persist: ["session", "always"] } },
    });
    expect(
      projected.parseResponse({
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      }),
    ).toEqual({ type: "approval", actionId: "session" });
    expect(
      projected.parseResponse({
        action: "accept",
        content: {},
        _meta: { persist: "always" },
      }),
    ).toEqual({ type: "approval", actionId: "always" });
  });

  it("rejects malformed, undeclared, and unreviewed responses", () => {
    const projected = projectCodexApprovalRequest({
      threadId: "thread-1",
      interaction: interaction(),
      serverName: "Claude Code",
    });

    expect(() => projected.parseResponse({})).toThrow("missing action");
    expect(() => projected.parseResponse({ action: "allowForSession" })).toThrow(
      "unsupported action",
    );
    expect(() =>
      projected.parseResponse({ action: "accept", content: { unexpected: true } }),
    ).toThrow("non-empty accepted content");
    expect(() =>
      projected.parseResponse({
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      }),
    ).toThrow("undeclared session scope");
    expect(() =>
      projected.parseResponse({ action: "accept", _meta: { persist: "future" } }),
    ).toThrow("malformed persist metadata");
    expect(() => projected.parseResponse({ action: "accept", extra: true })).toThrow(
      "unreviewed fields",
    );
  });

  it("requires exactly one bounded Allow Once and Deny action", () => {
    expect(() =>
      projectCodexApprovalRequest({
        threadId: "thread-1",
        interaction: interaction({
          actions: [{ id: "deny", label: "Deny", effect: "deny" }],
        }),
        serverName: "Claude Code",
      }),
    ).toThrow("exactly one allowOnce action");
    expect(() =>
      projectCodexApprovalRequest({
        threadId: "thread-1",
        interaction: interaction({ title: "x".repeat(121) }),
        serverName: "Claude Code",
      }),
    ).toThrow("title must contain 1 to 120 characters");
  });

  it("tracks Approval lifecycle without fabricating a Tool or File Change Item", () => {
    const projector = new CodexTurnProjector({
      threadId: "thread-1",
      turnId: hostTurnIdSchema.parse("turn-1"),
      cwd: "/synthetic",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId: hostTurnIdSchema.parse("turn-1") });

    expect(projector.projectApproval(interaction(), "Claude Code").messages).toEqual([]);
    expect(
      projector.project({
        type: "interaction.closed",
        interactionId: hostInteractionIdSchema.parse("approval-1"),
        turnId: hostTurnIdSchema.parse("turn-1"),
        reason: "responded",
      }).messages,
    ).toEqual([]);
    const completed = projector.project({
      type: "turn.completed",
      turnId: hostTurnIdSchema.parse("turn-1"),
      outcome: { status: "succeeded" },
    });
    expect(completed.completedTurn).toMatchObject({ items: [] });
    expect(completed.messages.some(({ method }) => method === "item/started")).toBe(false);
  });
});
