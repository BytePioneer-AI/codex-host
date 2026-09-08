import { describe, expect, it, vi } from "vitest";

import {
  createSubagentActivityHistoryResolver,
  createSubagentThreadModelResolver,
  createSubagentThreadStatusResolver,
  readSubagentActivitiesFromTarget,
  readSubagentThreadModelFromTarget,
  subagentActivitiesFromReadResult,
  subagentStatusFromReadResult,
  subagentThreadModelFromReadResult,
} from "../src/renderer-subagent-thread-model.js";

describe("Subagent Thread Model", () => {
  it("reads completed, failed, interrupted, and running child statuses", () => {
    const result = (status: string, threadStatus = "notLoaded") => ({
      thread: {
        id: "child-1",
        status: { type: threadStatus },
        turns: [{ status }],
      },
    });
    expect(subagentStatusFromReadResult(result("completed"), "child-1")).toBe("completed");
    expect(subagentStatusFromReadResult(result("failed"), "child-1")).toBe("failed");
    expect(subagentStatusFromReadResult(result("interrupted"), "child-1")).toBe("interrupted");
    expect(subagentStatusFromReadResult(result("inProgress"), "child-1")).toBe("running");
    expect(subagentStatusFromReadResult(result("inProgress", "systemError"), "child-1")).toBe(
      "failed",
    );
    expect(subagentStatusFromReadResult(result("failed"), "child-2")).toBeNull();
  });

  it("loads saved Subagent activities from the exact parent Thread", async () => {
    const started = {
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child-1",
    };
    const sendRequest = vi.fn().mockResolvedValue({
      thread: {
        id: "parent-1",
        turns: [{ items: [started, { type: "agentMessage" }] }],
      },
    });

    await expect(readSubagentActivitiesFromTarget({ sendRequest }, "parent-1")).resolves.toEqual([
      started,
    ]);
    expect(sendRequest).toHaveBeenCalledWith("thread/read", {
      threadId: "parent-1",
      includeTurns: true,
    });
    expect(
      subagentActivitiesFromReadResult(
        { thread: { id: "another-parent", turns: [{ items: [started] }] } },
        "parent-1",
      ),
    ).toBeNull();
  });

  it("reads the exact child Thread Model and reasoning effort", () => {
    expect(
      subagentThreadModelFromReadResult(
        {
          thread: {
            id: "child-1",
            model: "xai/grok-4.6",
            reasoningEffort: "high",
          },
        },
        "child-1",
      ),
    ).toEqual({ model: "xai/grok-4.6", reasoningEffort: "high" });
  });

  it("rejects a response for a different child Thread", () => {
    expect(
      subagentThreadModelFromReadResult(
        {
          thread: {
            id: "child-2",
            model: "gpt-5.6-sol",
            reasoningEffort: "ultra",
          },
        },
        "child-1",
      ),
    ).toBeNull();
    expect(
      subagentThreadModelFromReadResult(
        {
          thread: {
            model: "gpt-5.6-sol",
            reasoningEffort: "ultra",
          },
        },
        "child-1",
      ),
    ).toBeNull();
  });

  it("requests only the exact child Thread without loading turns", async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      thread: {
        id: "child-1",
        model: "xai/grok-4.6",
        reasoningEffort: "high",
      },
    });

    await expect(readSubagentThreadModelFromTarget({ sendRequest }, "child-1")).resolves.toEqual({
      model: "xai/grok-4.6",
      reasoningEffort: "high",
    });
    expect(sendRequest).toHaveBeenCalledWith("thread/read", {
      threadId: "child-1",
      includeTurns: false,
    });
  });

  it("deduplicates pending reads and caches the child result", async () => {
    let finish: ((value: { model: string; reasoningEffort: string }) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<{ model: string; reasoningEffort: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const onUpdate = vi.fn();
    const resolver = createSubagentThreadModelResolver({ read, onUpdate });

    resolver.ensure("child-1");
    resolver.ensure("child-1");
    expect(read).toHaveBeenCalledTimes(1);

    finish?.({ model: "xai/grok-4.6", reasoningEffort: "high" });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolver.get("child-1")).toEqual({
      model: "xai/grok-4.6",
      reasoningEffort: "high",
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    resolver.ensure("child-1");
    expect(read).toHaveBeenCalledTimes(1);
    resolver.dispose();
  });

  it("retries exhausted child reads only when refreshed", async () => {
    const read = vi.fn().mockResolvedValue(null);
    const resolver = createSubagentThreadModelResolver({
      read,
      onUpdate: vi.fn(),
      maxAttempts: 1,
    });

    resolver.ensure("child-1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);

    resolver.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    resolver.dispose();
  });

  it("caches saved Subagent activities and reloads them on refresh", async () => {
    const read = vi
      .fn()
      .mockResolvedValue([{ type: "subAgentActivity", kind: "started", agentThreadId: "child-1" }]);
    const onUpdate = vi.fn();
    const resolver = createSubagentActivityHistoryResolver({ read, onUpdate });

    resolver.ensure("parent-1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolver.get("parent-1")).toHaveLength(1);
    resolver.ensure("parent-1");
    expect(read).toHaveBeenCalledTimes(1);

    resolver.refresh("parent-1");
    expect(read).toHaveBeenCalledTimes(2);
    resolver.dispose();
  });

  it("keeps an exact terminal child status without rereading it", async () => {
    const read = vi.fn().mockResolvedValue("failed" as const);
    const resolver = createSubagentThreadStatusResolver({ read, onUpdate: vi.fn() });

    resolver.ensure("child-1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolver.get("child-1")).toBe("failed");
    resolver.ensure("child-1");
    resolver.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    resolver.dispose();
  });
});
