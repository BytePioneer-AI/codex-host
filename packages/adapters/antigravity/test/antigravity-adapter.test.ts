import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityAdapter, normalizeAntigravityError } from "../src/antigravity-adapter.js";
import {
  AntigravityTransportError,
  type AntigravityAcpConfigOption,
  type AntigravityAcpEvent,
  type AntigravityAcpTransportLike,
  type AntigravityAcpTransportOptions,
  type AntigravityActivePromptHandler,
  type AntigravityOpenAcpSessionInput,
  type AntigravityPromptInputPart,
  type AntigravityPromptResult,
  type AntigravitySessionEventHandler,
} from "../src/acp-types.js";
import * as projection from "../src/acp-projection.js";
import * as models from "../src/model-catalog.js";
import * as nativeFork from "../src/fork.js";
import { AntigravitySessionUsageTracker } from "../src/acp-usage.js";

const mode = harnessPermissionModeIdSchema.parse;
const model = (id: string) => harnessModelRefSchema.parse({ id });
const thinking = harnessThinkingOptionIdSchema.parse;
const turnId = hostTurnIdSchema.parse;
const ref = (id: string = randomUUID(), locator?: object) =>
  nativeSessionRefSchema.parse({
    harnessId: "antigravity",
    nativeSessionId: id,
    formatVersion: 1,
    ...(locator ? { locator } : {}),
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const config = (): AntigravityAcpConfigOption[] => [
  {
    id: "model",
    category: "model",
    name: "Model",
    currentValue: "gemini",
    options: [
      { value: "gemini", name: "Gemini" },
      { value: "claude", name: "Claude" },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];
class FakeTransport implements AntigravityAcpTransportLike {
  sessionId: string | null = null;
  isClosed = false;
  get skipPermissions() {
    return this.options.skipPermissions === true;
  }
  eventHandler: AntigravitySessionEventHandler | null = null;
  handler?: AntigravityActivePromptHandler;
  parts?: readonly AntigravityPromptInputPart[];
  result = deferred<AntigravityPromptResult>();
  config = config();
  replayedEvents: AntigravityAcpEvent[] = [];
  constructor(readonly options: AntigravityAcpTransportOptions) {}
  initialize = vi.fn(async (): Promise<InitializeResponse> => ({
    protocolVersion: 1,
    agentCapabilities: {},
  }));
  setSessionEventHandler(handler: AntigravitySessionEventHandler | null) {
    this.eventHandler = handler;
  }
  openSession = vi.fn(async (input: AntigravityOpenAcpSessionInput) => {
    this.sessionId = input.sessionId ?? randomUUID();
    return {
      opened: {
        sessionId: this.sessionId,
        configOptions: this.config,
        modes: { currentModeId: "default", availableModes: [] },
      },
      replayedEvents: this.replayedEvents,
    };
  });
  setMode = vi.fn(async (value: string) => {
    void value;
  });
  setConfigOption = vi.fn(async (id: string, value: string) => {
    this.config = this.config.map((entry) =>
      entry.id === id ? { ...entry, currentValue: value } : entry,
    );
    return this.config;
  });
  prompt = vi.fn(
    (parts: readonly AntigravityPromptInputPart[], handler: AntigravityActivePromptHandler) => {
      this.parts = parts;
      this.handler = handler;
      return this.result.promise;
    },
  );
  cancel = vi.fn(async () => {});
  closeSession = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.isClosed = true;
    this.result.resolve({ stopReason: "cancelled" });
  });
}
const adapters: AntigravityAdapter[] = [];
const directories: string[] = [];
function fixture(options: ConstructorParameters<typeof AntigravityAdapter>[0] = {}) {
  const transports: FakeTransport[] = [];
  const adapter = new AntigravityAdapter({
    ...options,
    createTransport: (input) => {
      const transport = new FakeTransport(input);
      transports.push(transport);
      return transport;
    },
  });
  adapters.push(adapter);
  return { adapter, transports };
}
async function sessionOf(result: Awaited<ReturnType<AntigravityAdapter["open"]>>) {
  if (!result.ok) throw new Error(result.error.message);
  const outputs: HarnessOutput[] = [];
  void (async () => {
    for await (const output of result.value.outputs) outputs.push(output);
  })();
  return { session: result.value, outputs };
}
function required<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
const events = (outputs: HarnessOutput[]) =>
  outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
async function start(session: HarnessSession, transports: FakeTransport[], id = "t1") {
  expect(
    await session.execute({
      type: "turn.start",
      turnId: turnId(id),
      input: [{ type: "text", text: "hello" }],
    }),
  ).toEqual({ ok: true, value: { turnId: id } });
  await vi.waitFor(() => expect(transports.at(-1)?.handler).toBeDefined());
  return required(transports.at(-1));
}
async function completed(outputs: HarnessOutput[], id = "t1") {
  await vi.waitFor(() =>
    expect(
      events(outputs).filter((event) => event.type === "turn.completed" && event.turnId === id),
    ).toHaveLength(1),
  );
}
beforeEach(() => {
  vi.spyOn(models, "readAcpEffectiveModelState").mockImplementation((entries) => {
    const selectedModel = entries?.find((entry) => entry.id === "model")?.currentValue;
    const effort = entries?.find((entry) => entry.id === "thought_level")?.currentValue;
    return {
      ...(selectedModel ? { effectiveModel: model(selectedModel) } : {}),
      ...(effort ? { effectiveThinkingOptionId: thinking(effort) } : {}),
    };
  });
  vi.spyOn(projection, "projectReplayedEventsToTurns").mockImplementation(
    ({ nativeSessionId, events: replay, knownTurnRefs }) =>
      replay
        .filter((event) => event.type === "user.text")
        .map((event, index) => ({
          nativeTurnRef: knownTurnRefs?.[index] ?? {
            ...ref(nativeSessionId),
            nativeTurnKey: `turn-${index}`,
          },
          input: [{ type: "text", text: event.text }],
          items: [],
          outcome: { status: "succeeded" },
        })),
  );
  vi.spyOn(projection.AntigravityToolTracker.prototype, "finishPending").mockImplementation(
    () => {},
  );
  vi.spyOn(projection.AntigravityToolTracker.prototype, "handleToolEvent").mockImplementation(
    () => {},
  );
  vi.spyOn(AntigravitySessionUsageTracker.prototype, "replayHistoricalRequests").mockResolvedValue({
    requests: [],
    complete: true,
    usage: null,
  });
  vi.spyOn(
    AntigravitySessionUsageTracker.prototype,
    "collectNewTranscriptRequests",
  ).mockResolvedValue({ requests: [], complete: true, usage: null });
  vi.spyOn(AntigravitySessionUsageTracker.prototype, "recordTurnPromptUsage").mockReturnValue({
    usage: { inputTokens: 10, outputTokens: 2 },
  });
  vi.spyOn(AntigravitySessionUsageTracker.prototype, "recordContextWindow").mockImplementation(
    (used, size) => ({ contextUsedTokens: used, contextWindowTokens: size }),
  );
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("Antigravity ACP Session", () => {
  it("prewarms without a transport or persistent identity, then closes idempotently", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(await adapter.open({ kind: "create", cwd: process.cwd() }));
    expect(transports).toHaveLength(0);
    expect(session.initialState.nativeRef).toBeUndefined();
    await session.close();
    await session.close();
    expect(transports).toHaveLength(0);
    expect(await session.execute({ type: "turn.cancel", turnId: turnId("x") })).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });
  it("does not claim native confirmation for configuration on an unopened draft", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd(), model: model("claude") }),
    );
    expect(await session.execute({ type: "model.select", model: model("gemini") })).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(session.initialState.effectiveModel).toBeUndefined();
    expect(transports).toHaveLength(0);
    const transport = await start(session, transports);
    expect(transport.setConfigOption).toHaveBeenCalledWith("model", "claude");
    expect(session.initialState.effectiveModel).toEqual(model("claude"));
  });
  it("does not let usage observation failure turn a successful prompt into failure", async () => {
    vi.mocked(
      AntigravitySessionUsageTracker.prototype.collectNewTranscriptRequests,
    ).mockRejectedValueOnce(new Error("unreadable transcript"));
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    const transport = await start(session, transports);
    transport.result.resolve({ stopReason: "end_turn" });
    await completed(outputs);
    expect(events(outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      outcome: { status: "succeeded" },
    });
    expect(events(outputs)).toContainEqual({ type: "usage.history", complete: false });
  });
  it("closes in-flight initialization without opening a native conversation", async () => {
    const gate = deferred<InitializeResponse>();
    let transport: FakeTransport | undefined;
    const adapter = new AntigravityAdapter({
      createTransport: (options) => {
        transport = new FakeTransport(options);
        transport.initialize.mockReturnValue(gate.promise);
        return transport;
      },
    });
    adapters.push(adapter);
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    await session.execute({
      type: "turn.start",
      turnId: turnId("t1"),
      input: [{ type: "text", text: "hello" }],
    });
    await vi.waitFor(() => expect(transport).toBeDefined());
    await session.close();
    gate.resolve({ protocolVersion: 1, agentCapabilities: {} });
    await completed(outputs);
    expect(required(transport).openSession).not.toHaveBeenCalled();
    expect(required(transport).prompt).not.toHaveBeenCalled();
  });
  it("retries a failed close rather than permanently caching its rejection", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    const transport = await start(session, transports);
    transport.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(session.close()).rejects.toThrow("close failed");
    await session.close();
    await session.close();
    expect(transport.close).toHaveBeenCalledTimes(2);
    await completed(outputs);
    expect(events(outputs).filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });
  it("locks the idle source while native history derivation is awaiting I/O", async () => {
    const gate = deferred<Awaited<ReturnType<typeof nativeFork.forkAntigravitySession>>>();
    const derive = vi.spyOn(nativeFork, "forkAntigravitySession").mockReturnValue(gate.promise);
    const { adapter, transports } = fixture();
    const nativeRef = ref();
    const { session } = await sessionOf(
      await adapter.open({ kind: "resume", nativeRef, cwd: process.cwd() }),
    );
    const forked = adapter.open({
      kind: "fork",
      sourceRef: nativeRef,
      checkpoint: { ...nativeRef, checkpointId: "turn-0" },
      cwd: process.cwd(),
    });
    await vi.waitFor(() => expect(derive).toHaveBeenCalledOnce());
    expect(
      await session.execute({
        type: "turn.start",
        turnId: turnId("blocked"),
        input: [{ type: "text", text: "next" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    gate.resolve({
      ok: false,
      error: { code: "nativeFailure", message: "derivation failed", retryable: false },
    });
    await forked;
    await start(session, transports);
  });
  it("streams ordered text/reasoning, usage and stable Turn identity", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    const transport = await start(session, transports);
    const handler = required(transport.handler);
    handler.onEvent({ type: "agent.thought", text: "reason" });
    handler.onEvent({ type: "agent.text", text: "hel" });
    handler.onEvent({ type: "agent.text", text: "lo" });
    handler.onEvent({ type: "usage.context", used: 10, size: 100 });
    transport.result.resolve({
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    await completed(outputs);
    const stream = events(outputs);
    expect(
      stream.filter((event) => event.type === "item.completed").map((event) => event.snapshot.item),
    ).toMatchObject([
      { type: "reasoning", text: "reason" },
      { type: "agentMessage", text: "hello" },
    ]);
    expect(stream.find((event) => event.type === "turn.completed")).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "turn-0" },
      outcome: { status: "succeeded", checkpoint: { checkpointId: "turn-0" } },
    });
    expect(stream).toContainEqual({
      type: "session.usage.changed",
      usage: { contextUsedTokens: 10, contextWindowTokens: 100 },
    });
    expect(AntigravitySessionUsageTracker.prototype.recordTurnPromptUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        firstOutputAtMs: expect.any(Number),
        completedAtMs: expect.any(Number),
      }),
    );
    const terminal = stream.find((event) => event.type === "turn.completed");
    expect(nativeTurnRefSchema.safeParse(terminal?.nativeTurnRef).success).toBe(true);
    expect(stream.filter((event) => event.type === "turn.started")).toHaveLength(1);
  });
  it("rejects busy/empty turns and foreign cancellation without extra lifecycle events", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    expect(
      await session.execute({ type: "turn.start", turnId: turnId("empty"), input: [] }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    const transport = await start(session, transports);
    expect(
      await session.execute({
        type: "turn.start",
        turnId: turnId("second"),
        input: [{ type: "text", text: "next" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(await session.execute({ type: "turn.cancel", turnId: turnId("other") })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(transport.cancel).not.toHaveBeenCalled();
    expect(events(outputs).filter((event) => event.type === "turn.started")).toHaveLength(1);
  });
  it("waits for cancellation terminal confirmation and isolates late callbacks from the next Turn", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    const transport = await start(session, transports);
    const oldHandler = required(transport.handler);
    await session.execute({ type: "turn.cancel", turnId: turnId("t1") });
    expect(events(outputs).filter((event) => event.type === "turn.completed")).toHaveLength(0);
    transport.result.resolve({ stopReason: "cancelled" });
    await completed(outputs);
    transport.result = deferred();
    await start(session, transports, "t2");
    oldHandler.onEvent({ type: "agent.text", text: "late" });
    required(transport.handler).onEvent({ type: "agent.text", text: "new" });
    transport.result.resolve({ stopReason: "end_turn" });
    await completed(outputs, "t2");
    expect(
      events(outputs)
        .filter((event) => event.type === "item.completed")
        .map((event) => event.snapshot.item),
    ).toMatchObject([{ text: "new" }]);
  });
  it("waits for config confirmation before publishing the effective selection", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(await adapter.open({ kind: "create", cwd: process.cwd() }));
    const transport = await start(session, transports);
    const gate = deferred<AntigravityAcpConfigOption[]>();
    transport.setConfigOption.mockReturnValueOnce(gate.promise);
    const selected = session.execute({ type: "model.select", model: model("claude") });
    await vi.waitFor(() => expect(transport.setConfigOption).toHaveBeenCalled());
    expect(session.initialState.effectiveModel).toEqual(model("gemini"));
    gate.resolve(
      config().map((entry) =>
        entry.id === "model" ? { ...entry, currentValue: "claude" } : entry,
      ),
    );
    expect((await selected).ok).toBe(true);
    expect(session.initialState.effectiveModel).toEqual(model("claude"));
  });
  it("selects Model and Thinking during a Turn only after native confirmation", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    const transport = await start(session, transports);
    expect((await session.execute({ type: "model.select", model: model("claude") })).ok).toBe(true);
    expect(
      (await session.execute({ type: "thinking.select", thinkingOptionId: thinking("high") })).ok,
    ).toBe(true);
    expect(session.initialState).toMatchObject({
      effectiveModel: model("claude"),
      effectiveThinkingOptionId: "high",
    });
    transport.setConfigOption.mockRejectedValueOnce(
      new AntigravityTransportError("unavailable", "failed"),
    );
    expect((await session.execute({ type: "model.select", model: model("gemini") })).ok).toBe(
      false,
    );
    expect(session.initialState.effectiveModel).toEqual(model("claude"));
    expect(events(outputs).some((event) => event.type === "session.state.changed")).toBe(true);
  });
  it("restarts only across Skip permissions, keeps identity, and rejects a busy restart", async () => {
    const { adapter, transports } = fixture();
    const nativeRef = ref();
    const { session } = await sessionOf(
      await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef }),
    );
    expect(
      (await session.execute({ type: "permissionMode.select", permissionModeId: mode("plan") })).ok,
    ).toBe(true);
    expect(transports[0]?.setMode).toHaveBeenCalledWith("plan");
    expect(
      (
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: mode("dangerously-skip-permissions"),
        })
      ).ok,
    ).toBe(true);
    expect(transports[0]?.close).toHaveBeenCalledTimes(1);
    expect(transports[1]?.skipPermissions).toBe(true);
    expect(transports[1]?.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resume", sessionId: nativeRef.nativeSessionId }),
    );
    expect(
      (await session.execute({ type: "permissionMode.select", permissionModeId: mode("default") }))
        .ok,
    ).toBe(true);
    expect(transports[2]?.skipPermissions).toBe(false);
    await start(session, transports);
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: mode("dangerously-skip-permissions"),
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(transports).toHaveLength(3);
  });
  it("restores the original connection after a failed Skip permissions restart", async () => {
    const transports: FakeTransport[] = [];
    const adapter = new AntigravityAdapter({
      createTransport: (options) => {
        const transport = new FakeTransport(options);
        transports.push(transport);
        if (transports.length === 2)
          transport.initialize.mockRejectedValueOnce(
            new AntigravityTransportError("unavailable", "cannot launch"),
          );
        return transport;
      },
    });
    adapters.push(adapter);
    const nativeRef = ref();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "resume", nativeRef, cwd: process.cwd() }),
    );
    expect(
      (
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: mode("dangerously-skip-permissions"),
        })
      ).ok,
    ).toBe(false);
    expect(transports).toHaveLength(3);
    expect(transports[2]?.skipPermissions).toBe(false);
    expect(session.initialState.nativeRef?.nativeSessionId).toBe(nativeRef.nativeSessionId);
    transports[0]?.options.onFault?.(
      new AntigravityTransportError("processExited", "old connection exited"),
    );
    expect(events(outputs).some((event) => event.type === "session.faulted")).toBe(false);
    await start(session, transports);
  });
  it("preserves unattended execution and rejects conflicting create/resume hints", async () => {
    const { adapter, transports } = fixture();
    expect(
      await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
        permissionModeId: mode("plan"),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    const { session } = await sessionOf(
      await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
      }),
    );
    const transport = await start(session, transports);
    expect(transport.skipPermissions).toBe(true);
    expect(session.initialState.nativeRef?.locator).toMatchObject({
      executionPolicy: "unattended-full-access",
    });
    const nativeRef = required(session.initialState.nativeRef);
    transport.result.resolve({ stopReason: "end_turn" });
    await session.close();
    expect((await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef })).ok).toBe(true);
    expect(transports.at(-1)?.skipPermissions).toBe(true);
    expect(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef,
        permissionModeId: mode("auto"),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
  });
  it("propagates merged Session environment and only variable names in delegation instructions", async () => {
    const { adapter, transports } = fixture({
      environment: {
        CODEXHOST_CLI_PATH: "private-cli",
        CODEXHOST_RUNTIME_ENDPOINT: "private-endpoint",
        CODEXHOST_RUNTIME_TOKEN: "secret-token",
        CODEXHOST_THREAD_ID: "base",
      },
    });
    await adapter.open({
      kind: "resume",
      cwd: process.cwd(),
      nativeRef: ref(),
      environment: { CODEXHOST_THREAD_ID: "thread-override" },
    });
    const transport = required(transports[0]);
    expect(transport.options.environment?.CODEXHOST_THREAD_ID).toBe("thread-override");
    const prompt = required(transport.openSession.mock.calls[0]?.[0].systemPromptAppend);
    for (const value of ["private-cli", "private-endpoint", "secret-token", "thread-override"])
      expect(prompt).not.toContain(value);
    expect(prompt).toContain("CODEXHOST_RUNTIME_TOKEN");
  });
  it("loads history on a temporary connection even during an active Turn, without prompting", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(
      await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    await start(session, transports);
    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    const reader = required(transports[1]);
    expect(reader.openSession.mock.calls[0]?.[0].kind).toBe("load");
    expect(reader.prompt).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalledOnce();
    reader.options.onFault?.(
      new AntigravityTransportError("processExited", "read-only connection died"),
    );
    expect(
      (await session.execute({ type: "thinking.select", thinkingOptionId: thinking("high") })).ok,
    ).toBe(true);
  });
  it("applies resume configuration hints and rejects native identity mismatch", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: ref(),
        model: model("claude"),
        thinkingOptionId: thinking("high"),
        permissionModeId: mode("auto"),
      }),
    );
    expect(session.initialState).toMatchObject({
      effectiveModel: model("claude"),
      effectiveThinkingOptionId: "high",
      effectivePermissionModeId: "auto",
    });
    expect(transports[0]?.setConfigOption.mock.calls).toEqual([
      ["model", "claude"],
      ["thought_level", "high"],
    ]);
    const broken = new AntigravityAdapter({
      createTransport: (input) => {
        const transport = new FakeTransport(input);
        transport.openSession.mockImplementation(async () => ({
          opened: {
            sessionId: randomUUID(),
            configOptions: config(),
            modes: { currentModeId: "default", availableModes: [] },
          },
          replayedEvents: [],
        }));
        return transport;
      },
    });
    adapters.push(broken);
    expect(
      await broken.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    ).toMatchObject({ ok: false, error: { code: "protocolError" } });
  });
  it("accepts slash commands and inline images through the same ACP prompt path", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    expect(
      (
        await required(session.commands).execute({
          turnId: turnId("command"),
          commandId: "antigravity.plan",
          arguments: { text: "work" },
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() =>
      expect(transports[0]?.parts).toEqual([{ type: "text", text: "/plan work" }]),
    );
    const transport = required(transports[0]);
    transport.result.resolve({ stopReason: "end_turn" });
    await completed(outputs, "command");
    transport.result = deferred();
    await session.execute({
      type: "turn.start",
      turnId: turnId("image"),
      input: [{ type: "text", text: "data:image/png;base64,YWJj" }],
    });
    await vi.waitFor(() =>
      expect(transports[0]?.parts).toEqual([
        { type: "image", mimeType: "image/png", data: "YWJj" },
      ]),
    );
  });
  it("faults once, completes the active Turn and ignores stale events", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    const transport = await start(session, transports);
    required(transport.handler).onEvent({ type: "agent.text", text: "partial" });
    const fault = required(transport.options.onFault);
    fault(new AntigravityTransportError("processExited", "gone"));
    fault(new AntigravityTransportError("processExited", "again"));
    required(transport.handler).onEvent({ type: "agent.text", text: "late" });
    await completed(outputs);
    expect(events(outputs).filter((event) => event.type === "session.faulted")).toHaveLength(1);
    expect(events(outputs).findIndex((event) => event.type === "turn.completed")).toBeLessThan(
      events(outputs).findIndex((event) => event.type === "session.faulted"),
    );
    expect(
      await session.execute({ type: "thinking.select", thinkingOptionId: thinking("high") }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
  });
});

describe("ACP interaction round trips", () => {
  beforeEach(() => {
    vi.spyOn(projection.AntigravityToolTracker.prototype, "rawToolInput").mockReturnValue({
      questions: [{ prompt: "Which?" }],
    });
    vi.spyOn(projection, "projectAcpApprovalInteraction").mockImplementation(
      ({ interactionId, turnId }) => ({
        interaction: {
          type: "approval",
          interactionId,
          turnId,
          title: "Run",
          subject: { type: "nativeAction" },
          actions: [{ id: "allow", label: "Allow", effect: "allowOnce" }],
        },
        actionToOptionId: new Map([["allow", "allow_once"]]),
      }),
    );
    vi.spyOn(projection, "buildAcpPermissionResponse").mockReturnValue({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    vi.spyOn(projection, "projectAcpQuestionInteraction").mockImplementation(
      ({ interactionId, turnId }) => ({
        interaction: {
          type: "question",
          interactionId,
          turnId,
          questions: [
            {
              id: "q",
              type: "choice",
              prompt: "Which?",
              options: [{ value: "yes", label: "Yes" }],
              multiple: false,
              allowOther: false,
              optional: false,
            },
          ],
        },
        fieldMap: { questions: [] },
      }),
    );
    vi.spyOn(projection, "buildAcpElicitationResponse").mockReturnValue({
      action: "accept",
      content: { q: "yes" },
    });
  });
  it.each(["approval", "question"] as const)(
    "validates and resolves %s exactly once",
    async (kind) => {
      const { adapter, transports } = fixture();
      const { session, outputs } = await sessionOf(
        await adapter.open({ kind: "create", cwd: process.cwd() }),
      );
      const transport = await start(session, transports);
      const reply =
        kind === "approval"
          ? required(transport.handler).onPermission({
              sessionId: required(transport.sessionId),
              toolCall: { toolCallId: "tool" },
              options: [],
            })
          : required(transport.handler).onElicitation({
              mode: "form",
              sessionId: required(transport.sessionId),
              toolCallId: "question-tool",
              message: "Question",
              requestedSchema: { type: "object", properties: {} },
            });
      await vi.waitFor(() =>
        expect(outputs.some((output) => output.kind === "interaction")).toBe(true),
      );
      const interaction = required(outputs.find((output) => output.kind === "interaction"));
      if (interaction.kind !== "interaction") throw new Error("Missing interaction");
      const invalid =
        kind === "approval"
          ? { type: "approval" as const, actionId: "evil" }
          : { type: "question" as const, answers: { q: ["evil"] } };
      expect(
        await session.execute({
          type: "interaction.respond",
          interactionId: interaction.interaction.interactionId,
          response: invalid,
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      const valid =
        kind === "approval"
          ? { type: "approval" as const, actionId: "allow" }
          : { type: "question" as const, answers: { q: ["yes"] } };
      expect(
        (
          await session.execute({
            type: "interaction.respond",
            interactionId: interaction.interaction.interactionId,
            response: valid,
          })
        ).ok,
      ).toBe(true);
      if (kind === "question")
        expect(projection.projectAcpQuestionInteraction).toHaveBeenCalledWith(
          expect.objectContaining({ rawQuestions: [{ prompt: "Which?" }] }),
        );
      expect(await reply).toEqual(
        kind === "approval"
          ? { outcome: { outcome: "selected", optionId: "allow_once" } }
          : { action: "accept", content: { q: "yes" } },
      );
      expect(
        (
          await session.execute({
            type: "interaction.respond",
            interactionId: interaction.interaction.interactionId,
            response: valid,
          })
        ).ok,
      ).toBe(false);
      expect(events(outputs).filter((event) => event.type === "interaction.closed")).toHaveLength(
        1,
      );
    },
  );
  it("cancellation releases native waiters and rejects late responses", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    const transport = await start(session, transports);
    const permission = required(transport.handler).onPermission({
      sessionId: required(transport.sessionId),
      toolCall: { toolCallId: "tool" },
      options: [],
    });
    const question = required(transport.handler).onElicitation({
      mode: "form",
      sessionId: required(transport.sessionId),
      message: "Question",
      requestedSchema: { type: "object", properties: {} },
    });
    await session.execute({ type: "turn.cancel", turnId: turnId("t1") });
    expect(await permission).toEqual({ outcome: { outcome: "cancelled" } });
    expect(await question).toEqual({ action: "cancel" });
    expect(events(outputs).filter((event) => event.type === "interaction.closed")).toHaveLength(2);
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: hostInteractionIdSchema.parse("late"),
        response: { type: "approval", actionId: "allow" },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("inspection and errors", () => {
  it.skipIf(process.platform === "win32")(
    "reads and refreshes native quota without a user Session or leaking fetchedAt",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "agy-quota-"));
      directories.push(home);
      const command = path.join(home, "agy");
      const quota = {
        event: "command_result",
        command: {
          name: "usage",
          data: {
            groups: [{ name: "Plan", buckets: [{ window: "5h", remaining_fraction: 0.75 }] }],
          },
        },
      };
      await writeFile(
        command,
        `#!/bin/sh\necho 'diagnostic'\nprintf '%s\\n' '${JSON.stringify(quota)}'\n`,
      );
      await chmod(command, 0o755);
      const { adapter, transports } = fixture({ command });
      expect(adapter.credits()).toBeNull();
      expect(await adapter.refreshCredits()).toMatchObject({
        usedPercent: 25,
        periodType: "five_hour",
      });
      const account = await adapter.inspectAccount();
      expect(account?.credits).toMatchObject({ usedPercent: 25 });
      expect(account?.credits).not.toHaveProperty("fetchedAt");
      expect(transports).toHaveLength(0);
      await writeFile(command, "#!/bin/sh\nexit 1\n");
      expect(await adapter.refreshCredits()).toBeNull();
      expect(adapter.credits()).toBeNull();
    },
  );
  it("normalizes native faults and redacts diagnostics", () => {
    expect(
      normalizeAntigravityError(
        new AntigravityTransportError("authenticationRequired", "Login required"),
      ),
    ).toMatchObject({ code: "authenticationRequired" });
    expect(
      normalizeAntigravityError(new AntigravityTransportError("processExited", "Exited")),
    ).toMatchObject({ code: "processExited", retryable: true });
    expect(normalizeAntigravityError(new Error("please login"))).toMatchObject({
      code: "authenticationRequired",
    });
  });
  it.skipIf(process.platform === "win32")(
    "checks version without a Session, caches by cwd, and refreshes explicitly",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "agy-inspect-"));
      directories.push(home);
      const command = path.join(home, "agy");
      const calls = path.join(home, "calls");
      await writeFile(
        command,
        `#!/bin/sh\nprintf '%s\\n' "$1" >> '${calls}'\nif [ "$1" = '--version' ]; then echo 'agy 1.5.8'; else printf 'gemini-high\\tGemini High\\n'; fi\n`,
      );
      await chmod(command, 0o755);
      const { adapter, transports } = fixture({ command });
      expect((await adapter.inspect({ cwd: home, purpose: "availability" })).status).toBe("ready");
      expect(await readFile(calls, "utf8")).toBe("--version\n");
      expect((await adapter.inspect({ cwd: home })).status).toBe("ready");
      await adapter.inspect({ cwd: home });
      expect((await readFile(calls, "utf8")).split("\n").filter(Boolean)).toEqual([
        "--version",
        "--version",
        "models",
      ]);
      await adapter.inspect({ cwd: home, refresh: true });
      await adapter.inspect({ cwd: process.cwd() });
      expect((await readFile(calls, "utf8")).split("models")).toHaveLength(4);
      expect(transports).toHaveLength(0);
      await writeFile(command, "#!/bin/sh\necho 'agy 1.5.7'\n");
      expect(await adapter.inspect({ cwd: home, refresh: true })).toMatchObject({
        status: "unavailable",
        error: { message: expect.stringContaining("1.5.8") },
      });
    },
  );
});
