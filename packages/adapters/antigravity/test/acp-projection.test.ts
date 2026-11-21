import path from "node:path";
import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { validateHostInteractionResponse, type HostEvent } from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { applyPatch } from "diff";
import { describe, expect, it, vi } from "vitest";
import {
  AntigravityToolTracker,
  buildAcpElicitationResponse,
  buildAcpPermissionResponse,
  buildLiveCommandCatalog,
  projectAcpApprovalInteraction,
  projectAcpQuestionInteraction,
  projectAcpSessionUpdate,
  projectReplayedEventsToTurns,
} from "../src/acp-projection.js";
import type { AntigravityAcpEvent } from "../src/acp-types.js";

const turnId = hostTurnIdSchema.parse("turn-live");
const interactionId = hostInteractionIdSchema.parse("interaction-live");
const cwd = path.resolve("/repo");
const base = { turnId, interactionId, sessionId: "native", cwd };
function form(properties: Record<string, unknown>, required?: string[]): CreateElicitationRequest {
  return {
    sessionId: "native",
    toolCallId: "ask-1",
    mode: "form",
    message: "The agent has a question.",
    requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
  } as CreateElicitationRequest;
}
const choices = [
  { const: "1", title: "(Recommended) Red" },
  { const: "2", title: "Blue" },
];
function tracker(outputLimit?: number) {
  const events: HostEvent[] = [];
  const spawned = vi.fn();
  const tools = new AntigravityToolTracker({
    turnId,
    cwd,
    emit: (event) => events.push(event),
    onSubagentSpawned: spawned,
    parentConfiguration: { model: "parent", reasoningEffort: "high" },
    ...(outputLimit === undefined ? {} : { outputLimit }),
  });
  return { tools, events, spawned };
}

describe("ACP native notifications", () => {
  it.each([
    ["user_message_chunk", "user.text"],
    ["agent_message_chunk", "agent.text"],
    ["agent_thought_chunk", "agent.thought"],
  ])("projects %s", (sessionUpdate, type) => {
    expect(
      projectAcpSessionUpdate({ sessionUpdate, content: { type: "text", text: "hello" } }),
    ).toEqual({ type, text: "hello" });
  });
  it("does not turn an image into empty text", () =>
    expect(
      projectAcpSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "abc" },
      }),
    ).toBeNull());
  it.each(["tool_call", "tool_call_update"])(
    "preserves all native tool fields for %s",
    (sessionUpdate) => {
      const fields = {
        toolCallId: "call-1",
        name: "write_to_file",
        title: "Write",
        kind: "edit",
        status: "completed",
        args: { path: "/repo/a" },
        rawInput: { path: "/repo/a" },
        rawOutput: "done",
        locations: [{ path: "/repo/a" }],
        content: [{ type: "diff", path: "/repo/a", newText: "a" }],
      };
      expect(projectAcpSessionUpdate({ sessionUpdate, ...fields })).toEqual({
        type: sessionUpdate === "tool_call" ? "tool.call" : "tool.update",
        ...fields,
      });
    },
  );
  it("maps usage, modes, configuration, commands and session info", () => {
    expect(projectAcpSessionUpdate({ sessionUpdate: "usage_update", used: 14, size: 200 })).toEqual(
      { type: "usage.context", used: 14, size: 200 },
    );
    expect(
      projectAcpSessionUpdate({ sessionUpdate: "config_option_update", configOptions: [] }),
    ).toEqual({ type: "config.update", configOptions: [] });
    expect(
      projectAcpSessionUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
    ).toEqual({ type: "mode.update", currentModeId: "plan" });
    expect(
      projectAcpSessionUpdate({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "quota", description: "Limits" }],
      }),
    ).toEqual({ type: "commands.update", commands: [{ name: "quota", description: "Limits" }] });
    expect(
      projectAcpSessionUpdate({ sessionUpdate: "session_info_update", title: "Session title" }),
    ).toEqual({ type: "session.info", title: "Session title" });
    expect(projectAcpSessionUpdate({ sessionUpdate: "future_update" })).toBeNull();
  });
});

describe("native approvals", () => {
  it("only advertises the supplied native options, preserving their scope", () => {
    const request = {
      sessionId: "native",
      toolCall: { toolCallId: "t", name: "run_command", kind: "execute", args: { command: "pwd" } },
      options: [
        { optionId: "once", name: "Once", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "session", name: "Session", kind: "allow_session" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
        { optionId: "never", name: "Never", kind: "reject_always" },
        { optionId: "future", name: "Future", kind: "unknown" },
      ],
    } as unknown as RequestPermissionRequest;
    const projected = projectAcpApprovalInteraction({ ...base, request });
    expect(projected.interaction.actions.map(({ effect }) => effect)).toEqual([
      "allowOnce",
      "allowAlways",
      "allowForSession",
      "deny",
      "deny",
    ]);
    expect(projected.interaction.title).toContain("Command execution");
    expect(projected.interaction.description).toBe("pwd");
    expect(
      validateHostInteractionResponse(projected.interaction, {
        type: "approval",
        actionId: "always",
      }),
    ).toBeNull();
    expect(
      buildAcpPermissionResponse({
        actionId: "always",
        actionToOptionId: projected.actionToOptionId,
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
    expect(
      buildAcpPermissionResponse({
        actionId: "invented",
        actionToOptionId: projected.actionToOptionId,
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });
  it.each([
    ["edit", "write_to_file", "File modification"],
    ["read", "view_file", "Tool execution"],
    ["execute", "custom_shell", "Command execution"],
  ])("categorizes %s", (kind, name, category) => {
    const { interaction } = projectAcpApprovalInteraction({
      ...base,
      request: {
        sessionId: "native",
        toolCall: { toolCallId: "t", kind, name, title: "Native title" },
        options: [],
      } as RequestPermissionRequest,
    });
    expect(interaction.title).toBe(`${category}: Native title`);
    expect(interaction.actions).toEqual([]);
  });
});

describe("elicitation form mapping", () => {
  it("maps real single choice + Other without rendering a separate Other question", () => {
    const projected = projectAcpQuestionInteraction({
      ...base,
      request: form(
        {
          q1: { type: "string", title: "Pick a color", oneOf: choices },
          q1_other: { type: "string", title: "Other" },
        },
        ["q1"],
      ),
      rawQuestions: [
        {
          question: "Pick a color",
          options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
        },
      ],
    });
    expect(projected.interaction.questions).toEqual([
      {
        id: "q1",
        type: "choice",
        prompt: "Pick a color",
        options: [
          { value: "1", label: "(Recommended) Red", description: "Warm" },
          { value: "2", label: "Blue" },
        ],
        multiple: false,
        allowOther: true,
        optional: false,
      },
    ]);
    expect(
      buildAcpElicitationResponse({
        fieldMap: projected.fieldMap,
        response: { type: "question", answers: { q1: ["2"] } },
      }),
    ).toEqual({ action: "accept", content: { q1: "2", q1_other: "" } });
    expect(
      buildAcpElicitationResponse({
        fieldMap: projected.fieldMap,
        response: { type: "question", answers: { q1: ["Green"] } },
      }),
    ).toEqual({ action: "accept", content: { q1_other: "Green" } });
    expect(
      validateHostInteractionResponse(projected.interaction, { type: "question", answers: {} }),
    ).toMatchObject({ code: "invalidRequest" });
    expect(
      validateHostInteractionResponse(projected.interaction, {
        type: "question",
        answers: { q1: ["Green"] },
      }),
    ).toBeNull();
  });
  it.each(["oneOf", "anyOf", "enum"])("supports multiple choices using items.%s", (variant) => {
    const projected = projectAcpQuestionInteraction({
      ...base,
      request: form(
        {
          q1: {
            type: "array",
            title: "Colors",
            items: { type: "string", [variant]: variant === "enum" ? ["1", "2"] : choices },
          },
          q1_other: { type: "string" },
        },
        ["q1"],
      ),
    });
    expect(projected.interaction.questions[0]).toMatchObject({
      type: "choice",
      multiple: true,
      allowOther: true,
      optional: false,
    });
    const response = { type: "question" as const, answers: { q1: ["1", "2", "Green"] } };
    expect(validateHostInteractionResponse(projected.interaction, response)).toBeNull();
    expect(buildAcpElicitationResponse({ fieldMap: projected.fieldMap, response })).toEqual({
      action: "accept",
      content: { q1: ["1", "2"], q1_other: "Green" },
    });
  });
  it("never invents a preset choice for an Other-only answer, even with explicit required", () => {
    const projected = projectAcpQuestionInteraction({
      ...base,
      request: form({ q1: { type: "string", oneOf: choices }, q1_other: { type: "string" } }, [
        "q1",
      ]),
    });
    expect(
      buildAcpElicitationResponse({
        fieldMap: projected.fieldMap,
        response: { type: "question", answers: { q1: ["Green"] } },
      }),
    ).toEqual({ action: "accept", content: { q1_other: "Green" } });
  });
  it.each(["choice", "text", "multiple"])(
    "accepts an empty answer for %s when native schema omits required",
    (kind) => {
      const prop =
        kind === "choice"
          ? { type: "string", oneOf: choices }
          : kind === "multiple"
            ? { type: "array", items: { type: "string", anyOf: choices } }
            : { type: "string" };
      const { interaction } = projectAcpQuestionInteraction({
        ...base,
        request: form({ q1: prop }),
      });
      expect(interaction.questions[0]?.optional).toBe(true);
      expect(
        validateHostInteractionResponse(interaction, { type: "question", answers: {} }),
      ).toBeNull();
    },
  );
  it("honors an explicit required list, including an empty list", () => {
    const properties = { q1: { type: "string", oneOf: choices }, q2: { type: "string" } };
    const partial = projectAcpQuestionInteraction({ ...base, request: form(properties, ["q2"]) });
    expect(partial.interaction.questions.map(({ optional }) => optional)).toEqual([true, false]);
    const optional = projectAcpQuestionInteraction({ ...base, request: form(properties, []) });
    expect(optional.interaction.questions.map(({ optional }) => optional)).toEqual([true, true]);
    expect(
      validateHostInteractionResponse(optional.interaction, { type: "question", answers: {} }),
    ).toBeNull();
    expect(
      buildAcpElicitationResponse({
        fieldMap: optional.fieldMap,
        response: { type: "question", answers: {} },
      }),
    ).toEqual({ action: "accept", content: { q2: "" } });
  });
  it("supports plain text and cancellation", () => {
    const projected = projectAcpQuestionInteraction({
      ...base,
      request: form({ q1: { type: "string", title: "Your name" } }, ["q1"]),
    });
    expect(projected.interaction.questions[0]).toEqual({
      id: "q1",
      type: "text",
      prompt: "Your name",
      multiline: false,
      secret: false,
      optional: false,
    });
    expect(
      buildAcpElicitationResponse({
        fieldMap: projected.fieldMap,
        response: { type: "question", answers: { q1: ["Ada"] } },
      }),
    ).toEqual({ action: "accept", content: { q1: "Ada" } });
    expect(
      buildAcpElicitationResponse({
        fieldMap: projected.fieldMap,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).toEqual({ action: "cancel" });
  });
  it("does not treat an unpaired _other field as a hidden question", () => {
    const projected = projectAcpQuestionInteraction({
      ...base,
      request: form({ q1_other: { type: "string", title: "Notes" } }),
    });
    expect(projected.interaction.questions).toHaveLength(1);
  });
});

describe("tool lifecycle and file changes", () => {
  it("uses updated rawInput instead of stale initial args", () => {
    const { tools } = tracker();
    tools.handleToolEvent({
      type: "tool.call",
      toolCallId: "t",
      name: "run_command",
      args: { command: "old" },
    });
    tools.handleToolEvent({
      type: "tool.update",
      toolCallId: "t",
      rawInput: { command: "new" },
      status: "completed",
    });
    expect(tools.rawToolInput("t")).toEqual({ command: "new" });
    expect(tools.completedSnapshots()[0]?.item).toMatchObject({
      type: "commandExecution",
      command: "new",
    });
  });
  it("projects execute-kind calls even with an arbitrary native name", () => {
    const { tools } = tracker();
    tools.handleToolEvent({
      type: "tool.call",
      toolCallId: "1",
      name: "custom",
      kind: "execute",
      rawInput: { cmd: "false" },
      status: "failed",
      rawOutput: "failure",
    });
    expect(tools.completedSnapshots()[0]).toMatchObject({
      item: { type: "commandExecution", command: "false", exitCode: 1 },
      outcome: { status: "failed" },
    });
  });
  it("projects ask_question as an active toolExecution item and exposes itemId + raw input for elicitation", () => {
    const { tools, events } = tracker();
    tools.handleToolEvent({
      type: "tool.call",
      toolCallId: "q",
      name: "ask_question",
      args: { questions: [{ question: "Q?" }] },
    });
    const activeItemId = tools.activeToolItemId("q");
    expect(activeItemId).toMatch(/^tool-/u);
    expect(tools.rawToolInput("q")).toEqual({ questions: [{ question: "Q?" }] });
    tools.handleToolEvent({
      type: "tool.update",
      toolCallId: "q",
      status: "completed",
      rawOutput: "Alpha",
    });
    expect(tools.activeToolItemId("q")).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "item.updated",
      "item.completed",
    ]);
    expect(tools.completedSnapshots()[0]).toMatchObject({
      item: {
        type: "toolExecution",
        itemId: activeItemId,
        toolName: "ask_question",
        output: { content: [{ type: "text", text: "Alpha" }] },
      },
      outcome: { status: "succeeded" },
    });
  });
  it.each([
    [undefined, "new\n", "add"],
    ["old\n", "new\n", "update"],
    ["old\n", undefined, "delete"],
  ] as const)("creates %s -> %s file patches", (oldText, newText, kind) => {
    const { tools, events } = tracker();
    tools.handleToolEvent({
      type: "tool.call",
      toolCallId: "write",
      name: "write_to_file",
      content: [
        {
          type: "diff",
          path: "/repo/src/a.ts",
          ...(oldText === undefined ? {} : { oldText }),
          ...(newText === undefined ? {} : { newText }),
        },
      ],
      status: "completed",
    });
    const file = tools.completedSnapshots().find(({ item }) => item.type === "fileChange");
    if (file?.item.type !== "fileChange") throw new Error("missing file change");
    expect(file.item).toMatchObject({ type: "fileChange", changes: [{ path: "src/a.ts", kind }] });
    expect(applyPatch(oldText ?? "", file.item.changes[0]?.unifiedDiff ?? "")).toBe(newText ?? "");
    expect(events.filter(({ type }) => type === "item.completed")).toHaveLength(2);
  });
  it("rearms child observation for a new send to the same child within a Turn", () => {
    const { tools, spawned } = tracker();
    const id = "11111111-1111-4111-8111-111111111111";
    tools.handleToolEvent({
      type: "tool.call",
      toolCallId: "spawn",
      name: "invoke_subagent",
      args: { subagent_id: id },
    });
    tools.handleToolEvent({ type: "tool.update", toolCallId: "spawn", status: "completed" });
    tools.handleToolEvent({
      type: "tool.call",
      toolCallId: "send",
      name: "send_message",
      args: { subagent_id: id, message: "retry" },
    });
    tools.handleToolEvent({ type: "tool.update", toolCallId: "send", status: "completed" });
    expect(spawned).toHaveBeenCalledTimes(2);
  });
  it("emits generic tool output and closes pending items on cancellation", () => {
    const { tools, events } = tracker();
    tools.handleToolEvent({
      type: "tool.update",
      toolCallId: "r",
      name: "view_file",
      rawInput: { path: "a" },
      content: [{ type: "content", content: { type: "text", text: "result" } }],
    });
    tools.finishPending({ status: "cancelled" });
    tools.finishPending({ status: "cancelled" });
    expect(tools.completedSnapshots()).toMatchObject([
      {
        item: {
          type: "toolExecution",
          toolName: "view_file",
          output: { content: [{ type: "text", text: "result" }] },
        },
        outcome: { status: "cancelled" },
      },
    ]);
    expect(events.filter(({ type }) => type === "item.completed")).toHaveLength(1);
  });
  it.each(["invoke_subagent", "send_message"])(
    "tracks %s native identity and inherited configuration",
    (name) => {
      const { tools, spawned } = tracker();
      const id = "12345678-1234-1234-1234-123456789abc";
      tools.handleToolEvent({
        type: "tool.call",
        toolCallId: "child",
        name,
        args: { prompt: "Do work", model: "child-model" },
      });
      tools.handleToolEvent({
        type: "tool.update",
        toolCallId: "child",
        rawOutput: { parent_id: "aaaaaaaa-1234-1234-1234-123456789abc", subagent_id: id },
        status: "in_progress",
      });
      tools.handleToolEvent({
        type: "tool.update",
        toolCallId: "child",
        rawOutput: `Child ${id} finished`,
        status: "completed",
      });
      expect(spawned).toHaveBeenCalledTimes(1);
      expect(spawned.mock.calls[0]?.[0]).toBe(id);
      expect(tools.completedSnapshots()[0]).toMatchObject({
        item: {
          type: "subagentDelegation",
          operation: name === "invoke_subagent" ? "spawn" : "send",
          subagents: [
            {
              nativeSubagentId: id,
              model: "child-model",
              reasoningEffort: "high",
              status: "completed",
            },
          ],
        },
      });
    },
  );
});

describe("history replay", () => {
  const events: AntigravityAcpEvent[] = [
    { type: "session.info", title: "History" },
    { type: "user.text", text: "Hel" },
    { type: "user.text", text: "lo" },
    { type: "agent.thought", text: "Think" },
    { type: "agent.thought", text: "ing" },
    {
      type: "tool.call",
      toolCallId: "arbitrary/工具:id",
      name: "view_file",
      rawInput: { path: "a" },
    },
    {
      type: "tool.update",
      toolCallId: "arbitrary/工具:id",
      status: "completed",
      rawOutput: "file",
    },
    { type: "agent.text", text: "One" },
    { type: "agent.text", text: " answer" },
    { type: "usage.context", used: 100, size: 1000 },
    { type: "user.text", text: "Next" },
    { type: "agent.text", text: "Two" },
  ];
  it("groups consecutive user chunks into logical turns and keeps all IDs deterministic", () => {
    const params = { nativeSessionId: "native", cwd: "/repo", events };
    const first = projectReplayedEventsToTurns(params);
    expect(projectReplayedEventsToTurns(params)).toEqual(first);
    expect(first).toHaveLength(2);
    expect(first[0]?.input).toEqual([{ type: "text", text: "Hello" }]);
    expect(first[0]?.items.map(({ item }) => item.type)).toEqual([
      "reasoning",
      "toolExecution",
      "agentMessage",
    ]);
    expect(first[0]?.items[0]?.item).toMatchObject({ text: "Thinking" });
    expect(first[0]?.items[2]?.item).toMatchObject({ text: "One answer" });
    expect(
      first.map(({ nativeTurnRef, checkpoint }) => [
        nativeTurnRef.nativeTurnKey,
        checkpoint?.checkpointId,
      ]),
    ).toEqual([
      ["turn-0", "turn-0"],
      ["turn-1", "turn-1"],
    ]);
    const ids = first.flatMap(({ items }) =>
      items.map(({ item }) => hostItemIdSchema.parse(item.itemId)),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("uses the last native user boundary for merged logical turns", () => {
    const events: AntigravityAcpEvent[] = [];
    for (let index = 0; index < 15; index++) {
      events.push({ type: "user.text", text: `input-${index}`, nativeTurnIndex: index });
      if (index !== 11) events.push({ type: "agent.text", text: `reply-${index}` });
    }

    const result = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd: "/repo",
      events,
      knownTurnRefs: [
        ...Array.from({ length: 14 }, (_, index) =>
          nativeTurnRefSchema.parse({
            harnessId: "antigravity",
            nativeSessionId: "native",
            nativeTurnKey: `turn-${index === 13 ? 14 : index}`,
            formatVersion: 1,
          }),
        ),
      ],
    });

    expect(result).toHaveLength(14);
    expect(result[11]?.input).toEqual([{ type: "text", text: "input-11input-12" }]);
    expect(result[11]?.checkpoint?.checkpointId).toBe("turn-12");
    expect(result[13]?.nativeTurnRef.nativeTurnKey).toBe("turn-14");
    expect(result[13]?.checkpoint?.checkpointId).toBe("turn-14");
  });
  it("keeps a known identity for the final native boundary of a merged group", () => {
    const events: AntigravityAcpEvent[] = [];
    for (let nativeTurnIndex = 0; nativeTurnIndex < 15; nativeTurnIndex++) {
      events.push({
        type: "user.text",
        text: nativeTurnIndex === 10 ? "/compact" : `input-${nativeTurnIndex}`,
        nativeTurnIndex,
      });
      if (nativeTurnIndex !== 10)
        events.push({ type: "agent.text", text: `reply-${nativeTurnIndex}` });
    }
    const knownTurnRefs = [
      ...Array.from({ length: 10 }, (_, nativeTurnIndex) => `turn-${nativeTurnIndex}`),
      ...Array.from({ length: 4 }, (_, index) => `turn-${index + 11}`),
    ].map((nativeTurnKey) =>
      nativeTurnRefSchema.parse({
        harnessId: "antigravity",
        nativeSessionId: "native",
        nativeTurnKey,
        formatVersion: 1,
      }),
    );
    const result = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd: "/repo",
      events,
      knownTurnRefs,
    });
    expect(result).toHaveLength(14);
    expect(result[10]?.input).toEqual([{ type: "text", text: "/compactinput-11" }]);
    expect(result[10]?.nativeTurnRef.nativeTurnKey).toBe("turn-11");
    expect(result[10]?.checkpoint?.checkpointId).toBe("turn-11");
  });
  it("keeps cold replay identities stable when reread with its generated refs", () => {
    const events: AntigravityAcpEvent[] = [];
    for (let nativeTurnIndex = 0; nativeTurnIndex < 15; nativeTurnIndex++) {
      events.push({ type: "user.text", text: `input-${nativeTurnIndex}`, nativeTurnIndex });
      if (nativeTurnIndex !== 10)
        events.push({ type: "agent.text", text: `reply-${nativeTurnIndex}` });
    }
    const params = { nativeSessionId: "native", cwd: "/repo", events };
    const first = projectReplayedEventsToTurns(params);
    const second = projectReplayedEventsToTurns({
      ...params,
      knownTurnRefs: first.map(({ nativeTurnRef }) => nativeTurnRef),
    });
    expect(first.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
      "turn-3",
      "turn-4",
      "turn-5",
      "turn-6",
      "turn-7",
      "turn-8",
      "turn-9",
      "turn-11",
      "turn-12",
      "turn-13",
      "turn-14",
    ]);
    expect(second.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual(
      first.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey),
    );
  });
  it("preserves known native turn keys independently of checkpoint positions", () => {
    const known = nativeTurnRefSchema.parse({
      harnessId: "antigravity",
      nativeSessionId: "native",
      nativeTurnKey: "stored-key",
      formatVersion: 1,
    });
    const result = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd: "/repo",
      events,
      knownTurnRefs: [known],
    });
    expect(result[0]?.nativeTurnRef.nativeTurnKey).toBe("stored-key");
    expect(result[0]?.checkpoint?.checkpointId).toBe("turn-0");
  });
  it("preserves known turn keys and skips them when generating a fallback", () => {
    const result = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd: "/repo",
      events: [...events, { type: "user.text", text: "Third" }],
      knownTurnRefs: ["turn-0", "turn-2"].map((nativeTurnKey) =>
        nativeTurnRefSchema.parse({
          harnessId: "antigravity",
          nativeSessionId: "native",
          nativeTurnKey,
          formatVersion: 1,
        }),
      ),
    });
    expect(result.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual([
      "turn-0",
      "turn-2",
      "turn-3",
    ]);
  });
  it("maps sparse native identities by native boundary and preserves nonnumeric keys", () => {
    const knownTurnRefs = ["turn-0", "turn-2", "stored-key"].map((nativeTurnKey) =>
      nativeTurnRefSchema.parse({
        harnessId: "antigravity",
        nativeSessionId: "native",
        nativeTurnKey,
        formatVersion: 1,
      }),
    );
    const result = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd: "/repo",
      events: [
        { type: "user.text" as const, text: "input-0", nativeTurnIndex: 0 },
        { type: "agent.text" as const, text: "reply-0" },
        { type: "user.text" as const, text: "input-1", nativeTurnIndex: 1 },
        { type: "agent.text" as const, text: "reply-1" },
        { type: "user.text" as const, text: "input-2", nativeTurnIndex: 2 },
      ],
      knownTurnRefs,
    });
    expect(result.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
    ]);
    expect(result.map(({ checkpoint }) => checkpoint?.checkpointId)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
    ]);
  });
  it("keeps a nonnumeric native identity when replay provides its boundary", () => {
    const [turn] = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd: "/repo",
      events: [{ type: "user.text", text: "input", nativeTurnIndex: 0 }],
      knownTurnRefs: [
        nativeTurnRefSchema.parse({
          harnessId: "antigravity",
          nativeSessionId: "native",
          nativeTurnKey: "stored-key",
          formatVersion: 1,
        }),
      ],
    });
    expect(turn?.nativeTurnRef.nativeTurnKey).toBe("stored-key");
  });
  it("keeps a later nonnumeric identity after an earlier mapping is removed", () => {
    const events: AntigravityAcpEvent[] = Array.from({ length: 4 }, (_, nativeTurnIndex) => [
      { type: "user.text" as const, text: `input-${nativeTurnIndex}`, nativeTurnIndex },
      { type: "agent.text" as const, text: `reply-${nativeTurnIndex}` },
    ]).flat();
    const result = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd: "/repo",
      events,
      knownTurnRefs: ["turn-0", "turn-2", "stored-key"].map((nativeTurnKey) =>
        nativeTurnRefSchema.parse({
          harnessId: "antigravity",
          nativeSessionId: "native",
          nativeTurnKey,
          formatVersion: 1,
        }),
      ),
    });
    expect(result.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
      "stored-key",
    ]);
  });
  it("does not consume a later nonnumeric identity before its native boundary", () => {
    const events: AntigravityAcpEvent[] = Array.from({ length: 4 }, (_, nativeTurnIndex) => [
      { type: "user.text" as const, text: `input-${nativeTurnIndex}`, nativeTurnIndex },
      { type: "agent.text" as const, text: `reply-${nativeTurnIndex}` },
    ]).flat();
    const result = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd: "/repo",
      events,
      knownTurnRefs: ["turn-2", "stored-key"].map((nativeTurnKey) =>
        nativeTurnRefSchema.parse({
          harnessId: "antigravity",
          nativeSessionId: "native",
          nativeTurnKey,
          formatVersion: 1,
        }),
      ),
    });
    expect(result.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
      "stored-key",
    ]);
  });
  it.each([
    ["turn-0", "stored-key"],
    ["legacy-first", "stored-key"],
    ["turn-0", "turn-1"], // Upgrade with saved display-position keys.
  ])(
    "does not consume the next group identity while merging native events (%s, %s)",
    (...nativeTurnKeys) => {
      const result = projectReplayedEventsToTurns({
        nativeSessionId: "native",
        cwd: "/repo",
        events: [
          { type: "user.text", text: "input-0", nativeTurnIndex: 0 },
          { type: "user.text", text: "input-1", nativeTurnIndex: 1 },
          { type: "agent.text", text: "reply-01" },
          { type: "user.text", text: "input-2", nativeTurnIndex: 2 },
          { type: "agent.text", text: "reply-2" },
        ],
        knownTurnRefs: nativeTurnKeys.map((nativeTurnKey) =>
          nativeTurnRefSchema.parse({
            harnessId: "antigravity",
            nativeSessionId: "native",
            nativeTurnKey,
            formatVersion: 1,
          }),
        ),
      });
      expect(result.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey)).toEqual(
        nativeTurnKeys,
      );
      expect(result.map(({ checkpoint }) => checkpoint?.checkpointId)).toEqual([
        "turn-1",
        "turn-2",
      ]);
    },
  );
  it("does not invent turns from metadata and marks unterminated tools interrupted", () => {
    expect(
      projectReplayedEventsToTurns({
        nativeSessionId: "s",
        cwd: "/repo",
        events: [{ type: "session.info", title: "Title" }],
      }),
    ).toEqual([]);
    const result = projectReplayedEventsToTurns({
      nativeSessionId: "s",
      cwd: "/repo",
      events: [
        { type: "user.text", text: "a" },
        { type: "tool.call", toolCallId: "t", name: "read" },
        { type: "user.text", text: "b" },
      ],
    });
    expect(result[0]?.items[0]?.outcome.status).toBe("cancelled");
    expect(result[0]?.outcome.status).toBe("unknown");
  });
  it("merges consecutive replayed agent text into one completed Item", () => {
    const [turn] = projectReplayedEventsToTurns({
      nativeSessionId: "native",
      cwd,
      events: [
        { type: "user.text", text: "question" },
        { type: "agent.text", text: "answer " },
        { type: "agent.text", text: "before restart" },
        { type: "agent.text", text: "after restart" },
      ],
    });
    expect(turn?.input).toEqual([{ type: "text", text: "question" }]);
    expect(turn?.items).toEqual([
      {
        item: {
          type: "agentMessage",
          itemId: "turn-0-item-0",
          text: "answer before restartafter restart",
        },
        outcome: { status: "succeeded" },
      },
    ]);
  });
});

it("merges live commands with built-ins and ignores duplicates/invalid names", () => {
  const catalog = buildLiveCommandCatalog([
    { name: "quota", description: "Limits" },
    { name: "/plan", description: "Duplicate" },
    { name: "two words", description: "Invalid" },
  ]);
  expect(catalog.commands.filter(({ invocation }) => invocation === "/plan")).toHaveLength(1);
  expect(catalog.commands.find(({ id }) => id === "antigravity.quota")).toMatchObject({
    invocation: "/quota",
    description: "Limits",
  });
  expect(catalog.commands.some(({ invocation }) => invocation === "/two words")).toBe(false);
});

describe("idle background output replay consistency", () => {
  const nativeSessionId = "native";
  const idleTail: AntigravityAcpEvent[] = [
    { type: "user.text", text: "first question" },
    { type: "agent.text", text: "first answer" },
    // Idle background output arrives after end_turn, before the next prompt.
    { type: "agent.text", text: "awake: " },
    { type: "agent.text", text: "done" },
    { type: "user.text", text: "second question" },
    { type: "agent.text", text: "second answer" },
  ];

  it("attributes idle tail output to the preceding Turn exactly like the live adapter", () => {
    const turns = projectReplayedEventsToTurns({
      nativeSessionId,
      cwd: "/repo",
      events: idleTail,
    });
    expect(turns).toHaveLength(2);
    // Live attribution: the idle episode belongs to the most recently completed
    // Turn (turn index 0). Replay merges the answer and the idle tail into one
    // consecutive agentMessage run; without a native messageId, Item-level
    // granularity stays a protocol limit (design §10.1), while Turn attribution
    // and full text content stay identical on both sides.
    const first = turns[0];
    const texts = first?.items
      .filter(({ item }) => item.type === "agentMessage")
      .map(({ item }) => (item as { text: string }).text);
    expect(texts).toEqual(["first answerawake: done"]);
    expect(turns[1]?.items.map(({ item }) => item.type)).toEqual(["agentMessage"]);
    // Native Turn keys stay positional and untouched by idle output.
    expect(turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual(["turn-0", "turn-1"]);
  });

  it("keeps replay idempotent across repeated loads", () => {
    const params = { nativeSessionId, cwd: "/repo", events: idleTail };
    const first = projectReplayedEventsToTurns(params);
    expect(projectReplayedEventsToTurns(params)).toEqual(first);
    expect(projectReplayedEventsToTurns(params)).toEqual(first);
  });

  it("keeps idle-only tails on the last Turn without inventing a new Turn", () => {
    const turns = projectReplayedEventsToTurns({
      nativeSessionId,
      cwd: "/repo",
      events: [
        { type: "user.text", text: "only question" },
        { type: "agent.text", text: "answer" },
        { type: "agent.thought", text: "late thought" },
      ],
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.items.map(({ item }) => item.type)).toEqual(["agentMessage", "reasoning"]);
  });
});
