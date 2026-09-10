import { describe, expect, it } from "vitest";

import { DEEPSEEK_V012_PROFILE, DEEPSEEK_V015_PROFILE } from "../../src/profiles/profile.js";
import {
  expandV015AssistantStream,
  parseV015AssistantBaseline,
  parseV015AssistantFrame,
} from "../../src/profiles/v015.js";

describe.each([DEEPSEEK_V012_PROFILE, DEEPSEEK_V015_PROFILE])(
  "$version content and chunk boundary",
  (profile) => {
    it.each(
      [
        {},
        [null],
        [{}],
        [{ type: "text", text: 1 }],
        [{ type: "reasoning", text: null }],
        [{ type: "image", attachment: null }],
        [{ type: "tool-call", id: "call", name: "read", arguments: {} }],
        [{ type: "tool-call", id: "", name: "read", arguments: "{}" }],
        [{ type: "unknown" }],
      ].map((value) => [value]),
    )("rejects malformed message content %j", (value) => {
      expect(() => profile.validateContent(value)).toThrow();
    });

    it("preserves image, tool-call and reasoning content", () => {
      expect(() =>
        profile.validateContent([
          {
            type: "image",
            attachment: {
              attachmentId: "image",
              mediaType: "image/png",
              width: 1,
              height: 1,
              bytes: 1,
            },
          },
          { type: "tool-call", id: "call", name: "read", arguments: "{}" },
          { type: "reasoning", text: "reason" },
        ]),
      ).not.toThrow();
    });

    it.each(
      [
        null,
        {},
        { type: "unknown" },
        { type: "block-start", index: 0, blockType: "" },
        { type: "block-start", index: -1, blockType: "text" },
        { type: "text-delta", index: 0, text: 1 },
        { type: "text-delta", index: 1.5, text: "x" },
        { type: "reasoning-delta", index: 0, text: null },
        { type: "tool-call-delta", index: 0, id: "call", argumentsDelta: {} },
        { type: "tool-call-delta", index: 0, id: "call", argumentsDelta: "{", name: 1 },
        { type: "block-end", index: 0, block: null },
        { type: "finish", reason: null },
        { type: "finish", reason: { kind: "unknown" } },
        { type: "finish", reason: { kind: "error", failure: null } },
        { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: 1 } } },
        {
          type: "finish",
          reason: { kind: "error", failure: { code: "AUTH", message: "denied", status: -1 } },
        },
        {
          type: "finish",
          reason: {
            kind: "error",
            failure: { code: "RETRY", message: "failed", providerRetryAfterMs: 1.5 },
          },
        },
        {
          type: "finish",
          reason: { kind: "error", failure: { code: "AUTH", message: "denied", requestId: "" } },
        },
      ].map((value) => [value]),
    )("rejects malformed stream chunk %j", (value) => {
      expect(() => profile.validateChunk(value)).toThrow(
        expect.objectContaining({ code: "protocolError" }),
      );
    });

    it("accepts native chunk lifecycle and provider failure diagnostics", () => {
      for (const chunk of [
        { type: "block-start", index: 0, blockType: "text" },
        { type: "text-delta", index: 0, text: "hello" },
        { type: "reasoning-delta", index: 1, text: "reason" },
        { type: "tool-call-delta", index: 2, id: "call", name: "read", argumentsDelta: "{}" },
        { type: "block-end", index: 0, block: { type: "text", text: "hello" } },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
        { type: "finish", reason: { kind: "stop" } },
        {
          type: "finish",
          reason: {
            kind: "aborted",
            failure: {
              code: "AUTH",
              message: "denied",
              status: 401,
              providerRetryAfterMs: 20,
              requestId: "request",
            },
          },
          replayState: { safe: true },
        },
      ])
        expect(() => profile.validateChunk(chunk)).not.toThrow();
    });
  },
);

describe("V3 header and assistant stream admission", () => {
  const header = { version: 3, id: "session", createdAt: 1, isSeeded: false };
  it("admits supported optional header fields and rejects wrong types", () => {
    const optional = {
      cwd: "C:/repo",
      parentSession: "parent",
      origin: "subagent",
      delegationDepth: 1,
      agentPreset: "coding",
    };
    expect(
      DEEPSEEK_V015_PROFILE.parseHeader(
        { ...header, ...optional },
        { sessionId: "session", cwd: optional.cwd },
      ),
    ).toMatchObject(optional);
    for (const fields of [
      { origin: "unknown" },
      { delegationDepth: -1 },
      { parentSession: 1 },
      { agentPreset: 1 },
      { cwd: "unexpected" },
      { isSeeded: 1 },
      { createdAt: -1 },
      { unsupported: true },
    ])
      expect(() =>
        DEEPSEEK_V015_PROFILE.parseHeader({ ...header, ...fields }, { sessionId: "session" }),
      ).toThrow();
  });

  it.each(
    [
      null,
      {},
      { type: "unknown", attemptId: "a", revision: 1 },
      { type: "start", attemptId: "a", revision: 1, startedAfterSeq: -2, turn: 1, step: 1 },
      { type: "start", attemptId: "a", revision: 1, startedAfterSeq: -1, turn: 0, step: 1 },
      {
        type: "start",
        attemptId: "a",
        revision: 1,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
        extra: true,
      },
      { type: "chunk", attemptId: "a", revision: 2, index: 0, time: 1, chunk: null },
      { type: "end", attemptId: "a", revision: 2, index: 0, outcome: null },
      {
        type: "end",
        attemptId: "a",
        revision: 2,
        index: 0,
        outcome: { kind: "abandoned", extra: true },
      },
      {
        type: "end",
        attemptId: "a",
        revision: 2,
        index: 0,
        outcome: { kind: "committed", eventType: "user/message", seq: 1 },
      },
      {
        type: "end",
        attemptId: "a",
        revision: 2,
        index: 0,
        outcome: { kind: "committed", eventType: "assistant/message", seq: -1 },
      },
    ].map((value) => [value]),
  )("rejects malformed live frame %j", (value) => {
    expect(() => parseV015AssistantFrame(value)).toThrow();
  });

  it.each([
    { kind: "abandoned" },
    { kind: "committed", eventType: "assistant/message", seq: 1 },
    { kind: "committed", eventType: "assistant/attempt", seq: 1 },
  ])("admits exact terminal outcome %j", (outcome) => {
    expect(
      parseV015AssistantFrame({ type: "end", attemptId: "a", revision: 2, index: 0, outcome }),
    ).toMatchObject({ outcome });
  });

  it("expands reasoning and unnamed tool fragments while retaining timing", () => {
    expect(
      expandV015AssistantStream([
        { type: "reasoning-chunks", time0: 10, index: 0, dt: [-1], texts: ["a", "b"] },
        { type: "tool-call-chunks", time0: 11, index: 1, dt: [], id: "call", args: ["{}"] },
      ]),
    ).toEqual([
      { time: 10, chunk: { type: "reasoning-delta", index: 0, text: "a" } },
      { time: 9, chunk: { type: "reasoning-delta", index: 0, text: "b" } },
      { time: 11, chunk: { type: "tool-call-delta", index: 1, id: "call", argumentsDelta: "{}" } },
    ]);
  });

  it.each(
    [
      null,
      [null],
      [{}],
      [{ type: "unknown" }],
      [{ type: "chunk", time: 1, chunk: null }],
      [{ type: "text-chunks", time0: 1, index: 0, dt: [], texts: [1] }],
      [{ type: "text-chunks", time0: 1, index: 0, dt: ["1"], texts: ["a", "b"] }],
      [
        {
          type: "text-chunks",
          time0: Number.MAX_SAFE_INTEGER,
          index: 0,
          dt: [1],
          texts: ["a", "b"],
        },
      ],
      [{ type: "text-chunks", time0: 1, index: 0, dt: [], texts: ["a"], extra: true }],
    ].map((value) => [value]),
  )("rejects malformed compact record %j", (value) => {
    expect(() => expandV015AssistantStream(value)).toThrow();
  });

  it("rejects incomplete or miscounted reconnect baselines", () => {
    for (const value of [
      null,
      {},
      { revision: -1 },
      { revision: 1, activeAttempt: {} },
      {
        revision: 1,
        activeAttempt: {
          attemptId: "a",
          startedAfterSeq: -1,
          turn: 1,
          step: 1,
          nextIndex: 1,
          stream: [],
        },
      },
      {
        revision: 1,
        activeAttempt: {
          attemptId: "a",
          startedAfterSeq: -1,
          turn: 1,
          step: 1,
          nextIndex: 0,
          stream: null,
        },
      },
    ])
      expect(() => parseV015AssistantBaseline(value)).toThrow();
  });
});
