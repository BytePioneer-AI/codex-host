import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";

import {
  contentText,
  deepSeekUsageKey,
  mergeDeepSeekUsage,
  parseArguments,
  parseDeepSeekContextWindow,
  parseDeepSeekOutputTokensPerSecond,
  parseDeepSeekUsage,
  projectToolResult,
  projectTurnReason,
  structuredDiffs,
} from "../src/projection.js";

describe("DeepSeek native result projection", () => {
  it("preserves unparseable arguments without inventing executable input", () => {
    expect(parseArguments('{"path":"文件.txt","lines":[1,null]}')).toEqual({
      path: "文件.txt",
      lines: [1, null],
    });
    expect(parseArguments("false")).toBe(false);
    expect(parseArguments("unfinished {")).toBe("unfinished {");
    expect(parseArguments("1e999")).toBe("1e999");
    expect(parseArguments(null)).toEqual({});
  });

  it("extracts only valid visible text, preserving order and whitespace", () => {
    for (const input of [null, [], {}, { content: "not blocks" }]) {
      expect(contentText(input)).toBe("");
    }
    expect(
      contentText({
        content: [
          null,
          [],
          { type: "text", text: 1 },
          { type: "reasoning", text: "private" },
          { type: "text", text: " a" },
          { type: "text", text: "\nb " },
        ],
      }),
    ).toBe(" a\nb ");
  });

  it("correlates tool output by call identity and truncates without hiding failure", () => {
    const result = {
      source: { kind: "tool", callId: "read-1" },
      content: [
        null,
        { type: "text", text: "ignore" },
        { type: "tool-result", toolCallId: "other", content: [{ type: "text", text: "wrong" }] },
        { type: "tool-result", toolCallId: "read-1", content: "invalid" },
        { type: "tool-result", toolCallId: "read-1", content: [{ type: "text", text: "abc" }] },
        {
          type: "tool-result",
          toolCallId: "read-1",
          isError: true,
          content: [
            null,
            { type: "image", attachment: {} },
            { type: "text", text: 1 },
            { type: "text", text: "def" },
          ],
        },
      ],
    };
    expect(projectToolResult(result, 6)).toEqual({
      callId: "read-1",
      failed: true,
      output: { content: [{ type: "text", text: "abcdef" }] },
    });
    expect(projectToolResult(result, 3)).toEqual({
      callId: "read-1",
      failed: true,
      output: { content: [{ type: "text", text: "abc" }], truncated: true },
    });
    expect(
      projectToolResult(
        {
          source: result.source,
          content: [{ type: "tool-result", toolCallId: "read-1", content: [] }],
        },
        10,
      ),
    ).toEqual({ callId: "read-1", failed: false });
  });

  it.each([
    null,
    [],
    {},
    { source: null },
    { source: { kind: "user" } },
    { source: { kind: "tool", callId: " " }, content: [] },
    { source: { kind: "tool", callId: 1 }, content: [] },
    { source: { kind: "tool", callId: "one" }, content: "bad" },
    { source: { kind: "tool", callId: "one" }, content: [] },
  ])("rejects uncorrelated or malformed tool result %#", (value) => {
    expect(projectToolResult(value, 20)).toBeNull();
  });

  it("produces applicable add/update/delete patches including missing final newline", () => {
    const originals = [null, "before\n", "remove me"];
    const replacements = ["created", "after\n", null];
    const changes = structuredDiffs({
      diffs: originals.map((oldText, index) => ({
        path: `目录/file-${index}.txt`,
        oldText,
        newText: replacements[index],
      })),
    });
    expect(changes?.map(({ kind }) => kind)).toEqual(["add", "update", "delete"]);
    changes?.forEach(({ unifiedDiff }, index) => {
      expect(applyPatch(originals[index] ?? "", unifiedDiff)).toBe(replacements[index] ?? "");
    });
    expect(changes?.[0]?.unifiedDiff).toContain("--- /dev/null");
    expect(changes?.[2]?.unifiedDiff).toContain("+++ /dev/null");
  });

  it.each([
    null,
    {},
    { diffs: [] },
    { diffs: "bad" },
    { diffs: [null] },
    ...[null, " ", "nul\0name", "fake\n+++ b/injected", "fake\rname"].map((path) => ({
      diffs: [{ path, oldText: "old", newText: "new" }],
    })),
    { diffs: [{ path: "a", oldText: 1, newText: "new" }] },
    { diffs: [{ path: "a", oldText: "old", newText: {} }] },
  ])("rejects a malformed diff batch instead of publishing partial changes %#", (meta) => {
    expect(structuredDiffs(meta)).toBeNull();
  });
});

describe("DeepSeek usage and outcomes", () => {
  it("counts cache reads and writes in context without inventing unknown metrics", () => {
    expect(
      parseDeepSeekUsage(
        {
          inputTokens: 40,
          cacheReadTokens: 40,
          cacheWriteTokens: 20,
          outputTokens: 8,
          reasoningTokens: 3,
        },
        1000,
      ),
    ).toEqual({
      inputTokens: 40,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 20,
      outputTokens: 8,
      reasoningOutputTokens: 3,
      cacheHitRatePercent: 40,
      contextUsedTokens: 100,
      contextWindowTokens: 1000,
    });
    expect(parseDeepSeekUsage({ inputTokens: 0, outputTokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(parseDeepSeekUsage({ cacheReadTokens: 10 })).toEqual({ cachedInputTokens: 10 });
    for (const input of [null, [], {}, { inputTokens: -1, outputTokens: 1.5 }]) {
      expect(parseDeepSeekUsage(input)).toBeNull();
    }
    expect(
      parseDeepSeekUsage({ inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1 }, 1000),
    ).toBeNull();
  });

  it.each([undefined, "1000", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "ignores an invalid context capacity %s",
    (value) => {
      expect(parseDeepSeekContextWindow(value)).toBeUndefined();
    },
  );

  it("selects trustworthy decode rates and avoids division by zero", () => {
    expect(parseDeepSeekContextWindow(128_000)).toBe(128_000);
    expect(
      parseDeepSeekOutputTokensPerSecond({
        outputTokensPerSecond: 0,
        tokensPerSecond: 4,
        decodeTokens: 10,
        decodeMs: 100,
      }),
    ).toBe(0);
    expect(parseDeepSeekOutputTokensPerSecond({ tokensPerSecond: 2.5 })).toBe(2.5);
    expect(parseDeepSeekOutputTokensPerSecond({ decodeTokensPerSecond: 7 })).toBe(7);
    expect(
      parseDeepSeekOutputTokensPerSecond({
        outputTokensPerSecond: Infinity,
        decodeTokens: 10,
        decodeMs: 400,
      }),
    ).toBe(25);
    for (const value of [
      null,
      {},
      { decodeTokens: 5 },
      { decodeTokens: -1, decodeMs: 20 },
      { decodeTokens: 3, decodeMs: 0 },
      { decodeTokens: 3, decodeMs: -1 },
    ]) {
      expect(parseDeepSeekOutputTokensPerSecond(value)).toBeUndefined();
    }
    expect(deepSeekUsageKey({ turn: 2, step: 4 }, "event:1")).toBe("turn:2:step:4");
    expect(deepSeekUsageKey({ turn: "2", step: 4 }, "event:1")).toBe("event:1");
    expect(deepSeekUsageKey({ turn: 2, step: 1.5 }, "event:1")).toBe("event:1");
  });

  it("adds usage counters while carrying the latest complete context and rate", () => {
    const initial = {
      inputTokens: 10,
      cachedInputTokens: 3,
      contextUsedTokens: 13,
      contextWindowTokens: 100,
      cacheHitRatePercent: 30,
      outputTokensPerSecond: 12,
    };
    expect(mergeDeepSeekUsage(null, initial)).toEqual(initial);
    expect(mergeDeepSeekUsage(initial, { outputTokens: 5 })).toEqual({
      ...initial,
      outputTokens: 5,
    });
    expect(
      mergeDeepSeekUsage(initial, {
        inputTokens: 7,
        cachedInputTokens: 2,
        contextUsedTokens: 9,
        contextWindowTokens: 200,
        cacheHitRatePercent: 20,
        outputTokensPerSecond: 0,
      }),
    ).toEqual({
      inputTokens: 17,
      cachedInputTokens: 5,
      contextUsedTokens: 9,
      contextWindowTokens: 200,
      cacheHitRatePercent: 20,
      outputTokensPerSecond: 0,
    });
    expect(mergeDeepSeekUsage(null, { outputTokens: 0 })).toEqual({ outputTokens: 0 });
    expect(mergeDeepSeekUsage({ inputTokens: 1 }, { outputTokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  it.each(["completed", "max-tokens"])("preserves successful outcome %s", (kind) => {
    expect(projectTurnReason({ kind })).toEqual({
      outcome: { status: "succeeded" },
      history: { status: "succeeded" },
    });
  });

  it("distinguishes cancellation, native failure and malformed protocol outcomes", () => {
    expect(projectTurnReason({ kind: "aborted" }).outcome).toEqual({
      status: "cancelled",
      reason: "Cancelled by user",
    });
    for (const reason of [null, [], {}, { kind: 1 }]) {
      expect(projectTurnReason(reason).outcome).toMatchObject({
        status: "failed",
        error: { code: "protocolError", retryable: false },
      });
    }
    expect(
      projectTurnReason({ kind: "error", error: { message: "provider failed" } }).history,
    ).toMatchObject({
      status: "failed",
      error: { code: "nativeFailure", message: "provider failed" },
    });
    for (const reason of [
      { kind: "interrupted" },
      { kind: "error", error: null },
      { kind: "error", error: { message: 1 } },
    ]) {
      expect(projectTurnReason(reason).outcome).toMatchObject({
        status: "failed",
        error: { code: "nativeFailure", retryable: false },
      });
    }
  });
});
