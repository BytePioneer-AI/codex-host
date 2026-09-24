import { describe, expect, it } from "vitest";

import {
  ModernEventValidator,
  matchesModernForkHistory,
  projectModernHistory,
  resolveModernForkBoundary,
} from "../../src/modern/history.js";
import type { ModernJournalEvent } from "../../src/modern/journal.js";
import {
  DEEPSEEK_V015_PROFILE,
  DEEPSEEK_V017_PROFILE,
  deepSeekModernProfile,
  hasDeepSeekModernStream,
  isDeepSeekV015,
} from "../../src/profiles/profile.js";

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

describe("DSH 0.1.7-rc.1 V4 journal", () => {
  it("selects V4 only for the pinned tag and keeps V3 isolated", () => {
    expect(deepSeekModernProfile("0.1.7-rc.1")).toBe(DEEPSEEK_V017_PROFILE);
    expect(deepSeekModernProfile("0.1.5-rc.3").sessionFormatVersion).toBe(3);
    expect(deepSeekModernProfile("0.1.7-rc.2").sessionFormatVersion).toBe(3);
    expect(isDeepSeekV015(DEEPSEEK_V017_PROFILE)).toBe(false);
    expect(hasDeepSeekModernStream(DEEPSEEK_V017_PROFILE)).toBe(true);
    expect(
      DEEPSEEK_V017_PROFILE.parseHeader(
        { version: 4, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0 },
        { sessionId },
      ).version,
    ).toBe(4);
    expect(
      DEEPSEEK_V017_PROFILE.parseHeader(
        { version: 4, id: sessionId, createdAt: 1, isSeeded: false },
        { sessionId },
      ).delegationDepth,
    ).toBe(0);
    expect(() =>
      DEEPSEEK_V017_PROFILE.parseHeader(
        { version: 4, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: null },
        { sessionId },
      ),
    ).toThrow();
    expect(() =>
      DEEPSEEK_V017_PROFILE.parseHeader(
        { version: 3, id: sessionId, createdAt: 1, isSeeded: false },
        { sessionId },
      ),
    ).toThrow();
    expect(() =>
      DEEPSEEK_V015_PROFILE.parseHeader(
        { version: 4, id: sessionId, createdAt: 1, isSeeded: false },
        { sessionId },
      ),
    ).toThrow();
  });

  it("projects native V4 developer, tool result, image offload and workspace events", () => {
    const projected = projectModernHistory({
      sessionId,
      events: v4History(),
      profile: DEEPSEEK_V017_PROFILE,
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
      const validator = new ModernEventValidator(100, DEEPSEEK_V017_PROFILE);
      expect(() => events.forEach((item) => validator.accept(item))).not.toThrow();
      expect(() =>
        projectModernHistory({ sessionId, events, profile: DEEPSEEK_V017_PROFILE }),
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
        profile: DEEPSEEK_V017_PROFILE,
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
      projectModernHistory({ sessionId, events: history, profile: DEEPSEEK_V017_PROFILE }).snapshot
        .turns,
    ).toHaveLength(1);
  });

  it("rejects invalid V4 references and V4 records in the V3 profile", () => {
    const history = v4History();
    const project = (events: ModernJournalEvent[]) =>
      projectModernHistory({ sessionId, events, profile: DEEPSEEK_V017_PROFILE });
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
      projectModernHistory({ sessionId, events: history, profile: DEEPSEEK_V015_PROFILE }),
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
      projectModernHistory({ sessionId, events: forkRepair, profile: DEEPSEEK_V017_PROFILE })
        .snapshot.turns,
    ).toHaveLength(1);
    expect(() =>
      DEEPSEEK_V017_PROFILE.parseHistoryRecord(
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
    const boundary = resolveModernForkBoundary(source, "v4-turn-end:11", DEEPSEEK_V017_PROFILE);
    if (boundary === null) throw new Error("V4 boundary was not resolved");
    expect(boundary.events).toHaveLength(12);
    expect(resolveModernForkBoundary(source, "v3-turn-end:11", DEEPSEEK_V017_PROFILE)).toBeNull();
    const child = [...boundary.events, event(12, "session/end-seed", { inherited: true })];
    expect(matchesModernForkHistory(boundary.events, child, DEEPSEEK_V017_PROFILE)).toBe(true);
    expect(
      matchesModernForkHistory(
        boundary.events,
        [...child, event(13, "turn/end", { turn: 1, reason: { kind: "forked" } })],
        DEEPSEEK_V017_PROFILE,
      ),
    ).toBe(false);
  });
});
