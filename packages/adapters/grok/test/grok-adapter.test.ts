import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  hostTurnIdSchema,
  nativeTurnRefSchema,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  GrokAdapter,
  type GrokAcpTransportLike,
  type GrokOpenResult,
  type GrokPermissionRequest,
  type GrokTransportEvent,
} from "../src/index.js";

const initialize: InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  _meta: {
    modelState: {
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: {
            reasoningEffort: "high",
            reasoningEfforts: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
            totalContextTokens: 500000,
          },
        },
      ],
    },
  },
};

class FakeGrokTransport implements GrokAcpTransportLike {
  sessionId = "grok-session";
  readonly cancel = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly setModel = vi.fn(async () => undefined);
  replay: GrokTransportEvent[] = [];
  signals: unknown;
  #activePromptEvents: GrokTransportEvent[] = [];
  #activePromptText: string | null = null;
  #onEvent: ((event: GrokTransportEvent) => void) | null = null;
  #onPermission: ((request: GrokPermissionRequest) => Promise<RequestPermissionResponse>) | null =
    null;
  #resolve: ((response: PromptResponse) => void) | null = null;

  async inspect(): Promise<InitializeResponse> {
    return initialize;
  }

  async open(
    input: { kind: "create" } | { kind: "resume"; sessionId: string },
  ): Promise<GrokOpenResult> {
    if (input.kind === "resume") this.sessionId = input.sessionId;
    return {
      initialize,
      session: { sessionId: this.sessionId },
      sessionId: this.sessionId,
      replay: [...this.replay],
      ...(this.signals !== undefined ? { signals: this.signals } : {}),
    };
  }

  async getHistory(): Promise<GrokTransportEvent[]> {
    return [...this.replay];
  }

  runTurn(
    text: string,
    onEvent: (event: GrokTransportEvent) => void,
    onPermission: (request: GrokPermissionRequest) => Promise<RequestPermissionResponse>,
  ): Promise<PromptResponse> {
    this.#activePromptText = text;
    this.#activePromptEvents = [];
    this.#onEvent = onEvent;
    this.#onPermission = onPermission;
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  event(event: GrokTransportEvent): void {
    this.#activePromptEvents.push(event);
    this.#onEvent?.(event);
  }

  permission(): Promise<RequestPermissionResponse> {
    if (!this.#onPermission) throw new Error("No active Grok Prompt");
    return this.#onPermission({
      request: {
        sessionId: this.sessionId,
        toolCall: { toolCallId: "tool-1", title: "Run tests" },
        options: [
          { optionId: "native-allow", name: "Allow once", kind: "allow_once" },
          { optionId: "native-deny", name: "Reject", kind: "reject_once" },
        ],
      },
      options: [
        { optionId: "native-allow", name: "Allow once", kind: "allow_once" },
        { optionId: "native-deny", name: "Reject", kind: "reject_once" },
      ],
    });
  }

  finish(response: PromptResponse = { stopReason: "end_turn" }, historyUsage?: unknown): void {
    if (this.#activePromptText !== null) {
      const ordinal = this.replay.filter(({ type }) => type === "turn.completed").length + 1;
      this.replay.push(
        {
          type: "user.text",
          text: this.#activePromptText,
          metadata: { eventId: `grok-session-user-${ordinal}` },
        },
        ...this.#activePromptEvents,
        {
          type: "turn.completed",
          nativeTurnKey: `grok-prompt-${ordinal}`,
          stopReason: response.stopReason,
          ...(historyUsage !== undefined ? { usage: historyUsage } : {}),
        },
      );
    }
    this.#activePromptText = null;
    this.#activePromptEvents = [];
    this.#resolve?.(response);
    this.#resolve = null;
  }
}

async function openedSession(
  transport: FakeGrokTransport,
  kind: "create" | "resume" = "create",
  knownTurnRefs?: NativeTurnRef[],
) {
  let uuid = 0;
  const adapter = new GrokAdapter(
    {},
    {
      randomUUID: () => `grok-id-${++uuid}`,
      createTransport: () => transport,
      fetchCredits: async () => null,
    },
  );
  const opened = await adapter.open(
    kind === "create"
      ? { kind: "create", cwd: "/synthetic" }
      : {
          kind: "resume",
          cwd: "/synthetic",
          nativeRef: {
            harnessId: adapter.harnessId,
            nativeSessionId: transport.sessionId,
            formatVersion: 1,
          },
          ...(knownTurnRefs ? { knownTurnRefs } : {}),
        },
  );
  if (!opened.ok) throw new Error(opened.error.message);
  return { adapter, session: opened.value };
}

async function nextOutput(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput> {
  const result = await iterator.next();
  if (result.done) throw new Error("Grok output ended unexpectedly");
  return result.value;
}

async function nextEvent(
  iterator: AsyncIterator<HarnessOutput>,
): Promise<Extract<HarnessOutput, { kind: "event" }>["event"]> {
  const output = await nextOutput(iterator);
  if (output.kind !== "event") throw new Error("Expected Grok Event");
  return output.event;
}

describe("Grok Adapter ACP projection", () => {
  it("keeps Native Turn identity stable across live completion and resume", async () => {
    const liveTransport = new FakeGrokTransport();
    const live = await openedSession(liveTransport);
    const liveIterator = live.session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-stable");

    await live.session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "before" }],
    });
    expect((await nextEvent(liveIterator)).type).toBe("turn.started");
    liveTransport.event({ type: "agent.text", text: "answer", messageId: "agent-1" });
    expect((await nextEvent(liveIterator)).type).toBe("item.started");
    expect((await nextEvent(liveIterator)).type).toBe("item.updated");
    liveTransport.finish();
    expect((await nextEvent(liveIterator)).type).toBe("item.completed");
    const completed = await nextEvent(liveIterator);
    if (completed.type !== "turn.completed" || !completed.nativeTurnRef) {
      throw new Error("Live Grok Turn has no Native identity");
    }
    await live.adapter.close();

    const resumedTransport = new FakeGrokTransport();
    resumedTransport.replay = [...liveTransport.replay];
    const resumed = await openedSession(resumedTransport, "resume");
    const snapshot = await resumed.session.readSnapshot();
    if (!snapshot.ok || !snapshot.value.turns[0]) {
      throw new Error("Resumed Grok Snapshot has no Turn");
    }
    expect(snapshot.value.turns[0].nativeTurnRef).toEqual(completed.nativeTurnRef);
    await resumed.adapter.close();
  });

  it("omits background-task control records without shifting persisted Turn identities", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      {
        type: "user.text",
        text: "first",
        metadata: { eventId: "grok-session-user-1" },
      },
      { type: "agent.text", text: "answer-1", messageId: "agent-1" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-1",
        stopReason: "end_turn",
      },
      {
        type: "user.text",
        text: '<system-reminder>\nBackground task "call-1" completed.\n</system-reminder>',
        metadata: { eventId: "grok-session-user-bg" },
      },
      {
        type: "turn.completed",
        nativeTurnKey: "task-completed-call-1",
        stopReason: "end_turn",
      },
      {
        type: "user.text",
        text: "second",
        metadata: { eventId: "grok-session-user-2" },
      },
      { type: "agent.text", text: "answer-2", messageId: "agent-2" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-2",
        stopReason: "end_turn",
      },
      {
        type: "user.text",
        text: "third",
        metadata: { eventId: "grok-session-user-3" },
      },
      { type: "agent.text", text: "answer-3", messageId: "agent-3" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-3",
        stopReason: "end_turn",
      },
    ];
    const known = [
      nativeTurnRefSchema.parse({
        harnessId: "grok",
        nativeSessionId: transport.sessionId,
        nativeTurnKey: "grok-prompt-1",
        formatVersion: 1,
      }),
      nativeTurnRefSchema.parse({
        harnessId: "grok",
        nativeSessionId: transport.sessionId,
        nativeTurnKey: "grok-prompt-2",
        formatVersion: 1,
      }),
    ];
    const { adapter, session } = await openedSession(transport, "resume", known);
    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: known[0],
            input: [{ type: "text", text: "first" }],
          },
          {
            nativeTurnRef: known[1],
            input: [{ type: "text", text: "second" }],
          },
          {
            nativeTurnRef: {
              nativeTurnKey: "grok-prompt-3",
            },
            input: [{ type: "text", text: "third" }],
          },
        ],
      },
    });
    await adapter.close();
  });

  it("preserves persisted legacy Turn identity while resuming Native history", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      {
        type: "user.text",
        text: "before",
        metadata: { eventId: "grok-session-user-1" },
      },
      { type: "agent.text", text: "answer", messageId: "agent-1" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-1",
        stopReason: "end_turn",
      },
    ];
    const legacyRef = nativeTurnRefSchema.parse({
      harnessId: "grok",
      nativeSessionId: transport.sessionId,
      nativeTurnKey: "legacy-random-key",
      formatVersion: 1,
    });
    const resumed = await openedSession(transport, "resume", [legacyRef]);
    await expect(resumed.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ nativeTurnRef: legacyRef }] },
    });
    await resumed.adapter.close();
  });

  it("projects Thinking, Tool, Approval, Text, Usage, and terminal in order", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-1");

    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "test" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");

    transport.event({ type: "agent.thought", text: "checking", messageId: "message-1" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");

    transport.event({
      type: "tool.call",
      callId: "tool-1",
      title: "Run tests",
      name: "bash",
      rawInput: { command: "npm test" },
      status: "in_progress",
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("item.started");

    const permission = transport.permission();
    const interactionOutput = await nextOutput(iterator);
    if (interactionOutput.kind !== "interaction") throw new Error("Expected Grok Approval");
    expect(interactionOutput.interaction).toMatchObject({
      type: "approval",
      title: "Run tests",
      actions: [
        { id: "native-1", effect: "allowOnce" },
        { id: "native-2", effect: "deny" },
      ],
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interactionOutput.interaction.interactionId,
        response: { type: "approval", actionId: "native-1" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "native-allow" },
    });
    expect((await nextEvent(iterator)).type).toBe("interaction.closed");

    transport.event({
      type: "tool.update",
      callId: "tool-1",
      status: "completed",
      rawOutput: "passed",
    });
    expect((await nextEvent(iterator)).type).toBe("item.updated");
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    transport.event({ type: "agent.text", text: "done", messageId: "message-2" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");
    transport.finish({
      stopReason: "end_turn",
      usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 },
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await adapter.close();
  });

  it("publishes Grok turn_completed Usage without dropping context", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-usage");

    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "test" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");

    transport.event({
      type: "agent.text",
      text: "working",
      messageId: "message-1",
      metadata: { totalTokens: 7734 },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: turnId,
      usage: { contextUsedTokens: 7734, contextWindowTokens: 500000 },
    });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");

    transport.event({
      type: "turn.completed",
      nativeTurnKey: "grok-prompt-1",
      stopReason: "end_turn",
      usage: {
        inputTokens: 330555,
        outputTokens: 3737,
        totalTokens: 334292,
        cachedReadTokens: 296448,
        cacheCreationTokens: 0,
        reasoningTokens: 2189,
        modelCalls: 9,
        apiDurationMs: 82160,
        costUsdTicks: 2388600000,
        numTurns: 9,
      },
    });
    transport.finish();
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: {
        contextUsedTokens: 7734,
        contextWindowTokens: 500000,
        inputTokens: 330555,
        outputTokens: 3737,
        totalTokens: 334292,
        cachedInputTokens: 296448,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 2189,
        totalCostUsd: 0.23886,
        cacheHitRatePercent: (296448 / 330555) * 100,
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await adapter.close();
  });

  it("publishes cache hit and cost from persisted turn_completed Usage", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-history-usage");

    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "test" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.finish(
      { stopReason: "end_turn" },
      {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cachedReadTokens: 80,
        cacheCreationTokens: 0,
        reasoningTokens: 4,
        costUsdTicks: 126890500,
      },
    );
    const events = [];
    for (;;) {
      const event = await nextEvent(iterator);
      events.push(event);
      if (event.type === "turn.completed") break;
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.usage.changed",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 4,
          totalTokens: 110,
          totalCostUsd: 0.01268905,
          cacheHitRatePercent: 80,
        },
      }),
    );
    await adapter.close();
  });

  it("restores resume Usage from Native history and signals", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      { type: "user.text", text: "before", metadata: { eventId: "grok-session-user-1" } },
      { type: "agent.text", text: "answer", messageId: "agent-1" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-1",
        stopReason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cachedReadTokens: 80,
          cacheCreationTokens: 0,
          reasoningTokens: 4,
          costUsdTicks: 126890500,
        },
      },
    ];
    transport.signals = {
      contextTokensUsed: 52322,
      contextWindowTokens: 500000,
      turnCount: 1,
    };
    const { adapter, session } = await openedSession(transport, "resume");
    expect(session.initialUsage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 4,
      totalCostUsd: 0.01268905,
      cacheHitRatePercent: 80,
      contextUsedTokens: 52322,
      contextWindowTokens: 500000,
    });
    await adapter.close();
  });

  it("sums persisted turn_completed Usage across the Native Session", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();

    const firstTurnId = hostTurnIdSchema.parse("turn-history-sum-1");
    await expect(
      session.execute({
        type: "turn.start",
        turnId: firstTurnId,
        input: [{ type: "text", text: "first" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: firstTurnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.finish(
      { stopReason: "end_turn" },
      {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cachedReadTokens: 80,
        cacheCreationTokens: 0,
        reasoningTokens: 4,
        costUsdTicks: 126890500,
      },
    );
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }

    const secondTurnId = hostTurnIdSchema.parse("turn-history-sum-2");
    await expect(
      session.execute({
        type: "turn.start",
        turnId: secondTurnId,
        input: [{ type: "text", text: "second" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: secondTurnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.finish(
      { stopReason: "end_turn" },
      {
        inputTokens: 50,
        outputTokens: 5,
        totalTokens: 55,
        cachedReadTokens: 45,
        cacheCreationTokens: 2,
        reasoningTokens: 1,
        costUsdTicks: 2388600000,
      },
    );
    const events = [];
    for (;;) {
      const event = await nextEvent(iterator);
      events.push(event);
      if (event.type === "turn.completed") break;
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.usage.changed",
        usage: {
          inputTokens: 150,
          cachedInputTokens: 125,
          cacheWriteInputTokens: 2,
          outputTokens: 15,
          reasoningOutputTokens: 5,
          totalTokens: 165,
          totalCostUsd: 0.25154905,
          cacheHitRatePercent: 90,
        },
      }),
    );
    await adapter.close();
  });

  it("restores resume Usage by summing Native history", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      { type: "user.text", text: "first", metadata: { eventId: "grok-session-user-1" } },
      { type: "agent.text", text: "one", messageId: "agent-1" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-1",
        stopReason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cachedReadTokens: 80,
          cacheCreationTokens: 0,
          reasoningTokens: 4,
          costUsdTicks: 126890500,
        },
      },
      { type: "user.text", text: "second", metadata: { eventId: "grok-session-user-2" } },
      { type: "agent.text", text: "two", messageId: "agent-2" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-2",
        stopReason: "end_turn",
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          totalTokens: 55,
          cachedReadTokens: 45,
          cacheCreationTokens: 2,
          reasoningTokens: 1,
          costUsdTicks: 2388600000,
        },
      },
    ];
    transport.signals = {
      contextTokensUsed: 52322,
      contextWindowTokens: 500000,
      turnCount: 2,
    };
    const { adapter, session } = await openedSession(transport, "resume");
    expect(session.initialUsage).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      totalTokens: 165,
      cachedInputTokens: 125,
      cacheWriteInputTokens: 2,
      reasoningOutputTokens: 5,
      totalCostUsd: 0.25154905,
      cacheHitRatePercent: 90,
      contextUsedTokens: 52322,
      contextWindowTokens: 500000,
    });
    await adapter.close();
  });

  it("cancels the active ACP Prompt and maps replay into a resumable Snapshot", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      { type: "user.text", text: "before", messageId: "user-1" },
      { type: "agent.thought", text: "thought", messageId: "agent-1" },
      { type: "agent.text", text: "answer", messageId: "agent-1" },
    ];
    const { adapter, session } = await openedSession(transport, "resume");
    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "before" }],
            items: [
              { item: { type: "reasoning", text: "thought" } },
              { item: { type: "agentMessage", text: "answer" } },
            ],
          },
        ],
      },
    });

    const turnId = hostTurnIdSchema.parse("turn-cancel");
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "stop" }] });
    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.cancel).toHaveBeenCalledOnce();
    transport.finish({ stopReason: "cancelled" });
    await adapter.close();
  });

  it("rejects unsupported history mutation and invalid create Model selection", async () => {
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    await expect(
      adapter.open({
        kind: "create",
        cwd: "/synthetic",
        model: harnessModelRefSchema.parse({ id: "missing" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    await expect(
      adapter.open({
        kind: "rollbackLastTurn",
        cwd: "/synthetic",
        sourceRef: { harnessId: adapter.harnessId, nativeSessionId: "session", formatVersion: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await adapter.close();
  });

  it("caches Grok account credits on the Adapter without changing Session Usage", async () => {
    const snapshot = {
      usedPercent: 33,
      resetsAt: "2026-08-20T03:32:07.498525+00:00",
      periodType: "weekly" as const,
      fetchedAt: "2026-08-15T00:00:00.000Z",
    };
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => snapshot,
      },
    );
    expect(adapter.credits()).toBeNull();
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
    });
    await expect(adapter.refreshCredits()).resolves.toEqual(snapshot);
    expect(adapter.credits()).toEqual(snapshot);
    await adapter.close();
  });
});
