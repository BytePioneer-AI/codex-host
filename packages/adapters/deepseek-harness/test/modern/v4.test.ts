import { describe, expect, it } from "vitest";

import {
  ModernEventValidator,
  matchesModernForkHistory,
  projectModernHistory,
  resolveModernForkBoundary,
} from "../../src/modern/history.js";
import type { ModernJournalEvent } from "../../src/modern/journal.js";
import { DEEPSEEK_V4_PROFILE, deepSeekModernProfile } from "../../src/profiles/profile.js";

const sessionId = "v4-session";
const event = (seq: number, type: string, data: object, surface = false): ModernJournalEvent => ({
  seq,
  type,
  time: 1_000 + seq,
  data: data as never,
  ...(surface ? { surfaceOp: "append" as const } : {}),
});

function v4History(): ModernJournalEvent[] {
  return [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    event(2, "request/header", {
      reason: "initial",
      header: {
        config: { provider: "deepseek", model: "deepseek-v4" },
        tools: [{ name: "read", description: "Read a file", parameters: {} }],
      },
    }),
    event(
      3,
      "system/message",
      {
        turn: 1,
        step: 1,
        message: {
          id: "system-1",
          role: "system",
          content: [{ type: "text", text: "System" }],
          source: { kind: "system-prompt" },
        },
      },
      true,
    ),
    event(
      4,
      "user/message",
      {
        id: "user-1",
        role: "user",
        source: { kind: "user" },
        content: [
          { type: "text", text: "Read" },
          { type: "image", attachment: {} },
        ],
      },
      true,
    ),
    event(
      5,
      "developer/message",
      {
        turn: 1,
        step: 1,
        headerSeq: 2,
        message: {
          id: "developer-1",
          role: "developer",
          source: { kind: "tool-registry" },
          content: [{ type: "tool-addition", toolName: "read" }],
        },
      },
      true,
    ),
    event(
      6,
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          content: [
            { type: "text", text: "Checking" },
            { type: "tool-call", id: "call-1", name: "read", arguments: "{}" },
          ],
        },
        stream: [],
      },
      true,
    ),
    event(7, "tool/call", { turn: 1, step: 1, callId: "call-1", name: "read", arguments: "{}" }),
    event(
      8,
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: {
          id: "tool-1",
          role: "tool",
          toolCallId: "call-1",
          isError: false,
          source: { kind: "tool", callId: "call-1" },
          content: [{ type: "text", text: "File" }],
        },
      },
      true,
    ),
    event(9, "image/offload", { targets: [{ seq: 4, imageIndexes: [0] }] }),
    event(10, "step/end", { turn: 1, step: 1 }),
    event(11, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    event(12, "workspace/changes", { turn: 1 }),
  ];
}

describe("DSH V4 journal", () => {
  it("binds the single V4 profile to the probed version and parses only V4 headers", () => {
    expect(deepSeekModernProfile("0.1.7-rc.1")).toBe(DEEPSEEK_V4_PROFILE);
    for (const version of ["0.1.7-rc.2", "0.2.0-rc.1", "0.2.0-rc.2", "1.0.0"]) {
      const profile = deepSeekModernProfile(version);
      expect(profile).toEqual({ ...DEEPSEEK_V4_PROFILE, version });
      expect(Object.isFrozen(profile)).toBe(true);
    }
    expect(
      DEEPSEEK_V4_PROFILE.parseHeader(
        { version: 4, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0 },
        { sessionId },
      ).version,
    ).toBe(4);
    expect(
      DEEPSEEK_V4_PROFILE.parseHeader(
        { version: 4, id: sessionId, createdAt: 1, isSeeded: false },
        { sessionId },
      ).delegationDepth,
    ).toBe(0);
    expect(() =>
      DEEPSEEK_V4_PROFILE.parseHeader(
        { version: 4, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: null },
        { sessionId },
      ),
    ).toThrow();
    for (const header of [
      { version: 3, id: sessionId, createdAt: 1, isSeeded: false },
      { version: 0, id: sessionId, createdAt: 1 },
      { version: 4, id: sessionId, createdAt: 1, isSeeded: false, seedLength: 0 },
    ]) {
      expect(() => DEEPSEEK_V4_PROFILE.parseHeader(header, { sessionId })).toThrow();
    }
  });

  it("projects native V4 developer, tool result, image offload and workspace events", () => {
    const projected = projectModernHistory({
      sessionId,
      events: v4History(),
      profile: DEEPSEEK_V4_PROFILE,
    });
    expect(projected.snapshot.turns).toHaveLength(1);
    expect(projected.snapshot.turns[0]?.checkpoint?.checkpointId).toBe("v4-turn-end:11");
    expect(projected.snapshot.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({
            type: "toolExecution",
            output: { content: [{ type: "text", text: "File" }] },
          }),
          outcome: { status: "succeeded" },
        }),
      ]),
    );
    expect(projected.snapshot.turns[0]?.input).toEqual([{ type: "text", text: "Read" }]);
  });

  it.each([
    { content: [{ type: "text", text: "replacement" }] },
    {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
    { content: [] },
  ])(
    "accepts V4 tool result content replacement %j in history and live validation",
    ({ content }) => {
      const prefix = v4History().slice(0, 9);
      const replacement: ModernJournalEvent = {
        ...event(9, "tool/result", {
          turn: 1,
          step: 1,
          message: {
            id: "tool-1",
            role: "tool",
            toolCallId: "call-1",
            isError: false,
            source: { kind: "tool", callId: "call-1" },
            content,
          },
        }),
        surfaceOp: { op: "replace", startSeq: 8, endSeq: 8 },
        sourceEventSeqs: [8],
      };
      const events = [
        ...prefix,
        replacement,
        event(10, "step/end", { turn: 1, step: 1 }),
        event(11, "turn/end", { turn: 1, reason: { kind: "completed" } }),
      ];
      const validator = new ModernEventValidator(100, DEEPSEEK_V4_PROFILE);
      expect(() => events.forEach((item) => validator.accept(item))).not.toThrow();
      expect(() =>
        projectModernHistory({ sessionId, events, profile: DEEPSEEK_V4_PROFILE }),
      ).not.toThrow();
    },
  );

  it.each([
    { id: "different-message" },
    { toolCallId: "different-call" },
    { source: { kind: "tool", callId: "different-call" } },
    { isError: true },
    { extension: "changed" },
  ])("rejects V4 tool result replacement changing metadata %j", (changed) => {
    const replacement: ModernJournalEvent = {
      ...event(9, "tool/result", {
        turn: 1,
        step: 1,
        message: {
          id: "tool-1",
          role: "tool",
          toolCallId: "call-1",
          isError: false,
          source: { kind: "tool", callId: "call-1" },
          content: [{ type: "text", text: "File" }],
          ...changed,
        },
      }),
      surfaceOp: { op: "replace", startSeq: 8, endSeq: 8 },
      sourceEventSeqs: [8],
    };
    expect(() =>
      projectModernHistory({
        sessionId,
        events: [...v4History().slice(0, 9), replacement],
        profile: DEEPSEEK_V4_PROFILE,
      }),
    ).toThrow("tool/result replacement changed more than result content");
  });

  it("keeps native V4 message and block extensions opaque", () => {
    const history = v4History().map((item) => {
      if (item.type === "user/message") {
        const data = item.data as Record<string, unknown>;
        const content = data.content as Record<string, unknown>[];
        return {
          ...item,
          data: {
            ...data,
            extension: { retained: true },
            content: [{ ...content[0], extension: "user-block" }, content[1]],
          } as never,
        };
      }
      if (item.type === "developer/message") {
        const data = item.data as Record<string, unknown>;
        const message = data.message as Record<string, unknown>;
        const content = message.content as Record<string, unknown>[];
        return {
          ...item,
          data: {
            ...data,
            message: {
              ...message,
              extension: { retained: true },
              content: [{ ...content[0], extension: true }],
            },
          },
        };
      }
      if (item.type === "assistant/message") {
        const data = item.data as Record<string, unknown>;
        const message = data.message as Record<string, unknown>;
        const content = message.content as Record<string, unknown>[];
        return {
          ...item,
          data: {
            ...data,
            message: {
              ...message,
              extension: "assistant",
              content: [{ ...content[0], extension: 1 }, content[1]],
            },
          },
        };
      }
      if (item.type === "tool/result") {
        const data = item.data as Record<string, unknown>;
        const message = data.message as Record<string, unknown>;
        const content = message.content as Record<string, unknown>[];
        return {
          ...item,
          data: {
            ...data,
            message: {
              ...message,
              extension: "tool",
              content: [{ ...content[0], extension: null }],
            },
          },
        };
      }
      return item;
    }) as unknown as ModernJournalEvent[];
    expect(
      projectModernHistory({ sessionId, events: history, profile: DEEPSEEK_V4_PROFILE }).snapshot
        .turns,
    ).toHaveLength(1);
  });

  it("rejects invalid V4 references", () => {
    const history = v4History();
    const project = (events: ModernJournalEvent[]) =>
      projectModernHistory({ sessionId, events, profile: DEEPSEEK_V4_PROFILE });
    expect(() =>
      project(
        history.map((item, index) =>
          index === 5
            ? { ...item, data: { ...(item.data as object), headerSeq: 4 } as never }
            : item,
        ),
      ),
    ).toThrow();
    expect(() =>
      project(
        history.map((item, index) =>
          index === 9 ? { ...item, data: { targets: [{ seq: 6, imageIndexes: [0] }] } } : item,
        ),
      ),
    ).toThrow();
    expect(() =>
      project(
        history.map((item, index) =>
          index === 9 ? { ...item, data: { targets: [{ seq: 4, imageIndexes: [0, 0] }] } } : item,
        ),
      ),
    ).toThrow();
    expect(() =>
      project(
        history.map((item) =>
          item.type === "user/message"
            ? { ...item, data: { ...(item.data as object), source: { kind: "plugin" } } as never }
            : item,
        ),
      ),
    ).toThrow();
    expect(() =>
      project([
        ...history.slice(0, 3),
        event(
          3,
          "user/message",
          {
            id: "user-before-system",
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: "before system" }],
          },
          true,
        ),
        event(
          4,
          "system/message",
          {
            turn: 1,
            step: 1,
            message: {
              id: "system-2",
              role: "system",
              source: { kind: "system-prompt" },
              content: [{ type: "text", text: "late system" }],
            },
          },
          true,
        ),
      ]),
    ).toThrow();
    expect(() =>
      project(
        history.map((item) =>
          item.type === "tool/call"
            ? { ...item, data: { ...(item.data as object), name: "wrong" } as never }
            : item,
        ),
      ),
    ).toThrow();
    expect(() =>
      project([...history.slice(0, 8), event(8, "step/end", { turn: 1, step: 1 })]),
    ).toThrow();
    const forkRepair: ModernJournalEvent[] = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      event(
        2,
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "assistant-fork",
            role: "assistant",
            source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
            content: [{ type: "tool-call", id: "fork-call", name: "read", arguments: "{}" }],
          },
          stream: [],
        },
        true,
      ),
      event(
        3,
        "tool/result",
        {
          turn: 1,
          step: 1,
          error: { name: "ToolNotStartedError", code: "TOOL_NOT_STARTED" },
          message: {
            id: "forked-tool-result-fork-call-3",
            role: "tool",
            source: { kind: "tool", callId: "fork-call" },
            toolCallId: "fork-call",
            isError: true,
            content: [
              {
                type: "text",
                text: "The parent session may have executed it after the fork point.",
              },
            ],
          },
        },
        true,
      ),
      event(4, "step/end", { turn: 1, step: 1 }),
      event(5, "turn/end", { turn: 1, reason: { kind: "forked" } }),
    ];
    expect(
      projectModernHistory({ sessionId, events: forkRepair, profile: DEEPSEEK_V4_PROFILE }).snapshot
        .turns,
    ).toHaveLength(1);
    expect(() =>
      DEEPSEEK_V4_PROFILE.parseHistoryRecord(
        {
          type: "event",
          event: {
            ...history[4],
            surfaceOp: { op: "replace", start: 3, end: 3 },
          },
        },
        10,
      ),
    ).toThrow();
  });

  it("uses exact V4 Fork boundaries and rejects cross-format checkpoints", () => {
    const source = v4History();
    const boundary = resolveModernForkBoundary(source, "v4-turn-end:11", DEEPSEEK_V4_PROFILE);
    if (boundary === null) throw new Error("V4 boundary was not resolved");
    expect(boundary.events).toHaveLength(12);
    expect(resolveModernForkBoundary(source, "v3-turn-end:11", DEEPSEEK_V4_PROFILE)).toBeNull();
    expect(resolveModernForkBoundary(source, "turn-end:11", DEEPSEEK_V4_PROFILE)).toBeNull();
    const child = [...boundary.events, event(12, "session/end-seed", { inherited: true })];
    expect(matchesModernForkHistory(boundary.events, child, DEEPSEEK_V4_PROFILE)).toBe(true);
    expect(
      matchesModernForkHistory(
        boundary.events,
        [...child, event(13, "turn/end", { turn: 1, reason: { kind: "forked" } })],
        DEEPSEEK_V4_PROFILE,
      ),
    ).toBe(false);
  });
});

describe("DSH V4 recovery results for unfinished tool calls", () => {
  const surface = (seq: number, type: string, data: object, extra: object = {}) => ({
    ...event(seq, type, data, true),
    ...extra,
  });
  const recoveryResult = (
    seq: number,
    callId: string,
    id: string,
    started: boolean,
    overrides: { error?: object; message?: object; extra?: object } = {},
  ): ModernJournalEvent =>
    surface(
      seq,
      "tool/result",
      {
        turn: 1,
        step: 1,
        error:
          overrides.error ??
          (started
            ? { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" }
            : { name: "ToolNotStartedError", code: "TOOL_NOT_STARTED" }),
        message: {
          id,
          role: "tool",
          toolCallId: callId,
          isError: true,
          source: { kind: "tool", callId },
          content: [{ type: "text", text: "The tool call was interrupted." }],
          ...overrides.message,
        },
      },
      overrides.extra,
    );
  /** A failed live step: `call-1` started, `call-2` never did; DSH closes both. */
  const failedStep = (
    notStarted: ModernJournalEvent,
    secondTool = "write",
  ): ModernJournalEvent[] => [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    surface(2, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "assistant-2",
        role: "assistant",
        source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
        content: [
          { type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"a.ts"}' },
          { type: "tool-call", id: "call-2", name: secondTool, arguments: '{"path":"b.ts"}' },
        ],
      },
      stream: [],
    }),
    event(3, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "read",
      arguments: '{"path":"a.ts"}',
    }),
    recoveryResult(4, "call-1", "interrupted-tool-result-call-1-4", true, {
      extra: { sourceEventSeqs: [3] },
    }),
    notStarted,
    event(6, "step/end", { turn: 1, step: 1 }),
    event(7, "turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }),
  ];
  const project = (events: ModernJournalEvent[]) =>
    projectModernHistory({ sessionId, events, profile: DEEPSEEK_V4_PROFILE }).snapshot;

  it.each([
    ["an interrupted id carrying its own seq", "interrupted-tool-result-call-2-5"],
    ["an interrupted id carrying another integer", "interrupted-tool-result-call-2-17"],
    ["a fork id carrying its own seq", "forked-tool-result-call-2-5"],
  ])("projects both calls as failed Tools for %s", (_label, id) => {
    const snapshot = project(failedStep(recoveryResult(5, "call-2", id, false)));
    expect(snapshot.turns[0]?.items).toEqual([
      {
        item: {
          type: "toolExecution",
          itemId: `dsh-modern:${sessionId}:event:3:tool`,
          toolName: "read",
          arguments: { path: "a.ts" },
          output: { content: [{ type: "text", text: "The tool call was interrupted." }] },
        },
        outcome: expect.objectContaining({ status: "failed" }),
      },
      {
        item: {
          type: "toolExecution",
          itemId: `dsh-modern:${sessionId}:event:5:tool`,
          toolName: "write",
          arguments: { path: "b.ts" },
          output: { content: [{ type: "text", text: "The tool call was interrupted." }] },
        },
        outcome: expect.objectContaining({ status: "failed" }),
      },
    ]);
  });

  it("shows no Item for a PTC run_code program that never started", () => {
    const snapshot = project(
      failedStep(
        recoveryResult(5, "call-2", "interrupted-tool-result-call-2-5", false),
        "run_code",
      ),
    );
    expect(
      snapshot.turns[0]?.items.map(({ item }) => item.type === "toolExecution" && item.toolName),
    ).toEqual(["read"]);
  });

  it.each([
    ["a fork id with another seq", "forked-tool-result-call-2-4", {}],
    ["a non-integer suffix", "interrupted-tool-result-call-2-x", {}],
    ["a leading-zero suffix", "interrupted-tool-result-call-2-05", {}],
    ["another callId", "interrupted-tool-result-call-9-5", {}],
    ["an unknown cause", "cancelled-tool-result-call-2-5", {}],
    [
      "the started-call error",
      "interrupted-tool-result-call-2-5",
      { error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" } },
    ],
    ["a source event", "interrupted-tool-result-call-2-5", { extra: { sourceEventSeqs: [2] } }],
    [
      "two content blocks",
      "interrupted-tool-result-call-2-5",
      {
        message: {
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
      },
    ],
  ])("rejects a not-started result with %s", (_label, id, overrides) => {
    expect(() => project(failedStep(recoveryResult(5, "call-2", id, false, overrides)))).toThrow(
      "unmatched tool/result",
    );
  });

  it("rejects a not-started result that is not marked as an error", () => {
    const result = recoveryResult(5, "call-2", "interrupted-tool-result-call-2-5", false, {
      message: { isError: false },
    });
    expect(() => project(failedStep(result))).toThrow("error marker is malformed");
  });
});
