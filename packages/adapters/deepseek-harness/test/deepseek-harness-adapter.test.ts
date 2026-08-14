import { describe, expect, it, vi } from "vitest";

import type { HistoryEntry, MuxFrame, SessionModels } from "@deepseek-ai/dsh-host-apiproxy/api";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy/api";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  DeepSeekHarnessAdapter,
  type DeepSeekHarnessAdapterDependencies,
  type DeepSeekHostConnectionLike,
} from "../src/deepseek-harness-adapter.js";
import type {
  DeepSeekHostClient,
  DeepSeekHostSubscriber,
  DeepSeekMuxEnvelope,
} from "../src/host-client.js";
import { encodeDeepSeekHarnessModelRef } from "../src/model-catalog.js";
import { projectToolResult } from "../src/projection.js";

const SESSION_ID = "session-native-1" as SessionId;
const CURRENT_MODEL = { provider: "deepseek-official", model: "deepseek-v4-flash" };
const MODEL_GROUPS = [
  {
    id: "deepseek-official",
    name: "DeepSeek",
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
  },
];

function success<T>(value: T) {
  return { rpcId: RpcId("response"), result: { ok: true as const, value } };
}

function event(seq: number, type: string, data: Record<string, unknown>): HistoryEntry {
  return {
    event: { type, seq, time: seq, data } as HistoryEntry["event"],
  };
}

class FakeConnection implements DeepSeekHostConnectionLike {
  readonly subscribers = new Map<string, DeepSeekHostSubscriber>();
  readonly history = new Map<string, HistoryEntry[]>();
  readonly calls = {
    list: vi.fn(),
    create: vi.fn(),
    history: vi.fn(),
    models: vi.fn(),
    selectModel: vi.fn(),
    prompt: vi.fn(),
    cancel: vi.fn(),
    respond: vi.fn(),
  };
  connected = false;
  closed = false;
  readonly client: DeepSeekHostClient;

  constructor() {
    const sessions = {
      list: this.calls.list,
      create: this.calls.create,
      history: this.calls.history,
      models: this.calls.models,
      selectModel: this.calls.selectModel,
      prompt: this.calls.prompt,
      cancel: this.calls.cancel,
    };
    this.calls.create.mockImplementation(({ sessionId }: { sessionId?: SessionId }) =>
      Promise.resolve(success({ sessionId: sessionId ?? SESSION_ID, agentPreset: "standard" })),
    );
    this.calls.history.mockImplementation(({ sessionId }: { sessionId: SessionId }) =>
      Promise.resolve(success({ events: this.history.get(sessionId) ?? [], hasMore: false })),
    );
    this.calls.models.mockResolvedValue(
      success<SessionModels>({
        current: CURRENT_MODEL,
        routable: true,
        groups: MODEL_GROUPS,
        failures: [],
      }),
    );
    this.calls.selectModel.mockImplementation(
      ({ provider, model }: { provider: string; model: string }) =>
        Promise.resolve(success({ selected: { provider, model } })),
    );
    this.calls.prompt.mockResolvedValue(success({ accepted: true }));
    this.calls.cancel.mockResolvedValue(success({ accepted: true }));
    this.calls.respond.mockResolvedValue({ accepted: true });
    this.client = {
      sessions,
      host: {
        describe: vi.fn().mockResolvedValue(
          success({
            version: "0.0.1",
            cwd: "/workspace",
            provider: CURRENT_MODEL.provider,
            model: CURRENT_MODEL.model,
            attachedSessions: 0,
            canOpenPath: false,
          }),
        ),
      },
      llm: {
        models: vi.fn().mockResolvedValue(success({ groups: MODEL_GROUPS, failures: [] })),
      },
      respond: this.calls.respond,
    } as unknown as DeepSeekHostClient;
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  subscribe(sessionId: string, subscriber: DeepSeekHostSubscriber): () => void {
    this.subscribers.set(sessionId, subscriber);
    return () => this.subscribers.delete(sessionId);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  mux(sessionId: string, payload: MuxFrame, rpcId = "frame"): void {
    this.subscribers.get(sessionId)?.onMux({
      rpcId: RpcId(rpcId),
      payload,
    } as DeepSeekMuxEnvelope);
  }

  sessionEvent(sessionId: string, seq: number, type: string, data: Record<string, unknown>): void {
    this.mux(sessionId, {
      type: "session/event",
      sessionId: sessionId as SessionId,
      event: { type, seq, time: seq, data } as never,
    });
  }
}

function fixture(): {
  adapter: DeepSeekHarnessAdapter;
  connection: FakeConnection;
} {
  const connection = new FakeConnection();
  const dependencies: DeepSeekHarnessAdapterDependencies = {
    randomUUID: () => "native-1",
    createConnection: () => connection,
  };
  return { adapter: new DeepSeekHarnessAdapter({}, dependencies), connection };
}

async function collectUntilTurn(session: Awaited<ReturnType<typeof openCreated>>) {
  const outputs = [];
  for await (const output of session.outputs) {
    outputs.push(output);
    if (output.kind === "event" && output.event.type === "turn.completed") return outputs;
  }
  throw new Error("Output stream ended before Turn completion");
}

async function openCreated(adapter: DeepSeekHarnessAdapter) {
  const opened = await adapter.open({ kind: "create", cwd: "/workspace" });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

describe("DeepSeekHarnessAdapter local Host", () => {
  it("inspects the local Host model catalog", async () => {
    const { adapter, connection } = fixture();

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "ready",
      catalog: {
        models: [
          { label: "DeepSeek / DeepSeek V4 Flash" },
          { label: "DeepSeek / DeepSeek V4 Pro" },
        ],
      },
    });
    expect(connection.connected).toBe(true);
    expect(connection.calls.list).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("creates an official Session, selects the requested Model, and projects a live Tool Turn", async () => {
    const { adapter, connection } = fixture();
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    const opened = await adapter.open({ kind: "create", cwd: "/workspace", model });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const sessionId = session.initialState.nativeRef?.nativeSessionId;
    expect(sessionId).toBe("session-native-1");
    expect(connection.calls.create).toHaveBeenCalledWith({
      cwd: "/workspace",
      sessionId: "session-native-1",
    });
    expect(connection.calls.selectModel).toHaveBeenCalledWith({
      sessionId: "session-native-1",
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });

    const turnId = hostTurnIdSchema.parse("host-turn-1");
    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    const collecting = collectUntilTurn(session);
    connection.sessionEvent(sessionId as string, 1, "turn/start", { turn: 1 });
    connection.sessionEvent(sessionId as string, 2, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", text: "answer" },
    });
    connection.sessionEvent(sessionId as string, 3, "tool/call", {
      turn: 1,
      step: 1,
      callId: "read-1",
      name: "read",
      arguments: '{"file_path":"README.md"}',
    });
    connection.sessionEvent(sessionId as string, 4, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        source: { kind: "tool", callId: "read-1" },
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            content: [{ type: "text", text: "contents" }],
            isError: false,
          },
        ],
      },
    });
    connection.sessionEvent(sessionId as string, 5, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "answer" }] },
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    connection.sessionEvent(sessionId as string, 6, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    const outputs = await collecting;
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.completed",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({
                type: "toolExecution",
                output: { content: [{ type: "text", text: "contents" }] },
              }),
            }),
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            nativeTurnRef: expect.objectContaining({ nativeTurnKey: "turn:1" }),
            outcome: { status: "succeeded" },
          }),
        }),
      ]),
    );
    await session.close();
    expect(connection.closed).toBe(false);
    await adapter.close();
    expect(connection.closed).toBe(true);
  });

  it("projects Session Usage with a context window for a known Model", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const sessionId = session.initialState.nativeRef?.nativeSessionId;
    const turnId = hostTurnIdSchema.parse("host-turn-usage");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    const collecting = collectUntilTurn(session);
    connection.sessionEvent(sessionId as string, 1, "request/context", {
      provider: "deepseek-official",
      model: "deepseek-chat",
      contextWindow: 128_000,
    });
    connection.mux(sessionId as string, {
      type: "session/projection",
      sessionId: sessionId as SessionId,
      key: "sessionStats",
      value: { decodeTokens: 164, decodeMs: 1_000 },
      seq: 1,
    });
    connection.sessionEvent(sessionId as string, 2, "request/header", {
      header: { config: { provider: "deepseek-official", model: "deepseek-chat" } },
    });
    connection.sessionEvent(sessionId as string, 3, "turn/start", { turn: 1 });
    connection.sessionEvent(sessionId as string, 4, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5, reasoningTokens: 2 },
      },
    });
    connection.sessionEvent(sessionId as string, 5, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "answer" }] },
    });
    connection.sessionEvent(sessionId as string, 6, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    const outputs = await collecting;
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "session.usage.changed",
            observedForTurnId: turnId,
            usage: expect.objectContaining({
              inputTokens: 10,
              outputTokens: 4,
              cachedInputTokens: 5,
              reasoningOutputTokens: 2,
              cacheHitRatePercent: 33.33333333333333,
              outputTokensPerSecond: 164,
              contextUsedTokens: 15,
              contextWindowTokens: 128_000,
            }),
          }),
        }),
      ]),
    );
    await session.close();
    await adapter.close();
  });

  it("uses the context window DeepSeek Harness advertises on request/context", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const sessionId = session.initialState.nativeRef?.nativeSessionId;
    const turnId = hostTurnIdSchema.parse("host-turn-context");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    const collecting = collectUntilTurn(session);
    connection.sessionEvent(sessionId as string, 1, "request/context", {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      contextWindow: 131_072,
    });
    connection.sessionEvent(sessionId as string, 2, "turn/start", { turn: 1 });
    connection.sessionEvent(sessionId as string, 3, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "answer" }] },
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5 },
    });
    connection.sessionEvent(sessionId as string, 4, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    const outputs = await collecting;
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "session.usage.changed",
            observedForTurnId: turnId,
            usage: expect.objectContaining({
              inputTokens: 10,
              outputTokens: 4,
              cachedInputTokens: 5,
              cacheHitRatePercent: 33.33333333333333,
              contextUsedTokens: 15,
              contextWindowTokens: 131_072,
            }),
          }),
        }),
      ]),
    );
    await session.close();
    await adapter.close();
  });

  it("accumulates Usage across Turns and replaces duplicate step reports", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const sessionId = session.initialState.nativeRef?.nativeSessionId;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const collectTurn = async (): Promise<unknown[]> => {
      const outputs: unknown[] = [];
      for (;;) {
        const result = await iterator.next();
        if (result.done) throw new Error("Output stream ended before Turn completion");
        outputs.push(result.value);
        if (result.value.kind === "event" && result.value.event.type === "turn.completed") {
          return outputs;
        }
      }
    };

    const firstTurn = hostTurnIdSchema.parse("host-turn-aggregate-1");
    await session.execute({
      type: "turn.start",
      turnId: firstTurn,
      input: [{ type: "text", text: "first" }],
    });
    const firstCollecting = collectTurn();
    connection.sessionEvent(sessionId as string, 1, "request/context", {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      contextWindow: 128_000,
    });
    connection.sessionEvent(sessionId as string, 2, "turn/start", { turn: 1 });
    connection.sessionEvent(sessionId as string, 3, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "first answer" }] },
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5 },
    });
    connection.sessionEvent(sessionId as string, 4, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await firstCollecting;

    const secondTurn = hostTurnIdSchema.parse("host-turn-aggregate-2");
    await session.execute({
      type: "turn.start",
      turnId: secondTurn,
      input: [{ type: "text", text: "second" }],
    });
    const secondCollecting = collectTurn();
    connection.sessionEvent(sessionId as string, 5, "turn/start", { turn: 2 });
    connection.sessionEvent(sessionId as string, 6, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "usage", usage: { inputTokens: 20, outputTokens: 6 } },
    });
    connection.sessionEvent(sessionId as string, 7, "assistant/message", {
      turn: 2,
      step: 1,
      message: { content: [{ type: "text", text: "second answer" }] },
      usage: { inputTokens: 20, outputTokens: 6 },
    });
    connection.sessionEvent(sessionId as string, 8, "turn/end", {
      turn: 2,
      reason: { kind: "completed" },
    });
    const outputs = await secondCollecting;
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "session.usage.changed",
            observedForTurnId: secondTurn,
            usage: expect.objectContaining({
              inputTokens: 30,
              outputTokens: 10,
              cachedInputTokens: 5,
              contextUsedTokens: 20,
              contextWindowTokens: 128_000,
            }),
          }),
        }),
      ]),
    );
    await session.close();
    await adapter.close();
  });

  it("forwards cancellation for the active Turn", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const turnId = hostTurnIdSchema.parse("host-turn-cancel");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "long task" }],
    });

    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(connection.calls.cancel).toHaveBeenCalledWith({ sessionId: "session-native-1" });
    await adapter.close();
  });

  it("resumes only the mapped Native Session and filters injected user messages from history", async () => {
    const { adapter, connection } = fixture();
    connection.history.set(SESSION_ID, [
      event(0, "turn/start", { turn: 1 }),
      event(1, "user/message", {
        role: "user",
        source: { kind: "user", rpcId: "human" },
        content: [{ type: "text", text: "human prompt" }],
      }),
      event(2, "user/message", {
        role: "user",
        source: { kind: "skill-catalog" },
        content: [{ type: "text", text: "injected catalog" }],
      }),
      event(3, "request/context", {
        provider: CURRENT_MODEL.provider,
        model: CURRENT_MODEL.model,
        contextWindow: 131_072,
      }),
      event(4, "request/header", {
        header: { config: CURRENT_MODEL },
      }),
      event(5, "assistant/message", {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "reasoning", text: "thought" },
            { type: "text", text: "answer" },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5 },
      }),
      event(6, "assistant/message", {
        turn: 1,
        step: 2,
        message: { content: [] },
        usage: { inputTokens: 20, outputTokens: 6 },
      }),
      event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ]);

    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialUsage).toMatchObject({
      inputTokens: 30,
      outputTokens: 10,
      cachedInputTokens: 5,
      contextUsedTokens: 20,
      contextWindowTokens: 131_072,
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "human prompt" }],
            items: [
              { item: { type: "reasoning", text: "thought" } },
              { item: { type: "agentMessage", text: "answer" } },
            ],
            outcome: { status: "succeeded" },
          },
        ],
      },
    });
    expect(connection.calls.create).not.toHaveBeenCalled();
    expect(connection.calls.list).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("projects full-profile questions and sends the official response envelope", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const turnId = hostTurnIdSchema.parse("host-turn-question");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "ask" }],
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    connection.sessionEvent("session-native-1", 1, "turn/start", { turn: 1 });
    await iterator.next();
    connection.mux(
      "session-native-1",
      {
        type: "question/requested",
        sessionId: SESSION_ID,
        questions: [
          {
            id: "choice",
            question: "Choose",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      "question-rpc",
    );
    const requested = await iterator.next();
    expect(requested.value).toMatchObject({
      kind: "interaction",
      interaction: { type: "question", turnId },
    });
    const interaction = requested.value.interaction;
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { choice: ["A"] } },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(connection.calls.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "client-response",
        rpcId: "question-rpc",
        result: {
          ok: true,
          value: {
            sessionId: "session-native-1",
            answer: { answers: [{ id: "choice", selected: ["A"] }] },
          },
        },
      }),
    );
    await adapter.close();
  });

  it("keeps one Question close when DSH resolves during respond and continues the Turn", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const turnId = hostTurnIdSchema.parse("host-turn-question-continue");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "ask" }],
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    connection.sessionEvent("session-native-1", 1, "turn/start", { turn: 1 });
    await iterator.next();
    connection.mux(
      "session-native-1",
      {
        type: "question/requested",
        sessionId: SESSION_ID,
        questions: [
          {
            id: "choice",
            question: "Choose",
            header: "Ask user question",
            options: [{ label: "能看到弹窗，一切正常" }, { label: "看不到" }],
          },
        ],
      },
      "question-rpc",
    );
    const requested = await iterator.next();
    const interaction = requested.value.interaction;

    let releaseRespond: ((value: { accepted: true }) => void) | undefined;
    connection.calls.respond.mockImplementationOnce(
      () =>
        new Promise<{ accepted: true }>((resolve) => {
          releaseRespond = resolve;
        }),
    );

    const responding = session.execute({
      type: "interaction.respond",
      interactionId: interaction.interactionId,
      response: { type: "question", answers: { choice: ["能看到弹窗，一切正常"] } },
    });

    connection.mux(
      "session-native-1",
      {
        type: "question/resolved",
        sessionId: SESSION_ID,
        questionRpcId: RpcId("question-rpc"),
        outcome: "answered",
      },
      "question-resolved",
    );
    connection.sessionEvent("session-native-1", 2, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "reasoning-delta", text: "thinking after answer" },
    });
    releaseRespond?.({ accepted: true });
    await expect(responding).resolves.toEqual({ ok: true, value: { accepted: true } });
    connection.sessionEvent("session-native-1", 3, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "reasoning-delta", text: " more thinking" },
    });
    connection.sessionEvent("session-native-1", 4, "assistant/message", {
      turn: 1,
      step: 2,
      message: { content: [{ type: "text", text: "final answer" }] },
    });
    connection.sessionEvent("session-native-1", 5, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });

    const outputs: HarnessOutput[] = [];
    for (;;) {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for turn.completed")), 200);
        }),
      ]);
      if (result.done) throw new Error("Output stream ended before Turn completion");
      outputs.push(result.value);
      if (result.value.kind === "event" && result.value.event.type === "turn.completed") break;
    }

    expect(
      outputs.filter(
        (output) => output.kind === "event" && output.event.type === "interaction.closed",
      ),
    ).toHaveLength(1);
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.updated",
            update: { type: "text.append", text: "thinking after answer" },
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.completed",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({ type: "agentMessage", text: "final answer" }),
            }),
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: { status: "succeeded" },
          }),
        }),
      ]),
    );
    await adapter.close();
  });

  it("projects native Tool failures from the nested DSH result block", () => {
    expect(
      projectToolResult(
        {
          source: { kind: "tool", callId: "read-1" },
          content: [
            {
              type: "tool-result",
              toolCallId: "read-1",
              content: [{ type: "text", text: "Error: file not found" }],
              isError: true,
            },
          ],
        },
        64_000,
      ),
    ).toEqual({
      callId: "read-1",
      failed: true,
      output: { content: [{ type: "text", text: "Error: file not found" }] },
    });
  });
});
