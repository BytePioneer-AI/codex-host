import { describe, expect, it } from "vitest";

import {
  matchesModernForkHistory,
  ModernEventValidator,
  ModernHistoryError,
  resolveModernForkBoundary,
  projectModernHistory,
} from "../../src/modern/history.js";
import type { ModernJournalEvent } from "../../src/modern/journal.js";

const SESSION_ID = "modern-session";

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  surface = false,
): ModernJournalEvent {
  return {
    type,
    seq,
    time: 1_000 + seq,
    data: data as never,
    ...(surface ? { surfaceOp: "append" as const } : {}),
  };
}

function userMessage(
  seq: number,
  texts: readonly string[],
  rpcId = "request-1",
): ModernJournalEvent {
  return event(
    seq,
    "user/message",
    {
      id: `user-${seq}`,
      role: "user",
      content: texts.map((text) => ({ type: "text", text })),
      source: { kind: "user", rpcId },
    },
    true,
  );
}

function assistantMessage(
  seq: number,
  turn: number,
  step: number,
  text: string,
  reasoning: string,
  usage: unknown = {
    inputTokens: 5,
    outputTokens: 3,
    cacheReadTokens: 2,
    reasoningTokens: 1,
  },
): ModernJournalEvent {
  return event(
    seq,
    "assistant/message",
    {
      turn,
      step,
      message: {
        id: `assistant-${seq}`,
        role: "assistant",
        content: [
          { type: "reasoning", text: reasoning },
          { type: "text", text },
          { type: "tool-call", id: "call-1", name: "write", arguments: '{"path":"a.txt"}' },
        ],
        source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
      },
      usage,
    },
    true,
  );
}

function toolResult(seq: number): ModernJournalEvent {
  return event(
    seq,
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: {
        id: `tool-result-${seq}`,
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "written" }],
          },
        ],
        source: { kind: "tool", callId: "call-1" },
      },
      meta: { diffs: [{ path: "a.txt", oldText: null, newText: "hello\n" }] },
    },
    true,
  );
}

function completeHistory(): ModernJournalEvent[] {
  return [
    event(0, "model/selection", {
      provider: "deepseek",
      model: "deepseek-v4",
      reasoningEffort: "high",
    }),
    event(1, "turn/start", { turn: 1 }),
    event(2, "step/start", { turn: 1, step: 1 }),
    userMessage(3, ["first", "second"]),
    event(4, "request/header", {
      header: {
        config: { provider: "deepseek", model: "deepseek-v4", reasoningEffort: "high" },
      },
      reason: "initial",
    }),
    event(5, "request/context", {
      provider: "deepseek",
      model: "deepseek-v4",
      contextWindow: 128_000,
    }),
    event(6, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "reasoning-delta", index: 0, text: "think" },
    }),
    event(7, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 1, text: "done" },
    }),
    event(8, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
    }),
    assistantMessage(9, 1, 1, "done", "think"),
    event(10, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "write",
      arguments: '{"path":"a.txt"}',
    }),
    toolResult(11),
    event(12, "step/end", { turn: 1, step: 1 }),
    event(13, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
}

describe("DeepSeek Harness Modern history projection", () => {
  it("resolves and verifies the exact fork prefix including its between-Turn tail", () => {
    const source = [
      event(0, "turn/start", { turn: 1 }),
      userMessage(1, ["first"]),
      event(2, "turn/end", { turn: 1, reason: { kind: "completed" } }),
      event(3, "model/selection", { provider: "deepseek", model: "deepseek-v4" }),
      event(4, "permission/preset", { preset: "workspace-write" }),
      event(5, "turn/start", { turn: 2 }),
    ];
    const boundary = resolveModernForkBoundary(source, "turn-end:2");

    expect(boundary).toEqual({ atSeq: 2, events: source.slice(0, 5) });
    if (!boundary) return;
    const marker = event(5, "session/end-seed", {});
    const child = [
      ...boundary.events,
      marker,
      event(6, "sandbox/mode", { mode: "workspace-write" }),
    ];
    expect(matchesModernForkHistory(boundary.events, child)).toBe(true);
    expect(
      matchesModernForkHistory(boundary.events, [
        ...boundary.events.slice(0, 1),
        userMessage(1, ["changed"]),
        ...child.slice(2),
      ]),
    ).toBe(false);
    expect(matchesModernForkHistory(boundary.events, boundary.events)).toBe(false);
    expect(
      matchesModernForkHistory(boundary.events, [
        ...boundary.events,
        marker,
        event(6, "turn/start", { turn: 2 }),
      ]),
    ).toBe(false);
    expect(resolveModernForkBoundary(source, "turn-end:3")).toBeNull();
    expect(resolveModernForkBoundary(source, "turn-end:02")).toBeNull();

    const alreadyMarked = [...source.slice(0, 3), event(3, "session/end-seed", {})];
    const nested = resolveModernForkBoundary(alreadyMarked, "turn-end:2");
    expect(nested?.events).toEqual(alreadyMarked);
    expect(matchesModernForkHistory(alreadyMarked, alreadyMarked)).toBe(true);
    expect(
      matchesModernForkHistory(alreadyMarked, [...alreadyMarked, event(4, "session/end-seed", {})]),
    ).toBe(false);
  });

  it("projects complete text, reasoning, Tool, Diff, Model, Thinking and Usage history", () => {
    const projection = projectModernHistory({
      sessionId: SESSION_ID,
      events: completeHistory(),
      toolOutputLimit: 64_000,
    });

    expect(projection.snapshot.turns).toHaveLength(1);
    const turn = projection.snapshot.turns[0];
    expect(turn).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "turn:1" },
      checkpoint: { checkpointId: "turn-end:13" },
      input: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      outcome: { status: "succeeded" },
    });
    expect(turn?.items.map(({ item }) => item.type)).toEqual([
      "reasoning",
      "agentMessage",
      "toolExecution",
      "fileChange",
    ]);
    expect(turn?.items[0]).toMatchObject({ item: { text: "think" } });
    expect(turn?.items[1]).toMatchObject({ item: { text: "done" } });
    expect(turn?.items[2]).toMatchObject({
      item: { toolName: "write", output: { content: [{ type: "text", text: "written" }] } },
      outcome: { status: "succeeded" },
    });
    expect(turn?.items[3]).toMatchObject({
      item: { changes: [{ path: "a.txt", kind: "add" }] },
    });
    expect(projection.snapshot.state).toMatchObject({
      nativeRef: { nativeSessionId: SESSION_ID },
      effectiveThinkingOptionId: "high",
    });
    expect(projection.contextWindowTokens).toBe(128_000);
    expect(projection.usage).toMatchObject({
      inputTokens: 5,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      contextUsedTokens: 7,
      contextWindowTokens: 128_000,
    });
    expect(projection.incompleteTurn).toBeUndefined();
    expect(projection.lastSeq).toBe(13);
  });

  it("keeps surface replacement copies out of the human transcript and Usage", () => {
    const replacementUser = {
      ...userMessage(3, ["model-only replacement"]),
      surfaceOp: { op: "replace" as const, start: 2, end: 2 },
      sourceEventSeqs: [2],
    };
    const replacementAssistant = {
      ...assistantMessage(5, 1, 1, "model-only answer", "model-only thought", {
        inputTokens: 500,
        outputTokens: 300,
      }),
      surfaceOp: { op: "replace" as const, start: 4, end: 4 },
      sourceEventSeqs: [4],
    };
    const projection = projectModernHistory({
      sessionId: SESSION_ID,
      events: [
        event(0, "turn/start", { turn: 1 }),
        event(1, "step/start", { turn: 1, step: 1 }),
        userMessage(2, ["visible prompt"]),
        replacementUser,
        assistantMessage(4, 1, 1, "visible answer", "visible thought"),
        replacementAssistant,
        event(6, "step/end", { turn: 1, step: 1 }),
        event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
      ],
    });

    expect(projection.snapshot.turns[0]).toMatchObject({
      input: [{ type: "text", text: "visible prompt" }],
      items: [
        { item: { type: "reasoning", text: "visible thought" } },
        { item: { type: "agentMessage", text: "visible answer" } },
      ],
    });
    expect(projection.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
  });

  it.each([
    [
      "a range outside the current surface",
      [
        event(0, "turn/start", { turn: 1 }),
        event(1, "step/start", { turn: 1, step: 1 }),
        userMessage(2, ["visible"]),
        {
          ...assistantMessage(3, 1, 1, "replacement", ""),
          surfaceOp: { op: "replace" as const, start: 1, end: 1 },
          sourceEventSeqs: [1],
        },
      ],
    ],
    [
      "a reversed current range",
      [
        event(0, "turn/start", { turn: 1 }),
        event(1, "step/start", { turn: 1, step: 1 }),
        userMessage(2, ["visible"]),
        assistantMessage(3, 1, 1, "answer", ""),
        {
          ...assistantMessage(4, 1, 1, "replacement", ""),
          surfaceOp: { op: "replace" as const, start: 3, end: 2 },
          sourceEventSeqs: [2, 3],
        },
      ],
    ],
    [
      "missing shadowed provenance",
      [
        event(0, "turn/start", { turn: 1 }),
        event(1, "step/start", { turn: 1, step: 1 }),
        userMessage(2, ["visible"]),
        {
          ...assistantMessage(3, 1, 1, "replacement", ""),
          surfaceOp: { op: "replace" as const, start: 2, end: 2 },
          sourceEventSeqs: [],
        },
      ],
    ],
    [
      "an empty non-assistant source list",
      [
        event(0, "turn/start", { turn: 1 }),
        event(1, "step/start", { turn: 1, step: 1 }),
        { ...userMessage(2, ["visible"]), sourceEventSeqs: [] },
      ],
    ],
  ])("rejects a surface event with %s", (_label, events) => {
    expect(() => projectModernHistory({ sessionId: SESSION_ID, events })).toThrowError(
      ModernHistoryError,
    );
  });

  it("allows tool/result replacement to change only one current result's content", () => {
    const original = toolResult(3);
    const originalData = original.data as Record<string, unknown>;
    const originalMessage = originalData.message as Record<string, unknown>;
    const originalBlock = (originalMessage.content as Record<string, unknown>[])[0];
    const replacement = {
      ...original,
      seq: 4,
      time: 1_004,
      data: {
        ...originalData,
        message: {
          ...originalMessage,
          content: [
            {
              ...originalBlock,
              content: [{ type: "text", text: "pruned" }],
            },
          ],
        },
      } as never,
      surfaceOp: { op: "replace" as const, start: 3, end: 3 },
      sourceEventSeqs: [3],
    };
    const prefix = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      event(2, "tool/call", {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "write",
        arguments: "{}",
      }),
      original,
    ];

    expect(() =>
      projectModernHistory({ sessionId: SESSION_ID, events: [...prefix, replacement] }),
    ).not.toThrow();
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [
          ...prefix,
          {
            ...toolResult(4),
            surfaceOp: { op: "replace", start: 3, end: 3 },
            sourceEventSeqs: [3],
          },
        ],
      }),
    ).toThrowError(ModernHistoryError);
  });

  it("keeps an incomplete Turn out of completed history and returns its exact event suffix", () => {
    const events = completeHistory().slice(0, 10);
    const projection = projectModernHistory({ sessionId: SESSION_ID, events });

    expect(projection.snapshot.turns).toEqual([]);
    expect(projection.incompleteTurn?.turn).toBe(1);
    expect(projection.incompleteTurn?.events).toEqual(events.slice(1));
    expect(projection.incompleteTurn?.events.map(({ seq }) => seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("skips only unknown ignorable events and refuses unknown required events", () => {
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [{ ...event(0, "plugin/future", { any: true }), ignorable: true }],
      }),
    ).not.toThrow();
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [
          {
            ...event(0, "plugin/future", { any: true }),
            ignorable: true,
            surfaceOp: "append",
          },
        ],
      }),
    ).toThrowError(ModernHistoryError);
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [event(0, "plugin/future", { any: true })],
      }),
    ).toThrowError(ModernHistoryError);
  });

  it.each([
    ["known profile", event(0, "plan/mode", { active: "yes" })],
    ["agent inbox", event(0, "agent/inbox/spliced", { target: "later", start: 0, inserted: [] })],
    ["approval", event(0, "approval/decided", { id: "approval-1", outcome: "yes" })],
    [
      "command",
      event(0, "command/run", {
        commandId: "command-1",
        name: "goal",
        source: { kind: "automation" },
      }),
    ],
    [
      "hook",
      event(0, "hook/invoked", {
        turn: 1,
        point: "PreToolUse",
        dialect: "other",
        handlerId: "hook-1",
      }),
    ],
    [
      "LLM retry",
      event(0, "llm/retry", {
        retryId: "retry-1",
        turn: 1,
        step: 1,
        provider: "deepseek",
        mode: "sometimes",
        policyKey: "default",
        retry: 1,
        delayMs: 1,
        failure: { message: "failed", code: "FAIL" },
      }),
    ],
    [
      "session title",
      event(0, "session/title", {
        title: "Title",
        messageSeqs: [0],
        source: { kind: "unknown" },
      }),
    ],
    ["todo", event(0, "todo/write", { todos: [{ content: "x", status: "working" }] })],
    [
      "workflow",
      event(0, "tool-workflow/agent-end", {
        runId: "run-1",
        seq: 1,
        outcome: "unknown",
      }),
    ],
    [
      "code dispatch",
      event(0, "tool/code-dispatch", {
        rootCallId: "root",
        parentCallId: "parent",
        subCallId: "sub",
        name: "read",
        arguments: {},
        isError: "no",
        content: [],
      }),
    ],
    ["core boundary", event(0, "turn/start", { turn: 2 })],
    [
      "surface metadata",
      event(0, "user/message", {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "x" }],
        source: { kind: "user" },
      }),
    ],
  ])("refuses malformed %s events", (_label, malformed) => {
    expect(() => projectModernHistory({ sessionId: SESSION_ID, events: [malformed] })).toThrowError(
      ModernHistoryError,
    );
  });

  it("accepts canonical delegated sandbox and approval sources", () => {
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [
          event(0, "sandbox/mode", {
            mode: "workspace-write",
            source: "delegation",
          }),
          event(1, "approval/policy", { policy: "never", source: "delegation" }),
        ],
      }),
    ).not.toThrow();
  });

  it("validates paired command lifecycle and earlier non-command source references", () => {
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [
          event(0, "plan/mode", { active: true }),
          event(1, "command/run", {
            commandId: "command-1",
            name: "plan",
            args: " on",
            source: { kind: "user" },
          }),
          event(2, "command/done", {
            commandId: "command-1",
            kind: "success",
            sourceEventSeq: 0,
          }),
          event(3, "command/run", {
            commandId: "command-incomplete",
            name: "compact",
            source: { kind: "user" },
          }),
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "duplicate run",
      [
        event(0, "command/run", {
          commandId: "command-1",
          name: "plan",
          source: { kind: "user" },
        }),
        event(1, "command/run", {
          commandId: "command-1",
          name: "plan",
          source: { kind: "user" },
        }),
      ],
    ],
    ["orphan done", [event(0, "command/done", { commandId: "command-1", kind: "success" })]],
    [
      "duplicate done",
      [
        event(0, "command/run", {
          commandId: "command-1",
          name: "plan",
          source: { kind: "user" },
        }),
        event(1, "command/done", { commandId: "command-1", kind: "success" }),
        event(2, "command/done", { commandId: "command-1", kind: "success" }),
      ],
    ],
    [
      "command source",
      [
        event(0, "command/run", {
          commandId: "command-1",
          name: "plan",
          source: { kind: "user" },
        }),
        event(1, "command/done", {
          commandId: "command-1",
          kind: "success",
          sourceEventSeq: 0,
        }),
      ],
    ],
    [
      "non-prior source",
      [
        event(0, "command/run", {
          commandId: "command-1",
          name: "plan",
          source: { kind: "user" },
        }),
        event(1, "command/done", {
          commandId: "command-1",
          kind: "success",
          sourceEventSeq: 1,
        }),
      ],
    ],
    [
      "error source",
      [
        event(0, "plan/mode", { active: false }),
        event(1, "command/run", {
          commandId: "command-1",
          name: "plan",
          source: { kind: "user" },
        }),
        event(2, "command/done", {
          commandId: "command-1",
          kind: "error",
          text: "failed",
          sourceEventSeq: 0,
        }),
      ],
    ],
    [
      "empty error",
      [
        event(0, "command/run", {
          commandId: "command-1",
          name: "plan",
          source: { kind: "user" },
        }),
        event(1, "command/done", {
          commandId: "command-1",
          kind: "error",
          text: "   ",
        }),
      ],
    ],
    [
      "extra source field",
      [
        event(0, "command/run", {
          commandId: "command-1",
          name: "plan",
          source: { kind: "user", extra: true },
        }),
      ],
    ],
  ] as const)("rejects invalid command lifecycle: %s", (_label, events) => {
    expect(() => projectModernHistory({ sessionId: SESSION_ID, events })).toThrowError(
      ModernHistoryError,
    );
  });

  it("accepts empty workflow agent labels and phases but rejects non-strings", () => {
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [
          event(0, "tool-workflow/agent-start", {
            runId: "run-1",
            seq: 1,
            label: "",
            phase: "",
            childId: "child-1",
          }),
        ],
      }),
    ).not.toThrow();
    for (const malformed of [
      { runId: "run-1", seq: 1, label: 1, childId: "child-1" },
      { runId: "run-1", seq: 1, label: "", phase: 1, childId: "child-1" },
    ]) {
      expect(() =>
        projectModernHistory({
          sessionId: SESSION_ID,
          events: [event(0, "tool-workflow/agent-start", malformed)],
        }),
      ).toThrowError(ModernHistoryError);
    }
  });

  it("rejects gaps, overlapping boundaries and bounded-work overflow", () => {
    const validator = new ModernEventValidator();
    expect(() => validator.accept(event(1, "session/end-seed", {}))).toThrowError(
      ModernHistoryError,
    );

    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [event(0, "turn/start", { turn: 1 }), event(1, "turn/start", { turn: 2 })],
      }),
    ).toThrowError(ModernHistoryError);

    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [event(0, "session/end-seed", {}), event(1, "session/end-seed", {})],
        maxEvents: 1,
      }),
    ).toThrowError(ModernHistoryError);
  });

  it("redacts credential-shaped native Turn failures", () => {
    const secret = "TURN_SECRET_CANARY";
    const events = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "turn/end", {
        turn: 1,
        reason: {
          kind: "error",
          error: { message: `api_key=${secret}`, code: "FAILED" },
        },
      }),
    ];
    const projection = projectModernHistory({ sessionId: SESSION_ID, events });
    expect(JSON.stringify(projection.snapshot)).not.toContain(secret);
    expect(projection.snapshot.turns[0]?.outcome).toMatchObject({ status: "failed" });
  });

  it("ignores malformed Usage telemetry without changing valid Usage or Turn outcome", () => {
    const events = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, ["hello"]),
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
      }),
      event(4, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "usage", usage: { inputTokens: "broken", outputTokens: 99 } },
      }),
      assistantMessage(5, 1, 1, "done", "think", {
        inputTokens: 10,
        outputTokens: "broken",
      }),
      event(6, "step/end", { turn: 1, step: 1 }),
      event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];

    const projection = projectModernHistory({ sessionId: SESSION_ID, events });
    expect(projection.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(projection.snapshot.turns[0]?.outcome).toEqual({ status: "succeeded" });
  });
});
