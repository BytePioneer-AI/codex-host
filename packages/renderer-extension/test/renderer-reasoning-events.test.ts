import {
  hostThreadIdSchema,
  hostTurnIdSchema,
  type HostThreadId,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  RendererReasoningPendingBuffer,
  RendererReasoningStore,
  decodeRendererReasoningNotification,
  rendererReasoningPanelView,
} from "../src/renderer-reasoning-events.js";

const thread1 = hostThreadIdSchema.parse("thread-1");
const thread2 = hostThreadIdSchema.parse("thread-2");
const turn1 = hostTurnIdSchema.parse("turn-1");
const turn2 = hostTurnIdSchema.parse("turn-2");

describe("Renderer reasoning notification projection", () => {
  it("accepts only explicit reasoning summary notifications", () => {
    const delta = decodeRendererReasoningNotification({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta: "Inspecting the request",
      },
    });
    expect(delta).toEqual({
      kind: "delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      text: "Inspecting the request",
    });
    if (!delta) throw new Error("Expected a valid reasoning delta");
    expectTypeOf(delta.threadId).toEqualTypeOf<HostThreadId>();
    expectTypeOf(delta.turnId).toEqualTypeOf<HostTurnId>();

    expect(
      decodeRendererReasoningNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "reasoning-1",
            type: "reasoning",
            summary: ["Inspecting the request", "Checking the result"],
            content: ["private raw chain"],
            encrypted_content: "secret",
          },
        },
      }),
    ).toEqual({
      kind: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      text: "Inspecting the request\n\nChecking the result",
    });

    expect(
      decodeRendererReasoningNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "message-1", type: "agent_message", text: "answer" },
        },
      }),
    ).toBeNull();
    expect(
      decodeRendererReasoningNotification({
        method: "item/reasoning/contentTextDelta",
        params: { threadId: "thread-1", itemId: "reasoning-1", delta: "private" },
      }),
    ).toBeNull();
  });

  it("keeps thread state isolated, expands live output, and collapses completed output", () => {
    const store = new RendererReasoningStore();

    store.apply({
      kind: "started",
      threadId: thread1,
      turnId: turn1,
      itemId: "reasoning-1",
      text: "",
    });
    store.apply({
      kind: "delta",
      threadId: thread1,
      turnId: turn1,
      itemId: "reasoning-1",
      text: "First step",
    });
    store.apply({
      kind: "delta",
      threadId: thread2,
      turnId: turn2,
      itemId: "reasoning-2",
      text: "Other thread",
    });

    expect(rendererReasoningPanelView(store.snapshot(thread1))).toEqual({
      visible: true,
      expanded: true,
      phase: "live",
      text: "First step",
    });
    expect(store.snapshot(thread2)?.text).toBe("Other thread");

    store.apply({
      kind: "completed",
      threadId: thread1,
      turnId: turn1,
      itemId: "reasoning-1",
      text: "First step\n\nFinal check",
    });
    expect(rendererReasoningPanelView(store.snapshot(thread1))).toEqual({
      visible: true,
      expanded: false,
      phase: "completed",
      text: "First step\n\nFinal check",
    });
  });

  it("treats an explicit empty completed summary as authoritative", () => {
    const store = new RendererReasoningStore();
    const delta = decodeRendererReasoningNotification({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta: "Streaming summary",
      },
    });
    const completed = decodeRendererReasoningNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reasoning-1", type: "reasoning", summary: [] },
      },
    });

    if (!delta || !completed) throw new Error("Expected valid reasoning notifications");
    store.apply(delta);
    expect(store.apply(completed)).toMatchObject({
      phase: "completed",
      text: "",
    });
  });

  it("does not render an empty reasoning item", () => {
    const store = new RendererReasoningStore();
    store.apply({
      kind: "started",
      threadId: thread1,
      turnId: turn1,
      itemId: "reasoning-1",
      text: "",
    });

    expect(rendererReasoningPanelView(store.snapshot(thread1))).toEqual({
      visible: false,
      expanded: true,
      phase: "live",
      text: "",
    });
  });

  it("coalesces ownership-pending deltas without growing an event list", () => {
    const pending = new RendererReasoningPendingBuffer(32);

    expect(
      pending.append({
        kind: "started",
        threadId: thread1,
        turnId: turn1,
        itemId: "reasoning-1",
        text: "",
      }),
    ).toBe(true);
    expect(
      pending.append({
        kind: "delta",
        threadId: thread1,
        turnId: turn1,
        itemId: "reasoning-1",
        text: "First ",
      }),
    ).toBe(true);
    expect(
      pending.append({
        kind: "delta",
        threadId: thread1,
        turnId: turn1,
        itemId: "reasoning-1",
        text: "step",
      }),
    ).toBe(true);

    expect(pending.drain()).toEqual([
      {
        kind: "started",
        threadId: thread1,
        turnId: turn1,
        itemId: "reasoning-1",
        text: "",
      },
      {
        kind: "delta",
        threadId: thread1,
        turnId: turn1,
        itemId: "reasoning-1",
        text: "First step",
      },
    ]);
  });

  it("fails a pending queue closed before it can retain an oversized summary", () => {
    const pending = new RendererReasoningPendingBuffer(8);
    const event = {
      kind: "delta" as const,
      threadId: thread1,
      turnId: turn1,
      itemId: "reasoning-1",
      text: "12345678",
    };

    expect(pending.append(event)).toBe(true);
    expect(pending.append({ ...event, text: "9" })).toBe(false);
    expect(pending.drain()).toEqual([event]);
    expect(pending.drain()).toEqual([]);
  });
});
