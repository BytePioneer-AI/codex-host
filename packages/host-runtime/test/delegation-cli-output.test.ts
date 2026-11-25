import { describe, expect, it } from "vitest";

import { compactDelegationOutput, jsonDelegationOutput } from "../src/delegation-cli-output.js";
import { textDelegationOutput } from "../src/delegation-cli-text.js";

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

  it("preserves failure details on Turn ranges", () => {
    expect(
      compactDelegationOutput(
        "thread read",
        {
          threadId: "thread",
          harnessId: "pi",
          status: "failed",
          result: { availability: "unavailable", message: "Model unavailable" },
          turns: [],
          totalTurns: 0,
          from: null,
          to: null,
        },
        "messages",
      ),
    ).toEqual({
      thread: "codex://threads/thread",
      harnessId: "pi",
      status: "failed",
      turns: [],
      totalTurns: 0,
      from: null,
      to: null,
      error: "Model unavailable",
    });
  });

  it.each([
    ["thread read", "result"],
    ["thread read", "messages"],
    ["thread wait", "result"],
    ["thread wait", "messages"],
  ] as const)("preserves empty pendingQuestions in %s --view %s", (command, view) => {
    expect(
      compactDelegationOutput(
        command,
        {
          threadId: "thread",
          harnessId: "pi",
          status: "completed",
          result: { availability: "unavailable" },
          progress: [],
          turns: [],
          totalTurns: 0,
          from: null,
          to: null,
          pendingQuestions: [],
        },
        view,
      ),
    ).toHaveProperty("pendingQuestions", []);
  });

  it.each(["codex", "pi"])(
    "exposes discoverable Model IDs and Thinking restrictions for %s",
    (harnessId) => {
      const id = "provider/vendor/model: v1";
      const fastModel = { id, serviceTier: "priority" };
      const inspection = {
        status: "ready",
        catalog: {
          models: [
            {
              ref: { id },
              label: "Model",
              fastModel,
              supportedThinkingOptionIds: ["high"],
            },
            {
              ref: { id, serviceTier: "ultrafast" },
              label: "Model · Ultrafast",
              supportedThinkingOptionIds: [],
            },
          ],
          defaultModel: fastModel,
          thinkingOptions: [{ id: "high", label: "High" }],
          defaultThinkingOptionId: "high",
        },
        capabilities: { configuration: { selectModel: true, selectThinkingOption: true } },
      };
      const result = { harnessId, inspection };
      expect(compactDelegationOutput("harness inspect", result)).toEqual({
        harnessId,
        status: "ready",
        models: [
          { id, label: "Model", thinking: ["high"] },
          { id: `${id}~fast`, label: "Model (Fast)", thinking: ["high"] },
          { id: `${id}~ultrafast`, label: "Model · Ultrafast", thinking: [] },
        ],
        defaultModel: `${id}~fast`,
        thinkingOptions: inspection.catalog.thinkingOptions,
        defaultThinkingOptionId: "high",
        capabilities: inspection.capabilities,
      });
      expect(jsonDelegationOutput("harness inspect", result)).toEqual({
        harnessId,
        inspection: {
          ...inspection,
          catalog: {
            ...inspection.catalog,
            models: [
              { ...inspection.catalog.models[0], fastModel: { id: `${id}~fast` } },
              { ...inspection.catalog.models[1], ref: { id: `${id}~ultrafast` } },
            ],
            defaultModel: { id: `${id}~fast` },
          },
        },
      });
      expect(textDelegationOutput("harness inspect", result)).toContain(`defaultModel: ${id}~fast`);
      expect(
        compactDelegationOutput("delegate start", {
          harnessId,
          configuration: { effective: { effectiveModel: fastModel, resolvedModelLabel: "Model" } },
        }),
      ).toHaveProperty("model", `${id}~fast`);
      const unavailable = { status: "unavailable", error: { message: "Missing executable" } };
      expect(
        compactDelegationOutput("harness inspect", { harnessId, inspection: unavailable }),
      ).toEqual({ harnessId, ...unavailable });
    },
  );

  it("exposes pending Questions and the answer receipt without claiming success", () => {
    const question = {
      interactionId: "interaction-1",
      turnId: "private-turn",
      request: {
        questions: [{ id: "decision", question: "Continue?", options: [{ label: "Continue" }] }],
      },
    };
    expect(
      compactDelegationOutput("thread read", {
        threadId: "child",
        harnessId: "pi",
        status: "running",
        result: { availability: "pending" },
        progress: [],
        nextCursor: null,
        pendingQuestions: [question],
      }),
    ).toEqual({
      thread: "codex://threads/child",
      harnessId: "pi",
      status: "running",
      result: { availability: "pending" },
      pendingQuestions: [question],
    });
    expect(
      compactDelegationOutput("thread answer", {
        threadId: "child",
        interactionId: "interaction-1",
        turnId: "private-turn",
        harnessId: "pi",
        status: "running",
        next: {},
      }),
    ).toEqual({
      thread: "codex://threads/child",
      interaction: "interaction-1",
      turn: "private-turn",
      harnessId: "pi",
      status: "running",
    });
    expect(
      compactDelegationOutput("thread watch", {
        threadId: "child",
        notifyThreadId: "parent",
        state: "alreadyNeedsInput",
        status: "running",
        timeoutMs: 1_000,
        pendingQuestions: [question],
      }),
    ).toEqual({
      thread: "codex://threads/child",
      notify: "codex://threads/parent",
      state: "alreadyNeedsInput",
      status: "running",
      timeoutMs: 1_000,
      pendingQuestions: [question],
    });
    expect(
      compactDelegationOutput("thread watches", {
        watches: [
          {
            threadId: "child",
            notifyThreadId: "parent",
            state: "pendingDelivery",
            outcome: "needsInput",
            turnId: "private-turn",
            interactionId: "interaction-1",
            registeredAt: "timestamp",
          },
        ],
      }),
    ).toEqual({
      watches: [
        {
          thread: "codex://threads/child",
          notify: "codex://threads/parent",
          state: "pendingDelivery",
          outcome: "needsInput",
          turn: "private-turn",
          interaction: "interaction-1",
        },
      ],
    });
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
