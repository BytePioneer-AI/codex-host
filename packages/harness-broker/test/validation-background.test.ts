import { describe, expect, it } from "vitest";

import { harnessOutputSchema } from "../src/validation.js";

describe("background output validation", () => {
  const item = { type: "agentMessage", itemId: "item-1", text: "hello" };
  const output = (turnId: unknown, value: unknown) => ({
    kind: "event",
    event: { type: "item.background.started", turnId, item: value },
  });

  it("accepts text Items and rejects malformed or extra fields", () => {
    expect(harnessOutputSchema.safeParse(output("turn-1", item)).success).toBe(true);
    expect(
      harnessOutputSchema.safeParse(output("turn-1", { ...item, type: "reasoning" })).success,
    ).toBe(true);
    for (const invalid of [
      output("", item),
      output("turn-1", { ...item, type: "commandExecution" }),
      output("turn-1", { ...item, itemId: "" }),
      output("turn-1", { ...item, text: 1 }),
      output("turn-1", { ...item, extra: true }),
    ]) {
      expect(harnessOutputSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("completed autonomous Turn validation", () => {
  const nativeTurnRef = {
    harnessId: "antigravity",
    nativeSessionId: "session-1",
    nativeTurnKey: "wake-2",
    formatVersion: 1,
  };
  const entry = {
    item: { type: "agentMessage", itemId: "wake-answer", text: "Timer expired" },
    outcome: { status: "succeeded" },
  };
  const snapshot = {
    nativeTurnRef,
    checkpoint: {
      harnessId: nativeTurnRef.harnessId,
      nativeSessionId: nativeTurnRef.nativeSessionId,
      checkpointId: "wake-2",
      formatVersion: 1,
    },
    input: [],
    items: [entry],
    outcome: { status: "unknown", reason: "No native stop reason" },
    startedAtMs: 10,
    completedAtMs: 20,
  };
  const accepts = (fields: Record<string, unknown>) =>
    harnessOutputSchema.safeParse({
      kind: "event",
      event: { type: "turn.autonomous.completed", ...fields },
    }).success;

  it("accepts a terminal snapshot without a Host Turn ID or user message", () => {
    expect(accepts({ snapshot })).toBe(true);
    expect(
      accepts({
        snapshot: {
          ...snapshot,
          input: [{ type: "text", text: "Native input" }],
          outcome: { status: "cancelled" },
          items: [
            {
              item: {
                type: "toolExecution",
                itemId: "tool-1",
                toolName: "timer",
                arguments: { seconds: 5 },
                output: { content: [{ type: "text", text: "OK" }] },
              },
              outcome: { status: "succeeded" },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed identities, input, items, outcomes, timing and extra fields", () => {
    for (const fields of [
      {},
      { snapshot: null },
      { snapshot, turnId: "unexpected" },
      { snapshot: { ...snapshot, extra: true } },
      { snapshot: { ...snapshot, nativeTurnRef: { ...nativeTurnRef, nativeTurnKey: "" } } },
      {
        snapshot: { ...snapshot, checkpoint: { ...snapshot.checkpoint, nativeSessionId: "other" } },
      },
      { snapshot: { ...snapshot, input: [{ type: "text", text: 123 }] } },
      { snapshot: { ...snapshot, items: [entry, entry] } },
      { snapshot: { ...snapshot, items: [{ ...entry, item: { ...entry.item, extra: true } }] } },
      { snapshot: { ...snapshot, items: [{ ...entry, outcome: { status: "unknown" } }] } },
      { snapshot: { ...snapshot, outcome: { status: "failed" } } },
      { snapshot: { ...snapshot, completedAtMs: 0 } },
    ]) {
      expect(accepts(fields), JSON.stringify(fields)).toBe(false);
    }
  });
});

it("validates request timing independently of billable usage", () => {
  const event = { type: "usage.request.timing", turnId: "turn-1" };
  const requestId = "step:1";
  const latency = { requestStartedAtMs: 100, timeToFirstOutputMs: 0 };
  const output = { startedAtMs: 100, completedAtMs: 110, outputTokens: 5 };
  const accepts = (fields: Record<string, unknown>) =>
    harnessOutputSchema.safeParse({ kind: "event", event: { ...event, ...fields } }).success;

  for (const timing of [
    { requestId, ...latency },
    { requestId, output },
    { requestId, ...latency, output },
  ]) {
    expect(accepts({ timing })).toBe(true);
  }
  for (const fields of [
    {},
    { timing: null },
    { turnId: "", timing: { requestId, ...latency } },
    { timing: { requestId: "", ...latency } },
    { timing: { requestId } },
    { timing: { requestId, requestStartedAtMs: 100, output } },
    { timing: { requestId, timeToFirstOutputMs: 0, output } },
    { timing: { requestId, ...latency, timeToFirstOutputMs: -1 } },
    { timing: { requestId, ...latency, timeToFirstOutputMs: Number.MAX_SAFE_INTEGER + 1 } },
    { timing: { requestId, ...latency, extra: true } },
    { timing: { requestId, output: { ...output, completedAtMs: 100 } } },
    { timing: { requestId, output: { ...output, outputTokens: 1.5 } } },
    { timing: { requestId, output: { ...output, extra: true } } },
  ]) {
    expect(accepts(fields), JSON.stringify(fields)).toBe(false);
  }
});
