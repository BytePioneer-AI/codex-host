import { describe, expect, it, vi } from "vitest";

import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { OfficialWorkTracker } from "../src/codex-runtime/official-work-tracker.js";

function fixture() {
  const gate = new OfficialWorkGate();
  gate.initialized();
  const inspect = vi.fn();
  const tracker = new OfficialWorkTracker(gate, inspect);
  return { gate, tracker, inspect };
}

describe("official work beyond RPC completion", () => {
  it("keeps process handles client-scoped but accepts a broadcast terminal from another client", () => {
    const { gate, tracker } = fixture();
    tracker.admitted("a", "process/spawn", { processHandle: "same" })({ result: {} });
    tracker.admitted("a", "process/spawn", { processHandle: "same" })({ error: { code: -1 } });
    tracker.notification("b", { method: "process/exited", params: { processHandle: "same" } });
    expect(gate.busy).toBe(false);
  });

  it("keeps shell acknowledgements busy and deduplicates shared terminal notifications", () => {
    const { gate, tracker } = fixture();
    const a = tracker.admitted("a", "thread/shellCommand", { threadId: "thread", command: "same" });
    const b = tracker.admitted("b", "thread/shellCommand", { threadId: "thread", command: "same" });
    a({ result: {} });
    b({ result: {} });
    const completed = (id: string) => ({
      method: "item/completed",
      params: { threadId: "thread", item: { id, type: "commandExecution", source: "userShell" } },
    });
    tracker.notification("a", completed("one"));
    tracker.notification("b", completed("one"));
    expect(gate.busy).toBe(true);
    tracker.notification("b", completed("two"));
    tracker.notification("a", completed("two"));
    expect(gate.busy).toBe(false);
  });

  it("does not let duplicate shell rejection or uncorrelated completion release future work", () => {
    const { gate, tracker } = fixture();
    const rejected = tracker.admitted("a", "thread/shellCommand", { threadId: "thread" });
    rejected({ error: {} });
    rejected({ error: {} });
    expect(gate.busy).toBe(false);
    tracker.notification("a", {
      method: "item/completed",
      params: {
        threadId: "thread",
        item: { id: "unknown", type: "commandExecution", source: "userShell" },
      },
    });
    const next = tracker.admitted("a", "thread/shellCommand", { threadId: "thread" });
    expect(gate.busy).toBe(true);
    next({ error: {} });
    expect(gate.busy).toBe(true);
  });

  it("keeps a queue-started Turn busy after the queue becomes empty", () => {
    const { gate, tracker } = fixture();
    tracker.admitted("a", "thread/queue/start", { threadId: "thread" })({
      result: { turn: { id: "queued-turn", status: "inProgress" } },
    });
    tracker.admitted("a", "thread/queue/list", { threadId: "thread", cursor: null })({
      result: { data: [], nextCursor: null },
    });
    expect(gate.busy).toBe(true);
    tracker.notification("a", {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "queued-turn", status: "completed" } },
    });
    expect(gate.busy).toBe(false);
  });

  it("cannot infer idle from a malformed successful start acknowledgement", () => {
    const { gate, tracker } = fixture();
    tracker.admitted("a", "turn/start", { threadId: "thread" })({ result: {} });
    expect(gate.busy).toBe(true);
  });

  it("does not resurrect a completed Turn from its late start response", () => {
    const { gate, tracker } = fixture();
    const response = tracker.admitted("a", "turn/start", { threadId: "thread" });
    tracker.notification("a", {
      method: "turn/started",
      params: { threadId: "thread", turn: { id: "turn" } },
    });
    expect(gate.busy).toBe(true);
    tracker.notification("a", {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
    });
    response({ result: { turn: { id: "turn", status: "inProgress" } } });
    expect(gate.busy).toBe(false);
  });

  it("does not equate realtime error with transport closure", () => {
    const { gate, tracker } = fixture();
    tracker.admitted("a", "thread/realtime/start", { threadId: "thread" })({ result: {} });
    tracker.notification("a", { method: "thread/realtime/error", params: { threadId: "thread" } });
    expect(gate.busy).toBe(true);
    tracker.notification("a", { method: "thread/realtime/closed", params: { threadId: "thread" } });
    expect(gate.busy).toBe(false);
  });

  it("ignores an old empty queue result and an empty non-first page", () => {
    const { gate, tracker, inspect } = fixture();
    const old = tracker.admitted("a", "thread/queue/list", { threadId: "thread", cursor: null });
    tracker.notification("a", { method: "thread/queue/changed", params: { threadId: "thread" } });
    expect(inspect).toHaveBeenCalledWith("a", "thread");
    old({ result: { data: [], nextCursor: null } });
    expect(gate.busy).toBe(true);
    tracker.admitted("a", "thread/queue/list", { threadId: "thread", cursor: "last-page" })({
      result: { data: [], nextCursor: null },
    });
    expect(gate.busy).toBe(true);
    tracker.admitted("a", "thread/queue/list", { threadId: "thread", cursor: null })({
      result: { data: [], nextCursor: null },
    });
    expect(gate.busy).toBe(false);
  });

  it("ignores goal results superseded by native updates", () => {
    const { gate, tracker } = fixture();
    const old = tracker.admitted("a", "thread/goal/get", { threadId: "thread" });
    tracker.notification("a", {
      method: "thread/goal/updated",
      params: { threadId: "thread", goal: { status: "usageLimited" } },
    });
    old({ result: { goal: null } });
    expect(gate.busy).toBe(true);
    const set = tracker.admitted("a", "thread/goal/set", { threadId: "thread" });
    tracker.notification("a", { method: "thread/goal/cleared", params: { threadId: "thread" } });
    set({ result: { goal: { status: "active" } } });
    expect(gate.busy).toBe(false);
  });

  it("does not release compaction merely because another Turn completed", () => {
    const { gate, tracker } = fixture();
    tracker.admitted("a", "thread/compact/start", { threadId: "thread" })({ result: {} });
    tracker.notification("a", {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "other", status: "completed" } },
    });
    expect(gate.busy).toBe(true);
    tracker.notification("a", { method: "thread/compacted", params: { threadId: "thread" } });
    expect(gate.busy).toBe(false);
  });
});
