import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { PermissionUpdate, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";

import {
  allowsDangerouslySkipPermissions,
  ClaudeSdkModelInspector,
  ClaudeSdkTransport,
  type ClaudeSdkTransportOptions,
} from "../src/sdk-transport.js";
import type {
  ClaudeAutonomousTurn,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
} from "../src/transport.js";

class FakeQuery {
  readonly accountInfo = vi.fn(async () => ({ apiProvider: "firstParty" as const }));
  readonly initializationResult = vi.fn(async () => ({
    models: [
      {
        value: "default",
        displayName: "Default",
        description: "Default",
        supportsAutoMode: true,
      },
    ],
  }));
  readonly interrupt = vi.fn(async () => undefined);
  readonly getContextUsage = vi.fn(
    async (): Promise<{
      totalTokens: number;
      maxTokens: number;
      model: string;
    }> => ({
      totalTokens: 40,
      maxTokens: 200,
      model: "runtime-model",
    }),
  );
  readonly setModel = vi.fn(async () => undefined);
  readonly applyFlagSettings = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);
  #closed = false;
  #messages: SDKMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  push(message: SDKMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.#messages.push(message);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.#messages.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

type QueryInput = Parameters<NonNullable<ClaudeSdkTransportOptions["queryFactory"]>>[0];

function fixture(
  openMode: "create" | "resume" = "create",
  permissionMode: ClaudeSdkTransportOptions["permissionMode"] = "default",
  thinkingOptionId = harnessThinkingOptionIdSchema.parse("auto"),
  environment?: NodeJS.ProcessEnv,
) {
  const fakeQuery = new FakeQuery();
  let queryInput: QueryInput | undefined;
  const queryFactory: NonNullable<ClaudeSdkTransportOptions["queryFactory"]> = vi.fn((input) => {
    queryInput = input;
    return fakeQuery as unknown as Query;
  });
  const onFault = vi.fn();
  const onPermissionModeChanged = vi.fn();
  const onPlanLimit = vi.fn();
  const transport = new ClaudeSdkTransport({
    command: process.execPath,
    ...(environment ? { environment } : {}),
    cwd: process.cwd(),
    sessionId: "00000000-0000-4000-8000-000000000001",
    openMode,
    permissionMode,
    thinkingOptionId,
    closeTimeoutMs: 100,
    onPermissionModeChanged,
    onFault,
    onPlanLimit,
    queryFactory,
  });
  return {
    fakeQuery,
    onFault,
    onPermissionModeChanged,
    onPlanLimit,
    queryFactory,
    queryInput: () => {
      if (!queryInput) throw new Error("SDK query was not created");
      return queryInput;
    },
    transport,
  };
}

function completeTurn(fakeQuery: FakeQuery): void {
  fakeQuery.push({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
  } as unknown as SDKMessage);
}

function pushPartialText(
  fakeQuery: FakeQuery,
  text: string,
  uuid = "00000000-0000-4000-8000-000000000020",
): void {
  fakeQuery.push({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    parent_tool_use_id: null,
    uuid,
    session_id: "00000000-0000-4000-8000-000000000001",
  } as unknown as SDKMessage);
}

function pushAssistantText(
  fakeQuery: FakeQuery,
  text: string,
  uuid = "00000000-0000-4000-8000-000000000021",
): void {
  fakeQuery.push({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid,
    session_id: "00000000-0000-4000-8000-000000000001",
  } as unknown as SDKMessage);
}

function options(value: ReturnType<typeof fixture>): NonNullable<QueryInput["options"]> {
  const queryOptions = value.queryInput().options;
  if (!queryOptions) throw new Error("SDK query options are missing");
  return queryOptions;
}

function questionInput() {
  return {
    questions: [
      {
        question: "Which path?",
        header: "Path",
        options: [
          { label: "Alpha", description: "First", preview: "ignored" },
          { label: "Beta", description: "Second" },
        ],
        multiSelect: false,
      },
    ],
  };
}

describe("ClaudeSdkTransport context Usage", () => {
  it("reads the stable Query context operation and rejects invalid observations", async () => {
    const value = fixture();

    await expect(value.transport.getContextUsage()).resolves.toBeNull();
    expect(value.fakeQuery.getContextUsage).not.toHaveBeenCalled();

    await value.transport.start();
    await expect(value.transport.getContextUsage()).resolves.toEqual({
      usedTokens: 40,
      maxTokens: 200,
      model: "runtime-model",
    });

    value.fakeQuery.getContextUsage.mockResolvedValueOnce({
      totalTokens: -1,
      maxTokens: 0,
      model: "",
    });
    await expect(value.transport.getContextUsage()).rejects.toThrow("invalid values");

    value.fakeQuery.getContextUsage.mockRejectedValueOnce(new Error("context unavailable"));
    await expect(value.transport.getContextUsage()).rejects.toThrow("context unavailable");
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport plan-limit forwarding", () => {
  it("forwards a tracked rate-limit event regardless of active Turn state", async () => {
    const value = fixture();
    await value.transport.start();

    value.fakeQuery.push({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.45, resetsAt: 1_787_674_200 },
          seven_day: { utilization: 0.1, resetsAt: 1_787_940_000 },
        },
      },
      uuid: "00000000-0000-4000-8000-000000000099",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(value.onPlanLimit).toHaveBeenCalledOnce());
    expect(value.onPlanLimit).toHaveBeenCalledWith({
      fiveHour: { utilizationPercent: 45, resetsAtUnix: 1_787_674_200 },
      sevenDay: { utilizationPercent: 10, resetsAtUnix: 1_787_940_000 },
    });
    await value.transport.close();
  });

  it("does not forward an untracked rate-limit type", async () => {
    const value = fixture();
    await value.transport.start();

    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000023",
      (event) => events.push(event),
    );
    value.fakeQuery.push({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "overage", utilization: 45 },
      uuid: "00000000-0000-4000-8000-000000000099",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);
    await turn;
    expect(value.onPlanLimit).not.toHaveBeenCalled();
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport text reconciliation", () => {
  it("keeps a permission-denial Tool loop successful when text surrounds the callback", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000022",
      (event) => events.push(event),
    );

    pushPartialText(value.fakeQuery, "before");
    pushAssistantText(value.fakeQuery, "before tool\n");
    await vi.waitFor(() => {
      expect(events.filter(({ type }) => type === "text.delta")).toEqual([
        {
          type: "text.delta",
          messageId: "00000000-0000-4000-8000-000000000020",
          delta: "before",
        },
        {
          type: "text.delta",
          messageId: "00000000-0000-4000-8000-000000000020",
          delta: " tool\n",
        },
      ]);
    });

    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const permission = canUseTool(
      "Edit",
      { file_path: "/synthetic/file" },
      {
        signal: new AbortController().signal,
        toolUseID: "text-loop-tool",
        requestId: "text-loop-control",
        displayName: "Edit file",
      },
    );
    const approval = events.find(
      (event) => event.type === "interaction.requested" && event.request.type === "approval",
    );
    if (!approval || approval.type !== "interaction.requested") {
      throw new Error("Approval was not emitted");
    }
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: approval.request.requestId,
      decision: "deny",
    });
    await expect(permission).resolves.toMatchObject({
      behavior: "deny",
      decisionClassification: "user_reject",
    });

    pushPartialText(value.fakeQuery, "after", "00000000-0000-4000-8000-000000000023");
    pushAssistantText(value.fakeQuery, "after denial", "00000000-0000-4000-8000-000000000024");
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(
      events.flatMap((event) => (event.type === "text.delta" ? [event.delta] : [])).join(""),
    ).toBe("before tool\nafter denial");
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("publishes one automatic Compaction lifecycle before continued text", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000024",
      (event) => events.push(event),
    );

    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "00000000-0000-4000-8000-000000000025",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      uuid: "00000000-0000-4000-8000-000000000026",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 180, post_tokens: 30 },
      uuid: "00000000-0000-4000-8000-000000000027",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    pushAssistantText(value.fakeQuery, "continued", "00000000-0000-4000-8000-000000000028");
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.completed", outcome: "succeeded" },
      {
        type: "text.delta",
        messageId: "00000000-0000-4000-8000-000000000028",
        delta: "continued",
      },
      {
        type: "message.completed",
        messageId: "00000000-0000-4000-8000-000000000028",
        checkpointId: "00000000-0000-4000-8000-000000000028",
      },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("sends compact as /compact on the SDK input stream", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const compact = value.transport.compact(
      "00000000-0000-4000-8000-000000000043",
      "Keep implementation details",
      (event) => events.push(event),
    );
    const prompt = value.queryInput().prompt;
    if (typeof prompt === "string" || prompt === undefined) {
      throw new Error("SDK compact prompt stream was not configured");
    }
    const submitted = await prompt[Symbol.asyncIterator]().next();
    expect(submitted.value).toMatchObject({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000043",
      message: { role: "user", content: "/compact Keep implementation details" },
    });

    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "00000000-0000-4000-8000-000000000040",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      uuid: "00000000-0000-4000-8000-000000000041",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);

    await expect(compact).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.completed", outcome: "succeeded" },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("sends init and recap as slash commands on the SDK input stream", async () => {
    const value = fixture();
    await value.transport.start();
    const prompt = value.queryInput().prompt;
    if (typeof prompt === "string" || prompt === undefined) {
      throw new Error("SDK command prompt stream was not configured");
    }
    const iterator = prompt[Symbol.asyncIterator]();

    const init = value.transport.init("00000000-0000-4000-8000-000000000044", () => undefined);
    expect((await iterator.next()).value).toMatchObject({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000044",
      message: { role: "user", content: "/init" },
    });
    completeTurn(value.fakeQuery);
    await expect(init).resolves.toEqual({ status: "succeeded" });

    const recapEvents: ClaudeTurnEvent[] = [];
    const recap = value.transport.recap("00000000-0000-4000-8000-000000000045", (event) =>
      recapEvents.push(event),
    );
    expect((await iterator.next()).value).toMatchObject({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000045",
      message: { role: "user", content: "/recap" },
    });
    value.fakeQuery.push({
      type: "system",
      subtype: "local_command_output",
      content: "Built compact command and subagent projection.",
      uuid: "00000000-0000-4000-8000-000000000042",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);
    await expect(recap).resolves.toEqual({ status: "succeeded" });
    expect(recapEvents).toEqual([
      {
        type: "text.delta",
        messageId: "00000000-0000-4000-8000-000000000042",
        delta: "Built compact command and subagent projection.",
      },
      {
        type: "message.completed",
        messageId: "00000000-0000-4000-8000-000000000042",
        checkpointId: "00000000-0000-4000-8000-000000000042",
      },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Tool interpretation", () => {
  it("publishes correlated Tool and reliable native file events before the terminal", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000030",
      (event) => events.push(event),
    );

    value.fakeQuery.push({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000031",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "edit-1",
            name: "Edit",
            input: { file_path: "/synthetic/sample.txt" },
          },
        ],
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "tool_progress",
      tool_use_id: "edit-1",
      tool_name: "Edit",
      parent_tool_use_id: null,
      elapsed_time_seconds: 0.5,
      uuid: "00000000-0000-4000-8000-000000000032",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as SDKMessage);
    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000033",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: "edit-1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "edit-1", content: "edited", is_error: false },
        ],
      },
      tool_use_result: {
        filePath: "/synthetic/sample.txt",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      },
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      {
        type: "tool.started",
        callId: "edit-1",
        toolName: "Edit",
        arguments: { file_path: "/synthetic/sample.txt" },
      },
      {
        type: "message.completed",
        messageId: "00000000-0000-4000-8000-000000000031",
        checkpointId: "00000000-0000-4000-8000-000000000031",
      },
      { type: "tool.progress", callId: "edit-1", elapsedMs: 500 },
      {
        type: "tool.completed",
        callId: "edit-1",
        toolName: "Edit",
        outputText: "edited",
        isError: false,
        fileChange: {
          path: "/synthetic/sample.txt",
          kind: "update",
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-old", "+new"],
            },
          ],
        },
      },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });

  it("publishes Agent delegation while hiding nested Subagent execution", async () => {
    const value = fixture();
    await value.transport.start();
    expect(options(value).forwardSubagentText).toBe(true);
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "delegate",
      "00000000-0000-4000-8000-000000000034",
      (event) => events.push(event),
    );

    value.fakeQuery.push({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000035",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      message: {
        id: "root-agent-message",
        content: [
          {
            type: "tool_use",
            id: "agent-1",
            name: "Agent",
            input: {
              description: "Inspect implementation",
              subagent_type: "Explore",
              run_in_background: true,
              prompt: "private prompt",
            },
          },
        ],
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "agent-1",
      description: "Inspect implementation",
      subagent_type: "Explore",
      uuid: "00000000-0000-4000-8000-000000000036",
      session_id: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000037",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: "agent-1",
      message: {
        id: "nested-message",
        content: [
          { type: "text", text: "nested text" },
          { type: "tool_use", id: "nested-read", name: "Read", input: {} },
        ],
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000038",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: "agent-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "nested-read",
            content: "nested contents",
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000039",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: "agent-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "agent-1",
            content: "Agent launched successfully",
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      {
        type: "subagent.started",
        operation: "spawn",
        callId: "agent-1",
        description: "Inspect implementation",
        prompt: "private prompt",
        role: "Explore",
        background: true,
      },
      {
        type: "message.completed",
        messageId: "root-agent-message",
        checkpointId: "00000000-0000-4000-8000-000000000035",
      },
      {
        type: "subagent.updated",
        callId: "agent-1",
        status: "running",
        description: "Inspect implementation",
        role: "Explore",
        nativeSubagentId: "task-1",
      },
      { type: "subagent.transcript.changed", callId: "agent-1" },
      { type: "subagent.transcript.changed", callId: "agent-1" },
      { type: "subagent.transcript.changed", callId: "agent-1" },
      {
        type: "subagent.completed",
        callId: "agent-1",
        isError: false,
        resultSummary: "Agent launched successfully",
      },
    ]);
    expect(value.onFault).not.toHaveBeenCalled();
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport autonomous task continuation", () => {
  it("publishes Root output produced after a background task notification", async () => {
    const value = fixture();
    const autonomous: ClaudeAutonomousTurn[] = [];
    value.transport.setAutonomousTurnHandler((turn) => autonomous.push(turn));
    await value.transport.start();

    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000040",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content:
          "<task-notification><task-id>native-agent-1</task-id><tool-use-id>send-1</tool-use-id><summary>Analysis complete</summary></task-notification>",
      },
    } as unknown as SDKMessage);
    pushPartialText(
      value.fakeQuery,
      "Background analysis result",
      "00000000-0000-4000-8000-000000000041",
    );
    pushAssistantText(
      value.fakeQuery,
      "Background analysis result",
      "00000000-0000-4000-8000-000000000042",
    );
    completeTurn(value.fakeQuery);

    await vi.waitFor(() => expect(autonomous).toHaveLength(1));
    expect(autonomous[0]).toMatchObject({
      nativeTurnKey: "00000000-0000-4000-8000-000000000040",
      result: { status: "succeeded" },
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Analysis complete",
        },
        { type: "text.delta", delta: "Background analysis result" },
        { type: "message.completed" },
      ],
    });
    await value.transport.close();
  });

  it("preserves a failed task-notification whose user content is text blocks", async () => {
    const value = fixture();
    const autonomous: ClaudeAutonomousTurn[] = [];
    value.transport.setAutonomousTurnHandler((turn) => autonomous.push(turn));
    await value.transport.start();

    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000050",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<task-notification><task-id>a78414260bd2f9554</task-id><status>failed</status><summary>Agent failed</summary></task-notification>",
          },
        ],
      },
    } as unknown as SDKMessage);
    pushAssistantText(value.fakeQuery, "Continuation", "00000000-0000-4000-8000-000000000051");
    completeTurn(value.fakeQuery);

    await vi.waitFor(() => expect(autonomous).toHaveLength(1));
    expect(autonomous[0]?.events.filter((event) => event.type === "subagent.settled")).toEqual([
      {
        type: "subagent.settled",
        nativeSubagentId: "a78414260bd2f9554",
        status: "failed",
        resultSummary: "Agent failed",
      },
    ]);
    await value.transport.close();
  });

  it("publishes a held task-notification exactly once with its native status", async () => {
    const value = fixture();
    const events: ClaudeTurnEvent[] = [];
    const terminals: ClaudeTransportTurnResult[] = [];
    value.transport.setIdleTurnHandler({
      onEvent: (event) => events.push(event),
      onTerminal: (result) => terminals.push(result),
    });
    await value.transport.start();
    value.transport.setIdleLive(true);

    value.fakeQuery.push({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000070",
      session_id: "00000000-0000-4000-8000-000000000001",
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      message: {
        role: "user",
        content:
          "<task-notification><task-id>native-agent-interrupted</task-id><status>stopped</status><summary>Agent stopped</summary></task-notification>",
      },
    } as unknown as SDKMessage);
    pushAssistantText(
      value.fakeQuery,
      "Interruption reported",
      "00000000-0000-4000-8000-000000000071",
    );
    completeTurn(value.fakeQuery);

    await vi.waitFor(() => expect(terminals).toEqual([{ status: "succeeded" }]));
    expect(events.filter((event) => event.type === "subagent.settled")).toEqual([
      {
        type: "subagent.settled",
        nativeSubagentId: "native-agent-interrupted",
        status: "interrupted",
        resultSummary: "Agent stopped",
      },
    ]);
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport process environment", () => {
  it("adds the Host Node runtime to the Claude process PATH", async () => {
    const value = fixture("create", "default", harnessThinkingOptionIdSchema.parse("auto"), {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });

    await value.transport.start();
    expect(options(value).env?.PATH?.split(path.delimiter)).toContain(
      path.dirname(process.execPath),
    );
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Permission Mode control", () => {
  it("passes the initial mode once, acknowledges bypass support, and delegates later switching", async () => {
    const value = fixture("create", "auto");

    await value.transport.start();
    expect(options(value).permissionMode).toBe("auto");
    expect(options(value).allowDangerouslySkipPermissions).toBe(true);
    expect(value.fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    expect(value.transport.getPermissionMode()).toBe("auto");

    await value.transport.setPermissionMode("acceptEdits");
    expect(value.fakeQuery.setPermissionMode).toHaveBeenCalledOnce();
    expect(value.fakeQuery.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    expect(value.transport.getPermissionMode()).toBe("acceptEdits");
    await value.transport.close();
  });

  it("publishes supported native status changes and ignores modes outside the catalog", async () => {
    const value = fixture();
    await value.transport.start();

    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: null,
      permissionMode: "acceptEdits",
    } as unknown as SDKMessage);
    await vi.waitFor(() => {
      expect(value.onPermissionModeChanged).toHaveBeenCalledWith("acceptEdits");
    });
    expect(value.transport.getPermissionMode()).toBe("acceptEdits");

    value.fakeQuery.push({
      type: "system",
      subtype: "status",
      status: null,
      permissionMode: "dontAsk",
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(value.onFault).not.toHaveBeenCalled();
    expect(value.transport.getPermissionMode()).toBe("acceptEdits");
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Thinking control", () => {
  it("maps Auto, explicit effort, and Off through structured SDK settings", async () => {
    const value = fixture();

    await value.transport.start();
    expect(options(value).thinking).toEqual({ type: "adaptive" });
    expect(options(value).effort).toBeUndefined();

    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("high"));
    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("off"));
    await value.transport.setThinkingOption(harnessThinkingOptionIdSchema.parse("auto"));
    expect(value.fakeQuery.applyFlagSettings).toHaveBeenNthCalledWith(1, {
      alwaysThinkingEnabled: true,
      effortLevel: "high",
    });
    expect(value.fakeQuery.applyFlagSettings).toHaveBeenNthCalledWith(2, {
      alwaysThinkingEnabled: false,
    });
    expect(value.fakeQuery.applyFlagSettings).toHaveBeenNthCalledWith(3, {
      alwaysThinkingEnabled: true,
      effortLevel: null,
    });
    await value.transport.close();
  });

  it("passes explicit and disabled Thinking when creating the Query", async () => {
    const explicit = fixture("create", "default", harnessThinkingOptionIdSchema.parse("xhigh"));
    await explicit.transport.start();
    expect(options(explicit).thinking).toEqual({ type: "adaptive" });
    expect(options(explicit).effort).toBe("xhigh");
    await explicit.transport.close();

    const disabled = fixture("create", "default", harnessThinkingOptionIdSchema.parse("off"));
    await disabled.transport.start();
    expect(options(disabled).thinking).toEqual({ type: "disabled" });
    expect(options(disabled).effort).toBeUndefined();
    await disabled.transport.close();
  });
});

describe("ClaudeSdkTransport root safety", () => {
  it("does not enable dangerous permission skipping when running as root", () => {
    expect(allowsDangerouslySkipPermissions(() => 0)).toBe(false);
  });

  it("enables dangerous permission skipping for non-root and platforms without getuid", () => {
    expect(allowsDangerouslySkipPermissions(() => 1000)).toBe(true);
    expect(allowsDangerouslySkipPermissions(undefined)).toBe(true);
  });
});

describe("ClaudeSdkTransport Model control", () => {
  it("passes create-time Model and delegates setter without sending input", async () => {
    const value = fixture();
    const selected = new ClaudeSdkTransport({
      command: process.execPath,
      cwd: process.cwd(),
      sessionId: "00000000-0000-4000-8000-000000000009",
      openMode: "create",
      model: "custom-model",
      permissionMode: "default",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
      closeTimeoutMs: 100,
      onPermissionModeChanged: value.onPermissionModeChanged,
      onFault: value.onFault,
      onPlanLimit: value.onPlanLimit,
      queryFactory: value.queryFactory,
    });

    await selected.start();
    expect(options(value).model).toBe("custom-model");
    await selected.setModel("sonnet");
    await selected.setModel(undefined);
    expect(value.fakeQuery.setModel).toHaveBeenNthCalledWith(1, "sonnet");
    expect(value.fakeQuery.setModel).toHaveBeenNthCalledWith(2, undefined);
    await selected.close();
  });

  it("detects Model selection without probing Context Usage", async () => {
    const value = fixture();
    value.fakeQuery.getContextUsage.mockRejectedValueOnce(new Error("must not be called"));
    const inspector = new ClaudeSdkModelInspector({
      command: process.execPath,
      cwd: process.cwd(),
      closeTimeoutMs: 100,
      queryFactory: value.queryFactory,
    });

    await expect(inspector.inspect()).resolves.toMatchObject({ canSelectModel: true });
    expect(value.fakeQuery.getContextUsage).not.toHaveBeenCalled();
  });

  it("inspects initialization Models with persistence disabled", async () => {
    const value = fixture();
    const inspector = new ClaudeSdkModelInspector({
      command: process.execPath,
      environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      cwd: process.cwd(),
      closeTimeoutMs: 100,
      queryFactory: value.queryFactory,
    });

    await expect(inspector.inspect()).resolves.toEqual({
      models: [
        {
          value: "default",
          displayName: "Default",
          description: "Default",
          supportsAutoMode: true,
        },
      ],
      canSelectModel: true,
      canSelectPermissionMode: true,
    });
    expect(value.fakeQuery.getContextUsage).not.toHaveBeenCalled();
    expect(options(value)).toMatchObject({
      persistSession: false,
      includePartialMessages: false,
      tools: [],
      settingSources: ["user"],
    });
    expect(options(value).env?.PATH?.split(path.delimiter)).toContain(
      path.dirname(process.execPath),
    );
    expect(options(value)).not.toHaveProperty("sessionId");
    expect(options(value)).not.toHaveProperty("resume");
  });
});

describe("ClaudeSdkTransport Question callbacks", () => {
  it("uses caller identity for create and the same Native Session for resume", async () => {
    const created = fixture();
    await created.transport.start();
    expect(options(created)).toMatchObject({
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(options(created).resume).toBeUndefined();
    await created.transport.close();

    const resumed = fixture("resume");
    await resumed.transport.start();
    expect(options(resumed)).toMatchObject({
      resume: "00000000-0000-4000-8000-000000000001",
    });
    expect(options(resumed).sessionId).toBeUndefined();
    await resumed.transport.close();
  });

  it("forwards ordered visible reasoning and text events from SDK messages", async () => {
    const value = fixture();
    await value.transport.start();
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000002",
      (event) => events.push(event),
    );
    const assistantId = "00000000-0000-4000-8000-000000000003";
    value.fakeQuery.push({
      type: "stream_event",
      uuid: assistantId,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "visible" },
      },
    } as unknown as SDKMessage);
    value.fakeQuery.push({
      type: "assistant",
      uuid: assistantId,
      message: {
        content: [
          { type: "thinking", thinking: "visible reasoning", signature: "ignored" },
          { type: "text", text: "answer" },
        ],
      },
    } as unknown as SDKMessage);
    completeTurn(value.fakeQuery);

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      { type: "reasoning.delta", messageId: assistantId, delta: "visible" },
      { type: "reasoning.completed", messageId: assistantId },
      { type: "text.delta", messageId: assistantId, delta: "answer" },
      { type: "message.completed", messageId: assistantId, checkpointId: assistantId },
    ]);
    await value.transport.close();
  });

  it("inherits native Tools and returns an exact AskUserQuestion PermissionResult", async () => {
    const value = fixture();
    await value.transport.start();
    const queryOptions = options(value);
    expect(queryOptions.permissionMode).toBe("default");
    expect(queryOptions).not.toHaveProperty("tools");
    expect(queryOptions.onUserDialog).toBeUndefined();
    expect(queryOptions.onElicitation).toBeUndefined();
    const canUseTool = queryOptions.canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");

    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000002",
      (event) => events.push(event),
    );
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "native-tool",
      requestId: "native-request",
    });
    expect(events).toEqual([
      {
        type: "interaction.requested",
        request: {
          type: "question",
          requestId: "claude-question-1",
          questions: [
            {
              question: "Which path?",
              header: "Path",
              options: [
                { label: "Alpha", description: "First" },
                { label: "Beta", description: "Second" },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ]);
    await value.transport.respondToInteraction({
      type: "question",
      requestId: "claude-question-1",
      answers: { "Which path?": "Alpha" },
    });
    await expect(permission).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...questionInput(), answers: { "Which path?": "Alpha" } },
      toolUseID: "native-tool",
      decisionClassification: "user_temporary",
    });
    expect(events.at(-1)).toEqual({
      type: "interaction.closed",
      requestId: "claude-question-1",
      reason: "responded",
    });
    await expect(
      value.transport.respondToInteraction({
        type: "question",
        requestId: "claude-question-1",
        answers: { "Which path?": "Beta" },
      }),
    ).rejects.toThrow("not pending");

    completeTurn(value.fakeQuery);
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    await value.transport.close();
    expect(value.onFault).not.toHaveBeenCalled();
  });

  it("denies out-of-Turn, malformed, and duplicate Question callbacks without leaking IDs", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");

    await expect(
      canUseTool(
        "Read",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "outside-tool",
          requestId: "outside-request",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "outside-tool" });

    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000003",
      (event) => events.push(event),
    );
    await expect(
      canUseTool(
        "AskUserQuestion",
        { questions: [] },
        {
          signal: new AbortController().signal,
          toolUseID: "bad-tool",
          requestId: "bad-request",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "bad-tool" });
    expect(events).toEqual([]);

    const first = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "duplicate-tool",
      requestId: "duplicate-request",
    });
    await expect(
      canUseTool("AskUserQuestion", questionInput(), {
        signal: new AbortController().signal,
        toolUseID: "second-tool",
        requestId: "duplicate-request",
      }),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "second-tool" });
    const requested = events.find(
      (event) => event.type === "interaction.requested" && event.request.type === "question",
    );
    if (requested?.type !== "interaction.requested") {
      throw new Error("Claude Question request was not exposed");
    }
    expect(JSON.stringify(requested)).not.toContain("duplicate-request");
    expect(JSON.stringify(requested)).not.toContain("duplicate-tool");
    await value.transport.respondToInteraction({
      type: "question",
      requestId: requested.request.requestId,
      cancelled: true,
    });
    await expect(first).resolves.toMatchObject({ behavior: "deny", toolUseID: "duplicate-tool" });
    expect(events.at(-1)).toMatchObject({ type: "interaction.closed", reason: "cancelled" });

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("closes a pending callback and Turn when the transport closes", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000005",
      (event) => events.push(event),
    );
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "close-tool",
      requestId: "close-request",
    });

    const turnClosed = expect(turn).rejects.toThrow("transport closed");
    await value.transport.close();
    await expect(permission).resolves.toMatchObject({ behavior: "deny", toolUseID: "close-tool" });
    await turnClosed;
    expect(events.map(({ type }) => type)).toEqual(["interaction.requested", "interaction.closed"]);
    expect(events.at(-1)).toMatchObject({ reason: "cancelled" });
  });

  it("closes a pending callback once when its AbortSignal fires", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000004",
      (event) => events.push(event),
    );
    const controller = new AbortController();
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: controller.signal,
      toolUseID: "abort-tool",
      requestId: "abort-request",
    });
    controller.abort();
    await expect(permission).resolves.toMatchObject({
      behavior: "deny",
      toolUseID: "abort-tool",
    });
    expect(events.map(({ type }) => type)).toEqual(["interaction.requested", "interaction.closed"]);
    expect(events.at(-1)).toMatchObject({ reason: "cancelled" });
    await expect(
      value.transport.respondToInteraction({
        type: "question",
        requestId: "claude-question-1",
        cancelled: true,
      }),
    ).rejects.toThrow("not pending");

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Tool Approval callbacks", () => {
  it("resolves independent Edit and Bash callbacks with exact one-shot SDK results", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000010",
      (event) => events.push(event),
    );
    const editInput = { file_path: "/synthetic/private", new_string: "private-content" };
    const editPermission = canUseTool("Edit", editInput, {
      signal: new AbortController().signal,
      toolUseID: "native-edit-tool",
      requestId: "native-edit-control",
      title: "Claude wants to edit a file",
      displayName: "Edit file",
      description: "One-shot file edit",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Edit" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
    const bashPermission = canUseTool(
      "Bash",
      { command: "synthetic-command" },
      {
        signal: new AbortController().signal,
        toolUseID: "native-bash-tool",
        requestId: "native-bash-control",
        displayName: "Run command",
      },
    );

    const requests = events.flatMap((event) =>
      event.type === "interaction.requested" && event.request.type === "approval"
        ? [event.request]
        : [],
    );
    expect(requests).toEqual([
      {
        type: "approval",
        requestId: "claude-approval-1",
        title: "Claude wants to edit a file",
        description: "One-shot file edit",
        suggestedScope: "session",
      },
      {
        type: "approval",
        requestId: "claude-approval-2",
        title: "Run command",
      },
    ]);
    const exposed = JSON.stringify(requests);
    expect(exposed).not.toContain("native-edit");
    expect(exposed).not.toContain("private-content");
    expect(exposed).not.toContain("updatedPermissions");

    await expect(
      value.transport.respondToInteraction({
        type: "question",
        requestId: "claude-approval-1",
        cancelled: true,
      }),
    ).rejects.toThrow("type does not match");
    await expect(
      canUseTool(
        "Bash",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "duplicate-tool",
          requestId: "native-bash-control",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "duplicate-tool" });

    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-2",
      decision: "deny",
    });
    await expect(bashPermission).resolves.toEqual({
      behavior: "deny",
      message: "User denied the Tool request",
      toolUseID: "native-bash-tool",
      decisionClassification: "user_reject",
    });
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-1",
      decision: "allowOnce",
    });
    const editResult = await editPermission;
    expect(editResult).toEqual({
      behavior: "allow",
      updatedInput: editInput,
      toolUseID: "native-edit-tool",
      decisionClassification: "user_temporary",
    });
    if (!editResult || editResult.behavior !== "allow") throw new Error("Edit was not allowed");
    expect(editResult.updatedInput).toBe(editInput);
    expect(editResult).not.toHaveProperty("updatedPermissions");
    expect(events.filter(({ type }) => type === "interaction.closed")).toHaveLength(2);

    completeTurn(value.fakeQuery);
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    await value.transport.close();
    expect(value.fakeQuery.interrupt).not.toHaveBeenCalled();
  });

  it("returns the exact native suggestions only for their declared scope", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000013",
      (event) => events.push(event),
    );
    const sessionSuggestions = [
      {
        type: "addRules" as const,
        rules: [{ toolName: "Edit" }],
        behavior: "allow" as const,
        destination: "session" as const,
      },
      {
        type: "addDirectories" as const,
        directories: ["/synthetic"],
        destination: "cliArg" as const,
      },
    ];
    const persistentSuggestions = [
      {
        type: "addRules" as const,
        rules: [{ toolName: "Bash", ruleContent: "npm test" }],
        behavior: "allow" as const,
        destination: "projectSettings" as const,
      },
    ];
    const sessionInput = { file_path: "/synthetic/private-session" };
    const persistentInput = { command: "npm test" };
    const sessionPermission = canUseTool("Edit", sessionInput, {
      signal: new AbortController().signal,
      toolUseID: "session-tool",
      requestId: "session-control",
      suggestions: sessionSuggestions,
    });
    const persistentPermission = canUseTool("Bash", persistentInput, {
      signal: new AbortController().signal,
      toolUseID: "persistent-tool",
      requestId: "persistent-control",
      suggestions: persistentSuggestions,
    });
    expect(
      events.flatMap((event) =>
        event.type === "interaction.requested" && event.request.type === "approval"
          ? [event.request]
          : [],
      ),
    ).toEqual([
      expect.objectContaining({ requestId: "claude-approval-1", suggestedScope: "session" }),
      expect.objectContaining({ requestId: "claude-approval-2", suggestedScope: "always" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("projectSettings");
    expect(JSON.stringify(events)).not.toContain("private-session");

    await expect(
      value.transport.respondToInteraction({
        type: "approval",
        requestId: "claude-approval-1",
        decision: "allowAlways",
      }),
    ).rejects.toThrow("scope is not pending");
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-1",
      decision: "allowForSession",
    });
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-2",
      decision: "allowAlways",
    });
    const sessionResult = await sessionPermission;
    const persistentResult = await persistentPermission;
    expect(sessionResult).toEqual({
      behavior: "allow",
      updatedInput: sessionInput,
      toolUseID: "session-tool",
      decisionClassification: "user_permanent",
      updatedPermissions: sessionSuggestions,
    });
    expect(persistentResult).toEqual({
      behavior: "allow",
      updatedInput: persistentInput,
      toolUseID: "persistent-tool",
      decisionClassification: "user_permanent",
      updatedPermissions: persistentSuggestions,
    });
    if (
      !sessionResult ||
      sessionResult.behavior !== "allow" ||
      !persistentResult ||
      persistentResult.behavior !== "allow"
    ) {
      throw new Error("Scoped permission was not allowed");
    }
    expect(sessionResult.updatedPermissions).toBe(sessionSuggestions);
    expect(persistentResult.updatedPermissions).toBe(persistentSuggestions);

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("omits broader scope for empty, malformed, and unknown suggestions", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000014",
      (event) => events.push(event),
    );
    const suggestionCases: Array<{ name: string; suggestions: PermissionUpdate[] }> = [
      { name: "empty", suggestions: [] },
      {
        name: "malformed",
        suggestions: [
          {
            type: "addRules",
            behavior: "allow",
            destination: "session",
          } as unknown as PermissionUpdate,
        ],
      },
      {
        name: "unknown-destination",
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Edit" }],
            behavior: "allow",
            destination: "futureSettings",
          } as unknown as PermissionUpdate,
        ],
      },
    ];
    const permissions = suggestionCases.map(({ name, suggestions }, index) =>
      canUseTool(
        "Edit",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: `${name}-tool`,
          requestId: `${name}-control`,
          suggestions,
        },
      ).then((result) => ({ index, result })),
    );
    const requests = events.flatMap((event) =>
      event.type === "interaction.requested" && event.request.type === "approval"
        ? [event.request]
        : [],
    );
    expect(requests).toHaveLength(suggestionCases.length);
    for (const [index, request] of requests.entries()) {
      expect(request).not.toHaveProperty("suggestedScope");
      await expect(
        value.transport.respondToInteraction({
          type: "approval",
          requestId: request.requestId,
          decision: "allowForSession",
        }),
      ).rejects.toThrow("scope is not pending");
      await value.transport.respondToInteraction({
        type: "approval",
        requestId: request.requestId,
        decision: "allowOnce",
      });
      await expect(permissions[index]).resolves.toMatchObject({
        index,
        result: { behavior: "allow", decisionClassification: "user_temporary" },
      });
      const resolved = await permissions[index];
      expect(resolved?.result).not.toHaveProperty("updatedPermissions");
    }
    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("uses bounded display fallback and denies callbacks with no valid display identity", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000011",
      (event) => events.push(event),
    );

    const fallback = canUseTool(
      "Edit",
      {},
      {
        signal: new AbortController().signal,
        toolUseID: "fallback-tool",
        requestId: "fallback-control",
        title: "x".repeat(121),
        displayName: "Edit file",
        description: "Bounded description",
      },
    );
    expect(events.at(-1)).toMatchObject({
      type: "interaction.requested",
      request: {
        type: "approval",
        title: "Edit file",
        description: "Bounded description",
      },
    });
    await value.transport.respondToInteraction({
      type: "approval",
      requestId: "claude-approval-1",
      decision: "deny",
    });
    await fallback;

    const exposedCount = events.filter(({ type }) => type === "interaction.requested").length;
    await expect(
      canUseTool(
        "x".repeat(121),
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "invalid-display-tool",
          requestId: "invalid-display-control",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "invalid-display-tool" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      canUseTool(
        "Bash",
        {},
        {
          signal: aborted.signal,
          toolUseID: "pre-aborted-tool",
          requestId: "pre-aborted-control",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "pre-aborted-tool" });
    expect(events.filter(({ type }) => type === "interaction.requested")).toHaveLength(
      exposedCount,
    );

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("closes Approval callbacks once on AbortSignal and native terminal cleanup", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000012",
      (event) => events.push(event),
    );
    const controller = new AbortController();
    const abortedPermission = canUseTool(
      "Edit",
      {},
      {
        signal: controller.signal,
        toolUseID: "aborted-tool",
        requestId: "aborted-control",
      },
    );
    const terminalPermission = canUseTool(
      "Bash",
      {},
      {
        signal: new AbortController().signal,
        toolUseID: "terminal-tool",
        requestId: "terminal-control",
      },
    );

    controller.abort();
    await expect(abortedPermission).resolves.toMatchObject({
      behavior: "deny",
      toolUseID: "aborted-tool",
    });
    completeTurn(value.fakeQuery);
    await expect(terminalPermission).resolves.toMatchObject({
      behavior: "deny",
      toolUseID: "terminal-tool",
    });
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events.filter(({ type }) => type === "interaction.closed")).toEqual([
      expect.objectContaining({ requestId: "claude-approval-1", reason: "cancelled" }),
      expect.objectContaining({ requestId: "claude-approval-2", reason: "superseded" }),
    ]);
    await expect(
      value.transport.respondToInteraction({
        type: "approval",
        requestId: "claude-approval-1",
        decision: "allowOnce",
      }),
    ).rejects.toThrow("not pending");
    await value.transport.close();
  });
});
