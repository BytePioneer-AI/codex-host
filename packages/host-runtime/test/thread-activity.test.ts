import { describe, expect, it, vi } from "vitest";

import { ThreadActivity } from "../src/thread-activity.js";

describe("ThreadActivity", () => {
  it("counts any native event or interaction with a Thread identity, excluding polling replies", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    const unsubscribe = activity.subscribe(listener);
    activity.observeOfficial({ id: 1, result: { thread: { id: "thread" } } });
    activity.observeOfficial({ method: "account/updated", params: {} });
    expect(listener).not.toHaveBeenCalled();
    for (const method of [
      "turn/started",
      "item/reasoning/textDelta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "item/commandExecution/requestApproval",
      "future/event",
    ]) {
      activity.observeOfficial({ method, params: { threadId: "thread" } });
    }
    expect(listener).toHaveBeenCalledTimes(6);
    expect(listener).toHaveBeenLastCalledWith(["thread"]);
    unsubscribe();
    activity.note("thread");
    expect(listener).toHaveBeenCalledTimes(6);
  });

  it("uses native subagent ancestry across nested children", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    activity.subscribe(listener);
    activity.observeOfficial({
      method: "thread/started",
      params: {
        thread: {
          id: "child",
          source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } },
        },
      },
    });
    activity.observeOfficial({
      method: "item/completed",
      params: {
        threadId: "child",
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          receiverThreadIds: ["grandchild"],
        },
      },
    });
    activity.observeOfficial({
      method: "item/agentMessage/delta",
      params: { threadId: "grandchild", delta: "progress" },
    });
    expect(listener).toHaveBeenLastCalledWith(["grandchild", "child", "parent"]);
  });

  function nativeChain(activity: ThreadActivity): void {
    for (const [id, parent] of [
      ["B", "A"],
      ["C", "B"],
    ] as const) {
      activity.observeOfficial({
        method: "thread/started",
        params: {
          thread: { id, source: { subAgent: { thread_spawn: { parent_thread_id: parent } } } },
        },
      });
    }
  }

  function closeNative(activity: ThreadActivity, threadId: string): void {
    activity.observeOfficial({ method: "thread/closed", params: { threadId } });
  }

  it("keeps the whole chain through a closed intermediate Thread until its subtree closes", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    activity.subscribe(listener);
    nativeChain(activity);
    closeNative(activity, "B");
    activity.observeOfficial({
      method: "item/agentMessage/delta",
      params: { threadId: "C", delta: "progress" },
    });
    expect(listener).toHaveBeenLastCalledWith(["C", "B", "A"]);
    expect(activity.size).toBe(2);

    closeNative(activity, "C");
    expect(activity.size).toBe(0);
    activity.note("C");
    expect(listener).toHaveBeenLastCalledWith(["C"]);
    activity.note("B");
    expect(listener).toHaveBeenLastCalledWith(["B"]);
  });

  it("keeps the chain when parents close before their running child", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    activity.subscribe(listener);
    nativeChain(activity);
    closeNative(activity, "A");
    closeNative(activity, "B");
    activity.note("C");
    expect(listener).toHaveBeenLastCalledWith(["C", "B", "A"]);

    closeNative(activity, "C");
    expect(activity.size).toBe(0);
    activity.note("C");
    expect(listener).toHaveBeenLastCalledWith(["C"]);
  });

  it("releases a closed parent once its only child moves to another parent", () => {
    const activity = new ThreadActivity();
    nativeChain(activity);
    closeNative(activity, "B");
    activity.note("C", "D");
    expect(activity.size).toBe(1);
  });

  it("forgets a released Thread with its children's links, and all ancestry when cleared", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    activity.subscribe(listener);
    activity.note("external", "root");
    activity.note("subagent", "external");
    activity.forget("external");
    activity.note("subagent");
    expect(listener).toHaveBeenLastCalledWith(["subagent"]);
    activity.note("external");
    expect(listener).toHaveBeenLastCalledWith(["external"]);

    activity.note("subagent", "external");
    activity.note("other", "root");
    activity.clear();
    expect(activity.size).toBe(0);
    activity.note("subagent");
    expect(listener).toHaveBeenLastCalledWith(["subagent"]);
    activity.note("other");
    expect(listener).toHaveBeenLastCalledWith(["other"]);
  });

  it("does not turn sendInput recipients into children or loop on malformed ancestry", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    activity.subscribe(listener);
    activity.observeOfficial({
      method: "item/started",
      params: {
        threadId: "parent",
        item: { type: "collabAgentToolCall", tool: "sendInput", receiverThreadIds: ["other"] },
      },
    });
    activity.note("other");
    expect(listener).toHaveBeenLastCalledWith(["other"]);
    activity.note("a", "b");
    activity.note("b", "a");
    expect(listener).toHaveBeenLastCalledWith(["b", "a"]);
  });
});
