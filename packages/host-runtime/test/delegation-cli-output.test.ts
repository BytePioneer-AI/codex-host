import { describe, expect, it } from "vitest";

import { compactDelegationOutput } from "../src/delegation-cli-output.js";

describe("compact delegation output", () => {
  it.each([
    ["running", { availability: "pending" }],
    ["failed", { availability: "unavailable", message: "Provider rejected the request" }],
    ["interrupted", { availability: "unavailable" }],
    ["completed", { availability: "available", text: "Full final answer" }],
  ])("preserves the %s outcome and only shows live, nonempty progress", (status, result) => {
    expect(
      compactDelegationOutput("thread wait", {
        threadId: "thread",
        harnessId: "pi",
        status,
        result,
        turn: { turnId: "private-turn", status },
        progress: [
          { id: "old", turnId: "private-turn", text: "Earlier update" },
          { id: "latest", turnId: "private-turn", text: "Latest update" },
          { id: "blank", turnId: "private-turn", text: "\n " },
        ],
        nextCursor: "internal-bookmark",
        timedOut: status === "running",
      }),
    ).toEqual({
      thread: "codex://threads/thread",
      harnessId: "pi",
      status,
      result,
      timedOut: status === "running",
      ...(status === "running" ? { progress: "Latest update" } : {}),
    });
  });

  it("does not invent a pagination end when connected to an older Runtime", () => {
    expect(() =>
      compactDelegationOutput(
        "thread read",
        {
          threadId: "thread",
          harnessId: "pi",
          status: "completed",
          messages: [],
          result: { availability: "unavailable" },
          nextCursor: "bookmark",
        },
        "messages",
      ),
    ).toThrow("updated Host Runtime");
  });

  it("preserves failure details on message pages", () => {
    expect(
      compactDelegationOutput(
        "thread read",
        {
          threadId: "thread",
          harnessId: "pi",
          status: "failed",
          result: { availability: "unavailable", message: "Model unavailable" },
          messages: [],
          hasMore: false,
          nextCursor: "bookmark",
        },
        "messages",
      ),
    ).toEqual({
      thread: "codex://threads/thread",
      harnessId: "pi",
      status: "failed",
      messages: [],
      hasMore: false,
      nextCursor: "bookmark",
      error: "Model unavailable",
    });
  });

  it("exposes discoverable Model IDs and native Thinking restrictions", () => {
    const inspection = {
      status: "ready",
      catalog: {
        models: [
          {
            ref: { id: "opaque-a" },
            label: "Provider / Model A",
            supportedThinkingOptionIds: ["high"],
          },
          { ref: { id: "opaque-b" }, label: "Provider / Model B", supportedThinkingOptionIds: [] },
        ],
        defaultModel: { id: "opaque-a" },
        thinkingOptions: [{ id: "high", label: "High" }],
        defaultThinkingOptionId: "high",
      },
      capabilities: { configuration: { selectModel: true, selectThinkingOption: true } },
    };
    expect(compactDelegationOutput("harness inspect", { harnessId: "pi", inspection })).toEqual({
      harnessId: "pi",
      status: "ready",
      models: [
        { id: "opaque-a", label: "Provider / Model A", thinking: ["high"] },
        { id: "opaque-b", label: "Provider / Model B", thinking: [] },
      ],
      defaultModel: "opaque-a",
      thinkingOptions: inspection.catalog.thinkingOptions,
      defaultThinkingOptionId: "high",
      capabilities: inspection.capabilities,
    });
    const unavailable = { status: "unavailable", error: { message: "Missing executable" } };
    expect(
      compactDelegationOutput("harness inspect", { harnessId: "pi", inspection: unavailable }),
    ).toEqual({ harnessId: "pi", ...unavailable });
  });

  it("returns operational task links and acknowledges cancellation without claiming completion", () => {
    const common = { threadId: "child", harnessId: "pi", turnId: "private-turn" };
    expect(
      compactDelegationOutput("thread send", { ...common, status: "running", next: {} }),
    ).toEqual({ thread: "codex://threads/child", harnessId: "pi", status: "running" });
    for (const cancelled of [true, false]) {
      expect(compactDelegationOutput("thread cancel", { ...common, cancelled })).toEqual({
        thread: "codex://threads/child",
        harnessId: "pi",
        cancelRequested: cancelled,
      });
    }
    expect(
      compactDelegationOutput("thread list", {
        threads: [
          {
            ...common,
            deepLink: "codex://threads/child",
            title: "Task",
            cwd: "/project",
            status: "completed",
            createdAt: "timestamp",
          },
        ],
        nextCursor: null,
      }),
    ).toEqual({
      threads: [
        {
          thread: "codex://threads/child",
          harnessId: "pi",
          title: "Task",
          cwd: "/project",
          status: "completed",
        },
      ],
      nextCursor: null,
    });
  });
});
