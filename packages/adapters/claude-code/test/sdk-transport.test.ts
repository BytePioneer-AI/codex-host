import { describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeSdkTransport, type ClaudeSdkTransportOptions } from "../src/sdk-transport.js";
import type { ClaudeTurnEvent } from "../src/transport.js";

class FakeQuery {
  readonly initializationResult = vi.fn(async () => ({}));
  readonly interrupt = vi.fn(async () => undefined);
  readonly getContextUsage = vi.fn(async () => ({ totalTokens: 40, maxTokens: 200 }));
  #closed = false;
  #messages: SDKMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  push(message: SDKMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.#messages.push(message);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.#messages.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

type QueryInput = Parameters<NonNullable<ClaudeSdkTransportOptions["queryFactory"]>>[0];

function fixture(openMode: "create" | "resume" = "create") {
  const fakeQuery = new FakeQuery();
  let queryInput: QueryInput | undefined;
  const queryFactory: NonNullable<ClaudeSdkTransportOptions["queryFactory"]> = vi.fn((input) => {
    queryInput = input;
    return fakeQuery as unknown as Query;
  });
  const onFault = vi.fn();
  const transport = new ClaudeSdkTransport({
    command: process.execPath,
    cwd: process.cwd(),
    sessionId: "00000000-0000-4000-8000-000000000001",
    openMode,
    closeTimeoutMs: 100,
    onFault,
    queryFactory,
  });
  return {
    fakeQuery,
    onFault,
    queryFactory,
    queryInput: () => {
      if (!queryInput) throw new Error("SDK query was not created");
      return queryInput;
    },
    transport,
  };
}

function completeTurn(fakeQuery: FakeQuery): void {
  fakeQuery.push({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
  } as unknown as SDKMessage);
}

function options(value: ReturnType<typeof fixture>): NonNullable<QueryInput["options"]> {
  const queryOptions = value.queryInput().options;
  if (!queryOptions) throw new Error("SDK query options are missing");
  return queryOptions;
}

function questionInput() {
  return {
    questions: [
      {
        question: "Which path?",
        header: "Path",
        options: [
          { label: "Alpha", description: "First", preview: "ignored" },
          { label: "Beta", description: "Second" },
        ],
        multiSelect: false,
      },
    ],
  };
}

describe("ClaudeSdkTransport context Usage", () => {
  it("reads the stable Query context operation and rejects invalid observations", async () => {
    const value = fixture();

    await expect(value.transport.getContextUsage()).resolves.toBeNull();
    expect(value.fakeQuery.getContextUsage).not.toHaveBeenCalled();

    await value.transport.start();
    await expect(value.transport.getContextUsage()).resolves.toEqual({
      usedTokens: 40,
      maxTokens: 200,
    });

    value.fakeQuery.getContextUsage.mockResolvedValueOnce({ totalTokens: -1, maxTokens: 0 });
    await expect(value.transport.getContextUsage()).rejects.toThrow("invalid Token values");

    value.fakeQuery.getContextUsage.mockRejectedValueOnce(new Error("context unavailable"));
    await expect(value.transport.getContextUsage()).rejects.toThrow("context unavailable");
    await value.transport.close();
  });
});

describe("ClaudeSdkTransport Question callbacks", () => {
  it("uses caller identity for create and the same Native Session for resume", async () => {
    const created = fixture();
    await created.transport.start();
    expect(options(created)).toMatchObject({
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(options(created).resume).toBeUndefined();
    await created.transport.close();

    const resumed = fixture("resume");
    await resumed.transport.start();
    expect(options(resumed)).toMatchObject({
      resume: "00000000-0000-4000-8000-000000000001",
    });
    expect(options(resumed).sessionId).toBeUndefined();
    await resumed.transport.close();
  });

  it("inherits native Tools and returns an exact AskUserQuestion PermissionResult", async () => {
    const value = fixture();
    await value.transport.start();
    const queryOptions = options(value);
    expect(queryOptions.permissionMode).toBe("default");
    expect(queryOptions).not.toHaveProperty("tools");
    expect(queryOptions.onUserDialog).toBeUndefined();
    expect(queryOptions.onElicitation).toBeUndefined();
    const canUseTool = queryOptions.canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");

    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000002",
      (event) => events.push(event),
    );
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "native-tool",
      requestId: "native-request",
    });
    expect(events).toEqual([
      {
        type: "interaction.requested",
        request: {
          requestId: "native-request",
          toolUseId: "native-tool",
          questions: [
            {
              question: "Which path?",
              header: "Path",
              options: [
                { label: "Alpha", description: "First" },
                { label: "Beta", description: "Second" },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ]);
    await value.transport.respondToInteraction({
      requestId: "native-request",
      answers: { "Which path?": "Alpha" },
    });
    await expect(permission).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...questionInput(), answers: { "Which path?": "Alpha" } },
      toolUseID: "native-tool",
      decisionClassification: "user_temporary",
    });
    expect(events.at(-1)).toEqual({
      type: "interaction.closed",
      requestId: "native-request",
      reason: "responded",
    });
    await expect(
      value.transport.respondToInteraction({
        requestId: "native-request",
        answers: { "Which path?": "Beta" },
      }),
    ).rejects.toThrow("not pending");

    completeTurn(value.fakeQuery);
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    await value.transport.close();
    expect(value.onFault).not.toHaveBeenCalled();
  });

  it("denies unknown and malformed callbacks without exposing an Interaction", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000003",
      (event) => events.push(event),
    );

    await expect(
      canUseTool(
        "Read",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "other-tool",
          requestId: "other-request",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "other-tool" });
    await expect(
      canUseTool(
        "AskUserQuestion",
        { questions: [] },
        {
          signal: new AbortController().signal,
          toolUseID: "bad-tool",
          requestId: "bad-request",
        },
      ),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "bad-tool" });
    expect(events).toEqual([]);

    const first = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "duplicate-tool",
      requestId: "duplicate-request",
    });
    await expect(
      canUseTool("AskUserQuestion", questionInput(), {
        signal: new AbortController().signal,
        toolUseID: "second-tool",
        requestId: "duplicate-request",
      }),
    ).resolves.toMatchObject({ behavior: "deny", toolUseID: "second-tool" });
    expect(events.map(({ type }) => type)).toEqual(["interaction.requested"]);
    await value.transport.respondToInteraction({
      requestId: "duplicate-request",
      cancelled: true,
    });
    await expect(first).resolves.toMatchObject({ behavior: "deny", toolUseID: "duplicate-tool" });
    expect(events.at(-1)).toMatchObject({ type: "interaction.closed", reason: "cancelled" });

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });

  it("closes a pending callback and Turn when the transport closes", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000005",
      (event) => events.push(event),
    );
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: new AbortController().signal,
      toolUseID: "close-tool",
      requestId: "close-request",
    });

    const turnClosed = expect(turn).rejects.toThrow("transport closed");
    await value.transport.close();
    await expect(permission).resolves.toMatchObject({ behavior: "deny", toolUseID: "close-tool" });
    await turnClosed;
    expect(events.map(({ type }) => type)).toEqual(["interaction.requested", "interaction.closed"]);
    expect(events.at(-1)).toMatchObject({ reason: "cancelled" });
  });

  it("closes a pending callback once when its AbortSignal fires", async () => {
    const value = fixture();
    await value.transport.start();
    const canUseTool = options(value).canUseTool;
    if (!canUseTool) throw new Error("SDK canUseTool callback was not configured");
    const events: ClaudeTurnEvent[] = [];
    const turn = value.transport.runTurn(
      "synthetic",
      "00000000-0000-4000-8000-000000000004",
      (event) => events.push(event),
    );
    const controller = new AbortController();
    const permission = canUseTool("AskUserQuestion", questionInput(), {
      signal: controller.signal,
      toolUseID: "abort-tool",
      requestId: "abort-request",
    });
    controller.abort();
    await expect(permission).resolves.toMatchObject({
      behavior: "deny",
      toolUseID: "abort-tool",
    });
    expect(events.map(({ type }) => type)).toEqual(["interaction.requested", "interaction.closed"]);
    expect(events.at(-1)).toMatchObject({ reason: "cancelled" });
    await expect(
      value.transport.respondToInteraction({ requestId: "abort-request", cancelled: true }),
    ).rejects.toThrow("not pending");

    completeTurn(value.fakeQuery);
    await turn;
    await value.transport.close();
  });
});
