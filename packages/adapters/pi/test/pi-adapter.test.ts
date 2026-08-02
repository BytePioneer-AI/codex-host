import { describe, expect, it, vi } from "vitest";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

import type {
  HarnessOutput,
  HarnessSession,
  HostQuestionInteraction,
  HostUsage,
} from "@codexhost/harness-adapter";
import {
  PiAdapter,
  type PiAdapterDependencies,
  type PiAdapterOptions,
  type PiTurnTransport,
} from "../src/pi-adapter.js";
import type { PiSessionHistory } from "../src/pi-history.js";
import { encodePiModelRef } from "../src/pi-model-catalog.js";
import {
  PiRpcFaultError,
  type PiInteractionResponse,
  type PiRpcSessionOptions,
  type PiSessionState,
  type PiTurnEvent,
  type PiTurnResult,
} from "../src/pi-rpc-session.js";

class FakePiTransport implements PiTurnTransport {
  state: PiSessionState = {
    sessionId: "pi-session-1",
    sessionFile: "/synthetic/pi-session.jsonl",
    provider: "synthetic-provider",
    modelId: "synthetic-model",
    thinkingLevel: harnessThinkingOptionIdSchema.parse("high"),
    contextUsage: { contextUsedTokens: 40, contextWindowTokens: 200 },
  };
  readonly abort = vi.fn(async () => undefined);
  readonly respondToInteraction = vi.fn(async (response: PiInteractionResponse) => {
    this.event({
      type: "interaction.closed",
      requestId: response.requestId,
      reason: "cancelled" in response ? "cancelled" : "responded",
    });
  });
  readonly start = vi.fn(async () => undefined);
  readonly getAvailableModels = vi.fn(async () => [
    { provider: "synthetic-provider", id: "synthetic-model", reasoning: true },
    { provider: "synthetic-provider", id: "alternate-model", reasoning: false },
  ]);
  readonly getAvailableThinkingLevels = vi.fn<() => Promise<HarnessThinkingOptionId[] | null>>(
    async () =>
      this.state.modelId === "alternate-model"
        ? [harnessThinkingOptionIdSchema.parse("off"), harnessThinkingOptionIdSchema.parse("low")]
        : [
            harnessThinkingOptionIdSchema.parse("off"),
            harnessThinkingOptionIdSchema.parse("low"),
            harnessThinkingOptionIdSchema.parse("high"),
          ],
  );
  readonly getEntries = vi.fn(async (): Promise<PiSessionHistory> => structuredClone(this.history));
  readonly getSessionUsage = vi.fn(async (): Promise<HostUsage | null> =>
    this.usage === null ? null : structuredClone(this.usage),
  );
  readonly fork = vi.fn(async (entryId: string) => {
    const cutoff = this.history.entries.findIndex((entry) => entry.id === entryId);
    if (cutoff < 0) throw new Error("Unknown synthetic Fork Entry");
    this.history.entries = this.history.entries.slice(0, cutoff);
    this.history.leafId =
      typeof this.history.entries.at(-1)?.id === "string"
        ? (this.history.entries.at(-1)?.id as string)
        : null;
    return this.deriveState();
  });
  readonly clone = vi.fn(async () => this.deriveState());
  readonly verifySessionCwd = vi.fn(async () => undefined);
  readonly selectModel = vi.fn(async (model: { provider: string; id: string }) => {
    this.state = {
      ...this.state,
      provider: model.provider,
      modelId: model.id,
      ...(model.id === "alternate-model"
        ? { thinkingLevel: harnessThinkingOptionIdSchema.parse("low") }
        : {}),
    };
    return this.state;
  });
  readonly selectThinkingOption = vi.fn(async (thinkingOptionId: HarnessThinkingOptionId) => {
    const available = (await this.getAvailableThinkingLevels()) ?? [
      harnessThinkingOptionIdSchema.parse("off"),
    ];
    const effective = available.includes(thinkingOptionId)
      ? thinkingOptionId
      : (available.at(-1) ?? harnessThinkingOptionIdSchema.parse("off"));
    this.state = { ...this.state, thinkingLevel: effective };
    return this.state;
  });
  readonly close = vi.fn(async () => {
    this.fail(new Error("Fake Pi transport closed"));
  });
  readonly runTurn = vi.fn((text: string, onEvent: (event: PiTurnEvent) => void) => {
    this.text = text;
    this.onEvent = onEvent;
    return new Promise<PiTurnResult>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
    });
  });
  history: PiSessionHistory = { entries: [], leafId: null };
  onEvent: ((event: PiTurnEvent) => void) | null = null;
  assistantMessageId: string | null = null;
  assistantMessageOrdinal = 0;
  options: PiRpcSessionOptions | null = null;
  rejectTurn: ((error: Error) => void) | null = null;
  resolveTurn: ((value: PiTurnResult) => void) | null = null;
  text: string | null = null;
  usage: HostUsage | null = {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    contextUsedTokens: 40,
    contextWindowTokens: 200,
  };

  event(event: PiTurnEvent): void {
    if (!this.onEvent) throw new Error("No active fake Pi Turn");
    this.onEvent(event);
  }

  delta(text: string, messageId?: string): void {
    if (messageId) {
      this.assistantMessageId = messageId;
    } else if (this.assistantMessageId === null) {
      this.assistantMessageOrdinal += 1;
      this.assistantMessageId = `synthetic-message-${this.assistantMessageOrdinal}`;
    }
    if (!this.assistantMessageId) throw new Error("No fake Assistant message identity");
    this.event({ type: "text.delta", messageId: this.assistantMessageId, delta: text });
  }

  message(text: string): void {
    this.assistantMessageOrdinal += 1;
    this.delta(text, `synthetic-message-${this.assistantMessageOrdinal}`);
    this.assistantMessageId = null;
  }

  succeed(text: string, cancelled = false): void {
    if (!this.resolveTurn || this.text === null) throw new Error("No active fake Pi Turn");
    this.assistantMessageId = null;
    const ordinal = this.history.entries.filter(
      (entry) =>
        entry.type === "message" &&
        (entry.message as { role?: unknown } | undefined)?.role === "user",
    ).length;
    const userId = `synthetic-user-${ordinal + 1}`;
    const assistantId = `synthetic-assistant-${ordinal + 1}`;
    this.history.entries.push(
      {
        id: userId,
        parentId: this.history.leafId,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: this.text }] },
      },
      {
        id: assistantId,
        parentId: userId,
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: cancelled ? "aborted" : "stop",
        },
      },
    );
    this.history.leafId = assistantId;
    this.resolveTurn({ text, cancelled });
    this.resetTurn();
  }

  fail(error: Error): void {
    if (!this.rejectTurn) return;
    this.rejectTurn(error);
    this.resetTurn();
  }

  fault(error: PiRpcFaultError): void {
    this.fail(error);
    this.options?.onFault?.(error);
  }

  private deriveState(): PiSessionState {
    this.state = {
      ...this.state,
      sessionId: `${this.state.sessionId}-derived`,
      sessionFile: `${this.state.sessionFile}.derived`,
    };
    return this.state;
  }

  private resetTurn(): void {
    this.onEvent = null;
    this.assistantMessageId = null;
    this.rejectTurn = null;
    this.resolveTurn = null;
  }
}

function fixture(options: PiAdapterOptions = {}) {
  const transports: FakePiTransport[] = [];
  const dependencies: PiAdapterDependencies = {
    createTransport: vi.fn((sessionOptions) => {
      const transport = new FakePiTransport();
      transport.options = sessionOptions;
      if (sessionOptions.model) {
        transport.state = {
          ...transport.state,
          provider: sessionOptions.model.provider,
          modelId: sessionOptions.model.id,
          thinkingLevel:
            sessionOptions.model.id === "alternate-model"
              ? harnessThinkingOptionIdSchema.parse("low")
              : transport.state.thinkingLevel,
        };
      }
      transports.push(transport);
      return transport;
    }),
  };
  const adapter = new PiAdapter(options, dependencies);
  return { adapter, dependencies, transports };
}

function sourceHistory(turnCount = 2): PiSessionHistory {
  const entries: PiSessionHistory["entries"] = [];
  let parentId: string | null = null;
  for (let index = 1; index <= turnCount; index += 1) {
    const userId = `source-user-${index}`;
    const assistantId = `source-assistant-${index}`;
    entries.push(
      {
        id: userId,
        parentId,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `question ${index}` }] },
      },
      {
        id: assistantId,
        parentId: userId,
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: `answer ${index}` }],
        },
      },
    );
    parentId = assistantId;
  }
  return { entries, leafId: parentId };
}

async function openSession(adapter: PiAdapter): Promise<HarnessSession> {
  const result = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function textTurn(id: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: id }],
  };
}

function cancelTurn(id: string) {
  return { type: "turn.cancel" as const, turnId: hostTurnIdSchema.parse(id) };
}

async function nextOutput(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput> {
  const result = await iterator.next();
  if (result.done) throw new Error("Harness output stream ended unexpectedly");
  return result.value;
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const output = await nextOutput(iterator);
  if (output.kind !== "event") throw new Error("Expected a Harness event output");
  return output.event;
}

async function nextInteraction(
  iterator: AsyncIterator<HarnessOutput>,
): Promise<HostQuestionInteraction> {
  const output = await nextOutput(iterator);
  if (output.kind !== "interaction" || output.interaction.type !== "question") {
    throw new Error("Expected a Harness Question output");
  }
  return output.interaction;
}

describe("Pi HarnessAdapter Session", () => {
  it("inspects the native catalog through an ephemeral transport and closes it", async () => {
    const { adapter, dependencies, transports } = fixture();

    await expect(adapter.inspect({ cwd: "/synthetic", refresh: true })).resolves.toMatchObject({
      status: "ready",
      catalog: {
        models: [
          { label: "synthetic-provider / alternate-model" },
          { label: "synthetic-provider / synthetic-model" },
        ],
        defaultModel: encodePiModelRef({
          provider: "synthetic-provider",
          id: "synthetic-model",
        }),
        thinkingOptions: [
          { id: "off", label: "Off" },
          { id: "minimal", label: "Minimal" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
        defaultThinkingOptionId: "high",
      },
      capabilities: {
        configuration: { selectModel: true, selectThinkingOption: true },
        history: { fork: true, forkAcrossCwd: true },
      },
    });
    expect(dependencies.createTransport).toHaveBeenCalledOnce();
    expect(transports[0]?.getAvailableModels).toHaveBeenCalledOnce();
    expect(transports[0]?.getAvailableThinkingLevels).toHaveBeenCalledOnce();
    expect(transports[0]?.close).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("caches successful inspection by cwd, coalesces requests, and honors refresh", async () => {
    const { adapter, dependencies } = fixture();

    const first = adapter.inspect({ cwd: "/synthetic" });
    const concurrent = adapter.inspect({ cwd: "/synthetic" });
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "ready" }),
    ]);
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
    });
    expect(dependencies.createTransport).toHaveBeenCalledTimes(1);

    await expect(adapter.inspect({ cwd: "/synthetic", refresh: true })).resolves.toMatchObject({
      status: "ready",
    });
    await expect(adapter.inspect({ cwd: "/other" })).resolves.toMatchObject({ status: "ready" });
    expect(dependencies.createTransport).toHaveBeenCalledTimes(3);
    await adapter.close();
  });

  it("assigns unified Draft Thinking options from Model reasoning metadata", async () => {
    const { adapter, dependencies, transports } = fixture();

    const inspection = await adapter.inspect({ cwd: "/synthetic" });
    if (inspection.status !== "ready") throw new Error(inspection.error.message);
    expect(inspection.catalog.models).toEqual([
      expect.objectContaining({
        label: "synthetic-provider / alternate-model",
        supportedThinkingOptionIds: ["off"],
      }),
      expect.objectContaining({
        label: "synthetic-provider / synthetic-model",
        supportedThinkingOptionIds: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      }),
    ]);
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.not.objectContaining({ model: expect.anything() }),
    );
    expect(transports[0]?.selectModel).not.toHaveBeenCalled();
    expect(transports[0]?.close).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("keeps Model inspection ready when Thinking RPC discovery is unsupported", async () => {
    const { adapter, dependencies, transports } = fixture();
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.getAvailableThinkingLevels.mockResolvedValueOnce(null);
      transports.push(transport);
      return transport;
    });

    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      catalog: { thinkingOptions: [] },
      capabilities: {
        configuration: { selectModel: true, selectThinkingOption: false },
      },
    });
    expect(transports[0]?.close).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("closes the ephemeral transport when inspection fails", async () => {
    const { adapter, dependencies, transports } = fixture();
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.getAvailableModels.mockRejectedValueOnce(new Error("synthetic catalog failure"));
      transports.push(transport);
      return transport;
    });

    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "error",
      error: { code: "unavailable", message: "synthetic catalog failure" },
    });
    expect(transports[0]?.close).toHaveBeenCalledOnce();
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
    });
    expect(dependencies.createTransport).toHaveBeenCalledTimes(2);
    await adapter.close();
  });

  it("resumes a persisted Pi Session and reads its active-branch Snapshot", async () => {
    const { adapter, dependencies, transports } = fixture();
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.state = {
        ...transport.state,
        sessionId: "source-session",
        sessionFile: "/synthetic/source.jsonl",
      };
      transport.history = sourceHistory();
      transports.push(transport);
      return transport;
    });
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "source-session",
      locator: { sessionFile: "/synthetic/source.jsonl" },
      formatVersion: 1,
    });

    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/synthetic/source.jsonl" }),
    );
    expect(opened.value.initialUsage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      contextUsedTokens: 40,
      contextWindowTokens: 200,
    });
    expect(opened.value.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "source-session" },
      effectiveThinkingOptionId: "high",
      availableThinkingOptions: [
        { id: "off", label: "Off" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          { nativeTurnRef: { nativeTurnKey: "source-user-1" } },
          { nativeTurnRef: { nativeTurnKey: "source-user-2" } },
        ],
      },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("forks a middle Pi Turn into a target cwd before the next User Entry", async () => {
    const { adapter, dependencies, transports } = fixture();
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.state = {
        ...transport.state,
        sessionId: "target-startup-session",
        sessionFile: "/synthetic-worktree/target.jsonl",
      };
      transport.history = sourceHistory();
      transports.push(transport);
      return transport;
    });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "source-session",
      locator: { sessionFile: "/synthetic/source.jsonl" },
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "source-session",
      checkpointId: "source-user-1",
      formatVersion: 1,
    });

    const opened = await adapter.open({
      kind: "fork",
      cwd: "/synthetic-worktree",
      sourceRef,
      checkpoint,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/synthetic-worktree",
        forkSessionFile: "/synthetic/source.jsonl",
      }),
    );
    expect(transports[0]?.options).not.toHaveProperty("sessionFile");
    expect(transports[0]?.fork).toHaveBeenCalledWith("source-user-2");
    expect(transports[0]?.clone).not.toHaveBeenCalled();
    expect(transports[0]?.verifySessionCwd).toHaveBeenCalledWith("/synthetic-worktree");
    expect(opened.value.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "target-startup-session-derived" },
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ nativeTurnRef: { nativeTurnKey: "source-user-1" } }] },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("uses the native target-cwd clone for a tail and fails closed for an unknown Checkpoint", async () => {
    const { adapter, dependencies, transports } = fixture();
    vi.mocked(dependencies.createTransport).mockImplementation((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.state = {
        ...transport.state,
        sessionId: `target-startup-session-${transports.length + 1}`,
        sessionFile: `/synthetic-worktree/target-${transports.length + 1}.jsonl`,
      };
      transport.history = sourceHistory();
      transports.push(transport);
      return transport;
    });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "source-session",
      locator: { sessionFile: "/synthetic/source.jsonl" },
      formatVersion: 1,
    });
    const terminalCheckpoint = nativeCheckpointRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "source-session",
      checkpointId: "source-user-2",
      formatVersion: 1,
    });
    const cloned = await adapter.open({
      kind: "fork",
      cwd: "/synthetic-worktree",
      sourceRef,
      checkpoint: terminalCheckpoint,
    });
    if (!cloned.ok) throw new Error(cloned.error.message);
    expect(transports[0]?.clone).not.toHaveBeenCalled();
    expect(transports[0]?.fork).not.toHaveBeenCalled();
    expect(transports[0]?.verifySessionCwd).toHaveBeenCalledWith("/synthetic-worktree");
    expect(cloned.value.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "target-startup-session-1" },
    });
    await expect(cloned.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await cloned.value.close();

    const missingCheckpoint = nativeCheckpointRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "source-session",
      checkpointId: "missing",
      formatVersion: 1,
    });
    await expect(
      adapter.open({
        kind: "fork",
        cwd: "/synthetic-worktree",
        sourceRef,
        checkpoint: missingCheckpoint,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(transports[1]?.close).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("closes a Pi Fork startup that does not create a distinct Native Session", async () => {
    const { adapter, dependencies, transports } = fixture();
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.state = {
        ...transport.state,
        sessionId: "source-session",
        sessionFile: "/synthetic/source.jsonl",
      };
      transport.history = sourceHistory();
      transports.push(transport);
      return transport;
    });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "source-session",
      locator: { sessionFile: "/synthetic/source.jsonl" },
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "source-session",
      checkpointId: "source-user-2",
      formatVersion: 1,
    });

    await expect(
      adapter.open({
        kind: "fork",
        cwd: "/synthetic-worktree",
        sourceRef,
        checkpoint,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(transports[0]?.close).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("does not manufacture a Permission Mode capability", async () => {
    const { adapter, dependencies } = fixture();
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      capabilities: { configuration: { selectPermissionMode: false } },
    });
    await expect(
      adapter.open({
        kind: "create",
        cwd: "/synthetic",
        permissionModeId: harnessPermissionModeIdSchema.parse("default"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    const session = await openSession(adapter);
    expect(session.capabilities.configuration.selectPermissionMode).toBe(false);
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("default"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(dependencies.createTransport).toHaveBeenCalledOnce();
    await session.close();
  });

  it("starts lazily and emits an ordered successful text lifecycle", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await expect(session.execute(textTurn("turn-1"))).resolves.toEqual({
      ok: true,
      value: { turnId: "turn-1" },
    });
    const transport = transports[0];
    expect(transport?.start).toHaveBeenCalledOnce();
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");

    transport?.delta("hello");
    transport?.delta(" world");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "hello" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: " world" },
    });
    transport?.succeed("hello world");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "hello world" }, outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      observedForTurnId: "turn-1",
      usage: { totalTokens: 30, contextUsedTokens: 40, contextWindowTokens: 200 },
    });

    await session.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("keeps Assistant messages separate across interleaved Tool calls", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("message-boundaries"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    const firstStarted = await nextEvent(iterator);
    const transport = transports[0];
    if (!transport || firstStarted.type !== "item.started") {
      throw new Error("Fake transport or first Agent Item was not created");
    }

    transport.message("first");
    transport.event({ type: "tool.started", callId: "call-1", toolName: "read", arguments: {} });
    transport.event({
      type: "tool.completed",
      callId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "one" }] },
      isError: false,
    });
    transport.message("second");
    transport.event({ type: "tool.started", callId: "call-2", toolName: "read", arguments: {} });
    transport.event({
      type: "tool.completed",
      callId: "call-2",
      toolName: "read",
      result: { content: [{ type: "text", text: "two" }] },
      isError: false,
    });
    transport.message("third");
    transport.succeed("firstsecondthird");

    const events = [];
    for (let index = 0; index < 13; index += 1) events.push(await nextEvent(iterator));
    expect(
      events.map((event) => {
        if (event.type === "item.started") return `start:${event.item.type}`;
        if (event.type === "item.updated" && event.update.type === "text.append") {
          return `text:${event.update.text}`;
        }
        if (event.type === "item.completed") {
          const item = event.snapshot.item;
          return `complete:${item.type}${item.type === "agentMessage" ? `:${item.text}` : ""}`;
        }
        return event.type;
      }),
    ).toEqual([
      "text:first",
      "complete:agentMessage:first",
      "start:toolExecution",
      "complete:toolExecution",
      "start:agentMessage",
      "text:second",
      "complete:agentMessage:second",
      "start:toolExecution",
      "complete:toolExecution",
      "start:agentMessage",
      "text:third",
      "complete:agentMessage:third",
      "turn.completed",
    ]);
    const agentIds = [
      firstStarted.item.itemId,
      ...events.flatMap((event) =>
        event.type === "item.started" && event.item.type === "agentMessage"
          ? [event.item.itemId]
          : [],
      ),
    ];
    expect(new Set(agentIds).size).toBe(3);
    await session.close();
  });

  it("keeps visible reasoning in distinct per-message Item lifecycles", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("reasoning"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake transport was not created");

    transport.event({ type: "reasoning.delta", messageId: "reasoning-1", delta: "first " });
    const firstStarted = await nextEvent(iterator);
    expect(firstStarted).toMatchObject({ type: "item.started", item: { type: "reasoning" } });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "first " },
    });
    transport.event({ type: "reasoning.delta", messageId: "reasoning-1", delta: "analysis" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "analysis" },
    });
    transport.event({ type: "reasoning.completed", messageId: "reasoning-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "reasoning", text: "first analysis" } },
    });

    transport.event({
      type: "reasoning.delta",
      messageId: "reasoning-2",
      delta: "second analysis",
    });
    const secondStarted = await nextEvent(iterator);
    expect(secondStarted).toMatchObject({ type: "item.started", item: { type: "reasoning" } });
    expect(
      firstStarted.type === "item.started" && secondStarted.type === "item.started"
        ? firstStarted.item.itemId === secondStarted.item.itemId
        : true,
    ).toBe(false);
    await nextEvent(iterator);
    transport.event({ type: "reasoning.completed", messageId: "reasoning-2" });
    await nextEvent(iterator);
    transport.delta("answer", "reasoning-2");
    await nextEvent(iterator);
    transport.succeed("answer");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "answer" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("fails active Reasoning and Agent Items when native reconciliation fails", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("reasoning-conflict"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake transport was not created");
    transport.event({
      type: "reasoning.delta",
      messageId: "reasoning-conflict",
      delta: "visible",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.fail(new Error("reasoning conflict"));

    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "reasoning" }, outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { message: "reasoning conflict" } },
    });
    await session.close();
  });

  it("retains reliable Usage when a later refresh fails", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    expect(session.initialUsage).toBeNull();

    await session.execute(textTurn("usage-1"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.succeed("first");
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { totalTokens: 30 },
    });

    const transport = transports[0];
    if (!transport) throw new Error("Fake transport was not created");
    transport.getSessionUsage.mockRejectedValueOnce(new Error("synthetic Telemetry failure"));
    await session.execute(textTurn("usage-2"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.succeed("second");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await vi.waitFor(() => expect(transport.getSessionUsage).toHaveBeenCalledTimes(2));
    await session.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("drops an older Usage refresh after the effective Model changes", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("usage-generation"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake transport was not created");
    let resolveOld!: (usage: HostUsage) => void;
    transport.getSessionUsage.mockImplementationOnce(
      () => new Promise<HostUsage>((resolve) => (resolveOld = resolve)),
    );
    transport.succeed("done");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await vi.waitFor(() => expect(transport.getSessionUsage).toHaveBeenCalledOnce());

    const alternate = encodePiModelRef({
      provider: "synthetic-provider",
      id: "alternate-model",
    });
    transport.usage = {
      totalTokens: 5,
      contextUsedTokens: 8,
      contextWindowTokens: 400,
    };
    const selecting = session.execute({ type: "model.select", model: alternate });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alternate },
    });
    await expect(selecting).resolves.toMatchObject({ ok: true });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { totalTokens: 5, contextWindowTokens: 400 },
    });

    resolveOld({ totalTokens: 999, contextUsedTokens: 199, contextWindowTokens: 200 });
    await Promise.resolve();
    await session.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("applies a create Model before publishing state and starting the first Turn", async () => {
    const { adapter, transports } = fixture();
    const model = encodePiModelRef({
      provider: "synthetic-provider",
      id: "alternate-model",
    });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic", model });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("selected-first"))).resolves.toMatchObject({ ok: true });
    expect(transports[0]?.selectModel).toHaveBeenCalledWith({
      provider: "synthetic-provider",
      id: "alternate-model",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveModel: model,
        effectiveThinkingOptionId: "low",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
        ],
      },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.succeed("done");
    await session.close();
  });

  it("applies create Thinking and publishes Pi-corrected readback before the first Turn", async () => {
    const { adapter, transports } = fixture();
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      capabilities: { configuration: { selectThinkingOption: true } },
    });
    const model = encodePiModelRef({
      provider: "synthetic-provider",
      id: "alternate-model",
    });
    const requestedThinking = harnessThinkingOptionIdSchema.parse("xhigh");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model,
      thinkingOptionId: requestedThinking,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const iterator = opened.value.outputs[Symbol.asyncIterator]();

    await expect(opened.value.execute(textTurn("selected-thinking"))).resolves.toMatchObject({
      ok: true,
    });
    expect(transports[1]?.selectThinkingOption).toHaveBeenCalledWith(requestedThinking);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveModel: model,
        effectiveThinkingOptionId: "low",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
        ],
      },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[1]?.succeed("done");
    await opened.value.close();
  });

  it("selects an idle Model with state-before-result ordering and rejects active races", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("first"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.succeed("first");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);

    const alternate = encodePiModelRef({
      provider: "synthetic-provider",
      id: "alternate-model",
    });
    const selecting = session.execute({ type: "model.select", model: alternate });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveModel: alternate,
        effectiveThinkingOptionId: "low",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
        ],
      },
    });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(await nextEvent(iterator)).toEqual({ type: "session.usage.changed", usage: null });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { totalTokens: 30 },
    });

    await session.execute(textTurn("active"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await expect(
      session.execute({
        type: "model.select",
        model: encodePiModelRef({ provider: "synthetic-provider", id: "synthetic-model" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(transports[0]?.selectModel).toHaveBeenCalledOnce();
    transports[0]?.succeed("active");
    await session.close();
  });

  it("selects Thinking with corrected state-before-result ordering and rejects active races", async () => {
    const { adapter, transports } = fixture();
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      capabilities: { configuration: { selectThinkingOption: true } },
    });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("start-thinking"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[1]?.succeed("start-thinking");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);

    const xhigh = harnessThinkingOptionIdSchema.parse("xhigh");
    const selecting = session.execute({
      type: "thinking.select",
      thinkingOptionId: xhigh,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });

    await session.execute(textTurn("active-thinking"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("off"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(transports[1]?.selectThinkingOption).toHaveBeenCalledOnce();
    transports[1]?.succeed("active-thinking");
    await session.close();
  });

  it("rejects Turn acceptance while native Model selection is pending", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("start"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.succeed("start");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake transport was not created");

    let releaseSelection!: () => void;
    const selectionGate = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    transport.selectModel.mockImplementationOnce(async (model) => {
      await selectionGate;
      transport.state = {
        ...transport.state,
        provider: model.provider,
        modelId: model.id,
        thinkingLevel: harnessThinkingOptionIdSchema.parse("low"),
      };
      return transport.state;
    });
    const model = encodePiModelRef({ provider: "synthetic-provider", id: "alternate-model" });
    const selecting = session.execute({ type: "model.select", model });

    await expect(session.execute(textTurn("racing"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    releaseSelection();
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: model },
    });
    await session.close();
  });

  it("publishes actual readback on mismatch and faults uncertain selection state", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("start"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.succeed("start");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake transport was not created");

    transport.selectModel.mockImplementationOnce(async () => transport.state);
    const requested = encodePiModelRef({
      provider: "synthetic-provider",
      id: "alternate-model",
    });
    const mismatch = session.execute({ type: "model.select", model: requested });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveModel: encodePiModelRef({
          provider: "synthetic-provider",
          id: "synthetic-model",
        }),
      },
    });
    await expect(mismatch).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure", message: "Pi did not activate the requested Model" },
    });

    transport.selectModel.mockRejectedValueOnce(
      new PiRpcFaultError("protocolError", "synthetic uncertain Model state"),
    );
    await expect(
      session.execute({ type: "model.select", model: requested }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.faulted",
      error: { code: "protocolError" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects startup before Turn acceptance without lifecycle events", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.start.mockRejectedValueOnce(new Error("synthetic startup failure"));
      transports.push(transport);
      return transport;
    });

    const result = await session.execute(textTurn("rejected"));
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect((await nextEvent(iterator)).type).toBe("session.faulted");
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("completes an accepted failed Turn and remains reusable", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("turn-1"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);

    const nativeMessage = '503: {"message":"Service temporarily unavailable","type":"api_error"}';
    transports[0]?.fail(new Error(nativeMessage));
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        outcome: { status: "failed", error: { code: "nativeFailure", message: nativeMessage } },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: {
        status: "failed",
        error: { code: "nativeFailure", message: nativeMessage },
      },
    });

    await expect(session.execute(textTurn("turn-2"))).resolves.toMatchObject({ ok: true });
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    transports[0]?.succeed("second");
    await session.close();
  });

  it("maps interleaved Bash, Generic Tool, bounded output, and reliable Edit Patch", async () => {
    const { adapter, transports } = fixture({ toolOutputLimit: 10 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("tools"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];

    transport?.event({
      type: "tool.started",
      callId: "bash-1",
      toolName: "bash",
      arguments: { command: "printf complete" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "commandExecution", command: "printf complete" },
    });
    transport?.event({
      type: "tool.started",
      callId: "custom-1",
      toolName: "custom",
      arguments: { value: 1 },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "custom" },
    });
    transport?.event({
      type: "tool.updated",
      callId: "bash-1",
      output: { content: [{ type: "text", text: "abc" }] },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "output.append", text: "abc" },
    });
    transport?.event({
      type: "tool.updated",
      callId: "bash-1",
      output: { content: [{ type: "text", text: "abcdef" }] },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "output.append", text: "def" },
    });
    transport?.event({
      type: "tool.updated",
      callId: "bash-1",
      output: { content: [{ type: "text", text: "abcdefghijklmnop" }] },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "output.append", text: "ghij" },
    });
    transport?.event({
      type: "tool.updated",
      callId: "custom-1",
      output: { content: [{ type: "text", text: "0123456789overflow" }] },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "output.replace",
        output: { content: [{ text: "0123456789" }], truncated: true },
      },
    });
    transport?.event({
      type: "tool.completed",
      callId: "bash-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "abcdefghijklmnop" }], exitCode: 0 },
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "commandExecution",
          output: "abcdefghij",
          outputTruncated: true,
          exitCode: 0,
        },
        outcome: { status: "succeeded" },
      },
    });
    transport?.event({
      type: "tool.completed",
      callId: "custom-1",
      toolName: "custom",
      result: { content: [{ type: "text", text: "custom done" }] },
      isError: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed" } },
    });

    transport?.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "edit",
      arguments: { path: "sample.txt" },
    });
    await nextEvent(iterator);
    transport?.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "edited" }],
        details: {
          patch: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n",
        },
      },
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution", toolName: "edit" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "fileChange",
        changes: [
          { path: "sample.txt", kind: "update", unifiedDiff: expect.stringContaining("@@") },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "fileChange" }, outcome: { status: "succeeded" } },
    });

    transport?.delta("finished");
    await nextEvent(iterator);
    transport?.succeed("finished");
    await nextEvent(iterator);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("does not infer File Change for Write or an Edit without a valid Patch", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("no-patch"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];

    for (const [callId, toolName] of [
      ["write-1", "write"],
      ["edit-1", "edit"],
    ] as const) {
      transport?.event({ type: "tool.started", callId, toolName, arguments: {} });
      await nextEvent(iterator);
      transport?.event({
        type: "tool.completed",
        callId,
        toolName,
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.completed",
        snapshot: { item: { type: "toolExecution", toolName } },
      });
    }
    transport?.succeed("");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("maps a user Extension Tool-associated Pi select Question and returns the exact native answer", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("question"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];

    transport?.event({
      type: "tool.started",
      callId: "question-tool",
      toolName: "user_question_tool",
      arguments: {},
    });
    const toolStarted = await nextEvent(iterator);
    if (toolStarted.type !== "item.started") throw new Error("Question Tool did not start");
    transport?.event({
      type: "interaction.requested",
      request: {
        requestId: "native-question",
        method: "select",
        title: "Continue?",
        options: ["continue", "stop"],
        timeoutMs: 5_000,
      },
    });
    const interaction = await nextInteraction(iterator);
    expect(interaction).toMatchObject({
      type: "question",
      turnId: "question",
      itemId: toolStarted.item.itemId,
      title: "Pi",
      questions: [
        {
          id: "answer",
          type: "choice",
          prompt: "Continue?",
          options: [
            { value: "continue", label: "continue" },
            { value: "stop", label: "stop" },
          ],
        },
      ],
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { answer: ["continue"] } },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transport?.respondToInteraction).toHaveBeenCalledWith({
      requestId: "native-question",
      value: "continue",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: interaction.interactionId,
      reason: "responded",
    });

    transport?.event({
      type: "tool.completed",
      callId: "question-tool",
      toolName: "user_question_tool",
      result: { content: [{ type: "text", text: "answered" }] },
      isError: false,
    });
    await nextEvent(iterator);
    transport?.succeed("");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("maps confirm, input, and editor Questions without inferring Approval", async () => {
    for (const request of [
      {
        requestId: "confirm",
        method: "confirm" as const,
        title: "Confirm",
        message: "Proceed?",
      },
      {
        requestId: "input",
        method: "input" as const,
        title: "Value",
        placeholder: "type",
      },
      {
        requestId: "editor",
        method: "editor" as const,
        title: "Edit",
        prefill: "line 1\nline 2",
      },
    ]) {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn(`question-${request.method}`));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      transports[0]?.event({ type: "interaction.requested", request });
      const interaction = await nextInteraction(iterator);
      expect(interaction.type).toBe("question");
      expect(JSON.stringify(interaction)).not.toContain("approval");
      expect(interaction.itemId).toBeUndefined();
      if (request.method === "confirm") {
        expect(interaction.questions[0]).toMatchObject({
          type: "choice",
          prompt: "Proceed?",
        });
        await session.execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: { answer: ["yes"] } },
        });
        expect(transports[0]?.respondToInteraction).toHaveBeenCalledWith({
          requestId: "confirm",
          confirmed: true,
        });
      } else {
        expect(interaction.questions[0]).toMatchObject({
          type: "text",
          multiline: request.method === "editor",
        });
        await session.execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: { answer: ["value"] } },
        });
        expect(transports[0]?.respondToInteraction).toHaveBeenCalledWith({
          requestId: request.requestId,
          value: "value",
        });
      }
      await nextEvent(iterator);
      transports[0]?.succeed("");
      await nextEvent(iterator);
      await nextEvent(iterator);
      await session.close();
    }
  });

  it("rejects invalid and duplicate Pi Question responses", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("invalid-question"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.event({
      type: "interaction.requested",
      request: {
        requestId: "native-question",
        method: "select",
        title: "Choose",
        options: ["known"],
      },
    });
    const interaction = await nextInteraction(iterator);
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { answer: ["unknown"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await session.execute({
      type: "interaction.respond",
      interactionId: interaction.interactionId,
      response: { type: "question", answers: {}, cancelled: true },
    });
    await nextEvent(iterator);
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    transports[0]?.succeed("");
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("requests Abort idempotently, cancels active Items, and continues in the same Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("cancelled"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    transport?.event({
      type: "tool.started",
      callId: "long-1",
      toolName: "long_tool",
      arguments: {},
    });
    await nextEvent(iterator);
    transport?.event({
      type: "interaction.requested",
      request: {
        requestId: "cancel-question",
        method: "select",
        title: "Continue?",
        options: ["yes", "no"],
      },
    });
    const cancelledInteraction = await nextInteraction(iterator);

    await expect(session.execute(cancelTurn("cancelled"))).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    await expect(session.execute(cancelTurn("cancelled"))).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport?.abort).toHaveBeenCalledOnce();
    transport?.event({
      type: "interaction.closed",
      requestId: "cancel-question",
      reason: "cancelled",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: cancelledInteraction.interactionId,
      reason: "cancelled",
    });
    transport?.event({
      type: "tool.completed",
      callId: "long-1",
      toolName: "long_tool",
      result: { content: [{ type: "text", text: "cancelled" }] },
      isError: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    transport?.succeed("", true);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    await expect(session.execute(textTurn("continued"))).resolves.toMatchObject({ ok: true });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport?.delta("continued");
    await nextEvent(iterator);
    transport?.succeed("continued");
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(transport?.start).toHaveBeenCalledOnce();
    await session.close();
  });

  it("fails the Turn and faults the Session when Abort is rejected", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("cancel failure"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    transport?.abort.mockRejectedValueOnce(new Error("synthetic Abort rejection"));

    await expect(session.execute(cancelTurn("cancel failure"))).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed" },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "session.faulted" });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(transport?.close).toHaveBeenCalledOnce();
    await session.close();
  });

  it("rejects a concurrent Turn while transport startup is reserved", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    let releaseStart!: () => void;
    const startGate = new Promise<undefined>((resolve) => {
      releaseStart = () => resolve(undefined);
    });
    vi.mocked(dependencies.createTransport).mockImplementationOnce((options) => {
      const transport = new FakePiTransport();
      transport.options = options;
      transport.start.mockImplementationOnce(() => startGate);
      transports.push(transport);
      return transport;
    });

    const first = session.execute(textTurn("first"));
    const second = session.execute(textTurn("second"));
    releaseStart();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    transports[0]?.succeed("done");
    await session.close();
  });

  it("finishes the active lifecycle before faulting the Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("faulted"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.event({
      type: "interaction.requested",
      request: {
        requestId: "fault-question",
        method: "input",
        title: "Value",
      },
    });
    await nextInteraction(iterator);

    transports[0]?.fault(new PiRpcFaultError("processExited", "synthetic process exit"));
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    expect((await nextEvent(iterator)).type).toBe("session.faulted");
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("fails an active Turn once when close cannot prove cancellation settlement", async () => {
    const { adapter, transports } = fixture({ closeTimeoutMs: 5 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("closing"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.event({
      type: "interaction.requested",
      request: {
        requestId: "close-question",
        method: "editor",
        title: "Value",
      },
    });
    await nextInteraction(iterator);

    await session.close();
    expect(transports[0]?.abort).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("starts the native transport without injecting a codexhost Extension", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    await session.execute(textTurn("native-capabilities-only"));
    expect(transports[0]?.options).toMatchObject({ cwd: "/synthetic" });
    expect(transports[0]?.options).not.toHaveProperty("extensionPath");
    transports[0]?.succeed("done");
    await session.close();
  });

  it("does not create a transport for unused prewarm and closes idempotently", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter);

    await expect(Promise.all([session.close(), session.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await expect(Promise.all([adapter.close(), adapter.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
