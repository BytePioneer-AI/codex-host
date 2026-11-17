import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AntigravityAdapter,
  AntigravitySession,
  normalizeAntigravityError,
} from "../src/antigravity-adapter.js";
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
import * as nativeFork from "../src/fork.js";
import * as nativeBoundaries from "../src/native-turn-boundaries.js";
import { AntigravitySessionUsageTracker } from "../src/acp-usage.js";
import { writeNativeTimingDatabase } from "./support/native-timing-fixture.js";

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
  queuedSessionEvents: AntigravityAcpEvent[] = [];
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
    if (handler) for (const event of this.queuedSessionEvents.splice(0)) handler(event);
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
  closeSession = vi.fn(async () => {
    this.sessionId = null;
  });
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
  it("keeps unopened drafts unconfirmed until configured or started, and opens once on pre-Turn config", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd(), model: model("claude") }),
    );
    expect(session.initialState.effectiveModel).toBeUndefined();
    expect(transports).toHaveLength(0);
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: mode("dangerously-skip-permissions"),
      }),
    ).toEqual({ ok: true, value: { completed: true } });
    expect(transports).toHaveLength(1);
    expect(transports[0]?.skipPermissions).toBe(true);
    expect(transports[0]?.setConfigOption).toHaveBeenCalledWith("model", "claude");
    expect(session.initialState).toMatchObject({
      effectiveModel: model("claude"),
      effectivePermissionModeId: "dangerously-skip-permissions",
    });
    expect(events(outputs)).toContainEqual(
      expect.objectContaining({
        type: "session.state.changed",
        state: expect.objectContaining({
          effectiveModel: model("claude"),
          effectivePermissionModeId: "dangerously-skip-permissions",
        }),
      }),
    );
  });
  it("reconciles effort-suffixed and single-variant ACP model IDs", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd(), model: model("gemini-high") }),
    );
    const transport = await start(session, transports);
    expect(transport.setConfigOption.mock.calls).toEqual([
      ["model", "gemini"],
      ["thought_level", "high"],
    ]);
    transport.config = [
      {
        id: "model",
        category: "model",
        name: "Model",
        currentValue: "gemini",
        options: [
          { value: "gemini", name: "Gemini" },
          { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        ],
      },
    ];
    transport.eventHandler?.({ type: "config.update", configOptions: transport.config });
    expect(await session.execute({ type: "model.select", model: model("gpt-oss-120b") })).toEqual({
      ok: true,
      value: { completed: true },
    });
    expect(session.initialState.effectiveModel).toEqual(model("gpt-oss-120b-medium"));
    expect(session.initialState.availableThinkingOptions).toEqual([]);
  });
  it.each(["create", "resume"] as const)(
    "cancels during %s initialization without faulting or cancelling an unopened native Session",
    async (kind) => {
      const gate = deferred<InitializeResponse>();
      let transport: FakeTransport | undefined;
      const { adapter, transports } = fixture();
      adapter.options.createTransport = (options) => {
        transport = new FakeTransport(options);
        transports.push(transport);
        transport.initialize.mockReturnValue(gate.promise);
        return transport;
      };
      const { session, outputs } = await sessionOf(
        await adapter.open(
          kind === "resume"
            ? { kind, cwd: process.cwd(), nativeRef: ref() }
            : { kind, cwd: process.cwd() },
        ),
      );
      await session.execute({
        type: "turn.start",
        turnId: turnId("cancel-init"),
        input: [{ type: "text", text: "hello" }],
      });
      await vi.waitFor(() => expect(transport).toBeDefined());
      expect(await session.execute({ type: "turn.cancel", turnId: turnId("cancel-init") })).toEqual(
        {
          ok: true,
          value: { cancellationRequested: true },
        },
      );
      expect(required(transport).cancel).not.toHaveBeenCalled();
      gate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await completed(outputs, "cancel-init");
      expect(events(outputs).some((e) => e.type === "session.faulted")).toBe(false);
      const next = await start(session, transports, "after-cancel");
      next.result.resolve({ stopReason: "end_turn" });
      await completed(outputs, "after-cancel");
    },
  );
  it.each(["create", "resume"] as const)(
    "waits for historical usage replay before submitting a %s prompt",
    async (kind) => {
      const gate =
        deferred<Awaited<ReturnType<AntigravitySessionUsageTracker["replayHistoricalRequests"]>>>();
      const replay = vi
        .spyOn(AntigravitySessionUsageTracker.prototype, "replayHistoricalRequests")
        .mockReturnValueOnce(gate.promise);
      const { adapter, transports } = fixture();
      const { session, outputs } = await sessionOf(
        await adapter.open(
          kind === "resume"
            ? { kind, cwd: process.cwd(), nativeRef: ref() }
            : { kind, cwd: process.cwd() },
        ),
      );
      if (kind === "resume") {
        expect((await session.readSnapshot()).ok).toBe(true);
        expect(transports[0]?.prompt).not.toHaveBeenCalled();
      }
      await session.execute({
        type: "turn.start",
        turnId: turnId("replay"),
        input: [{ type: "text", text: "hello" }],
      });
      await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
      const writer = required(transports.at(-1));
      expect(writer.prompt).not.toHaveBeenCalled();
      gate.resolve({ requests: [], complete: true, usage: null });
      await vi.waitFor(() => expect(writer.prompt).toHaveBeenCalledOnce());
      writer.result.resolve({ stopReason: "end_turn" });
      await completed(outputs, "replay");
    },
  );
  it.each([
    ["create", undefined, 40],
    ["resume", undefined, 40],
    ["create", "claude", 80],
    ["resume", "claude", 80],
  ] as const)(
    "keeps initial and configuration context updates for %s (model %s)",
    async (kind, selected, used) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "agy-context-open-"));
      directories.push(home);
      const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
      adapter.options.createTransport = (options) => {
        const transport = new FakeTransport(options);
        transports.push(transport);
        transport.queuedSessionEvents.push({ type: "usage.context", used: 40, size: 100 });
        transport.setConfigOption.mockImplementation(async (id, value) => {
          transport.config = transport.config.map((entry) =>
            entry.id === id ? { ...entry, currentValue: value } : entry,
          );
          transport.eventHandler?.({ type: "usage.context", used: 80, size: 100 });
          return transport.config;
        });
        return transport;
      };
      const input = { cwd: home, ...(selected ? { model: model(selected) } : {}) };
      const { session, outputs } = await sessionOf(
        await adapter.open(
          kind === "create" ? { kind, ...input } : { kind, ...input, nativeRef: ref() },
        ),
      );
      if (!(session instanceof AntigravitySession)) throw new Error("Expected AntigravitySession");
      await session.initialize();
      expect(session.initialUsage).toMatchObject({
        contextUsedTokens: used,
        contextWindowTokens: 100,
      });
      await session.refreshUsage();
      const usageEvents = events(outputs).filter((event) => event.type === "session.usage.changed");
      expect(usageEvents.at(-1)).toMatchObject({
        usage: { contextUsedTokens: used, contextWindowTokens: 100 },
      });
    },
  );
  it("marks missing derived history incomplete instead of publishing an empty zero-cost ledger", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-derived-usage-"));
    directories.push(home);
    vi.spyOn(nativeBoundaries, "readNativeTurnCount").mockResolvedValue(3);
    const { adapter } = fixture({ environment: { HOME: home, USERPROFILE: home } });
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "resume", nativeRef: ref(), cwd: home }),
    );
    expect((await session.readSnapshot()).ok).toBe(true);
    await session.refreshUsage?.();
    const history = events(outputs).filter((event) => event.type === "usage.history");
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((event) => event.complete === false)).toBe(true);
    expect(events(outputs).some((event) => event.type === "usage.request")).toBe(false);
    expect(history.every((event) => Object.keys(event).sort().join(",") === "complete,type")).toBe(
      true,
    );
  });
  it("clears active usage state after prompt throws and allows idle refresh and the next Turn", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-failed-usage-"));
    directories.push(home);
    const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
    adapter.options.createTransport = (options) => {
      const transport = new FakeTransport(options);
      transports.push(transport);
      transport.prompt.mockRejectedValueOnce(new Error("prompt failed"));
      return transport;
    };
    const { session, outputs } = await sessionOf(await adapter.open({ kind: "create", cwd: home }));
    await session.execute({
      type: "turn.start",
      turnId: turnId("throws"),
      input: [{ type: "text", text: "hello" }],
    });
    await completed(outputs, "throws");
    await session.refreshUsage?.();
    expect(
      events(outputs)
        .filter((event) => event.type === "usage.history")
        .at(-1),
    ).toMatchObject({ complete: true });
    const next = await start(session, transports, "after-throw");
    next.result.resolve({ stopReason: "end_turn" });
    await completed(outputs, "after-throw");
    await session.refreshUsage?.();
    expect(
      events(outputs)
        .filter((event) => event.type === "usage.history")
        .at(-1),
    ).toMatchObject({ complete: true });
  });
  it("does not let usage observation failure turn a successful prompt into failure", async () => {
    vi.spyOn(
      AntigravitySessionUsageTracker.prototype,
      "collectNewTranscriptRequests",
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
  it("publishes native request timing once and completes metering with output that includes reasoning", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-native-metering-"));
    directories.push(home);
    const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
    const { session, outputs } = await sessionOf(await adapter.open({ kind: "create", cwd: home }));
    const transport = await start(session, transports);
    const sessionId = required(transport.sessionId);
    const created = Date.now();
    await writeNativeTimingDatabase(
      home,
      [
        {
          step: 1,
          input: 13035,
          cached: 0,
          output: 146,
          created,
          started: created + 1,
          completed: created + 3,
        },
      ],
      sessionId,
    );
    const log = path.join(
      home,
      ".gemini/antigravity-cli/brain",
      sessionId,
      ".system_generated/logs/transcript.jsonl",
    );
    await mkdir(path.dirname(log), { recursive: true });
    await writeFile(
      log,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        status: "DONE",
        step_index: 1,
        model: "gemini-4-carbon-medium",
        input_tokens: 13035,
        cache_read_tokens: 0,
        output_tokens: 146,
      }) + "\n",
    );
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(created + 3));
    required(transport.handler).onEvent({ type: "usage.context", used: 13181, size: 1048576 });
    await vi.waitFor(() =>
      expect(events(outputs).filter((event) => event.type === "usage.request")).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(
        events(outputs)
          .filter((event) => event.type === "usage.history")
          .at(-1),
      ).toEqual({ type: "usage.history", complete: true }),
    );
    expect(events(outputs).some((event) => event.type === "turn.completed")).toBe(false);
    transport.result.resolve({
      stopReason: "end_turn",
      usage: {
        inputTokens: 13035,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 146,
        thoughtTokens: 107,
        totalTokens: 13181,
      },
    });
    await completed(outputs);
    expect(events(outputs).filter((event) => event.type === "usage.request")).toMatchObject([
      {
        request: { outputTokens: 146, startedAtMs: created + 1, completedAtMs: created + 3 },
      },
    ]);
    expect(
      events(outputs)
        .filter((event) => event.type === "usage.history")
        .at(-1),
    ).toEqual({ type: "usage.history", complete: true });
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
      usage: { contextUsagePercent: 10, contextUsedTokens: 10, contextWindowTokens: 100 },
    });
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "session.usage.changed",
        observedForTurnId: "t1",
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          contextUsedTokens: 10,
          contextWindowTokens: 100,
        }),
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
    if (!(session instanceof AntigravitySession)) throw new Error("Expected AntigravitySession");
    await session.initialize();
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
    const { session } = await sessionOf(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: ref(),
        environment: { CODEXHOST_THREAD_ID: "thread-override" },
      }),
    );
    if (!(session instanceof AntigravitySession)) throw new Error("Expected AntigravitySession");
    await session.initialize();
    const transport = required(transports[0]);
    expect(transport.options.environment?.CODEXHOST_THREAD_ID).toBe("thread-override");
    const prompt = required(transport.openSession.mock.calls[0]?.[0].systemPromptAppend);
    for (const value of ["private-cli", "private-endpoint", "secret-token", "thread-override"])
      expect(prompt).not.toContain(value);
    expect(prompt).toContain("CODEXHOST_RUNTIME_TOKEN");
  });
  it("reads cold history using only load, then resumes once with saved configuration for writing", async () => {
    const { adapter, transports } = fixture();
    const nativeRef = ref(undefined, { permissionModeId: "dangerously-skip-permissions" });
    const { session, outputs } = await sessionOf(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef,
        model: model("claude"),
        thinkingOptionId: thinking("high"),
      }),
    );
    expect(transports).toHaveLength(0);
    expect(session.initialState).toEqual({ nativeRef });
    const reading = session.readSnapshot();
    await Promise.resolve();
    const reader = required(transports[0]);
    reader.replayedEvents = [
      { type: "user.text", text: "old question" },
      { type: "agent.text", text: "old answer" },
    ];
    const snapshot = await reading;
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [{ nativeTurnRef: { nativeTurnKey: "turn-0" } }],
      },
    });
    expect(snapshot.ok && snapshot.value.state).toBeUndefined();
    expect(session.initialState.effectiveModel).toBeUndefined();
    expect(transports).toHaveLength(1);
    expect(reader.skipPermissions).toBe(true);
    expect(reader.openSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "load", sessionId: nativeRef.nativeSessionId }),
    );
    expect(reader.setConfigOption).not.toHaveBeenCalled();
    expect(reader.prompt).not.toHaveBeenCalled();
    expect(reader.closeSession).toHaveBeenCalledOnce();
    expect(reader.close).not.toHaveBeenCalled();
    const writer = await start(session, transports);
    expect(transports).toHaveLength(2);
    expect(writer.openSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "resume", sessionId: nativeRef.nativeSessionId }),
    );
    expect(writer.setConfigOption.mock.calls).toEqual([
      ["model", "claude"],
      ["thought_level", "high"],
    ]);
    writer.result.resolve({ stopReason: "end_turn" });
    await completed(outputs);
    expect(events(outputs)).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        nativeTurnRef: expect.objectContaining({ nativeTurnKey: "turn-1" }),
      }),
    );
    await adapter.close();
    expect(reader.close).toHaveBeenCalledOnce();
  });
  it("reuses one read-only process serially across Sessions and isolates by permission and account environment", async () => {
    const { adapter, transports } = fixture();
    const firstRef = ref();
    const secondRef = ref();
    const skipRef = ref(undefined, { permissionModeId: "dangerously-skip-permissions" });
    const otherHome = await mkdtemp(path.join(os.tmpdir(), "agy-reader-home-"));
    directories.push(otherHome);
    const otherAccountRef = ref();
    const [
      { session: first },
      { session: second },
      { session: skipSession },
      { session: otherAccount },
    ] = await Promise.all([
      sessionOf(
        await adapter.open({
          kind: "resume",
          cwd: process.cwd(),
          nativeRef: firstRef,
          environment: { CODEXHOST_THREAD_ID: "thread-1" },
        }),
      ),
      sessionOf(
        await adapter.open({
          kind: "resume",
          cwd: otherHome,
          nativeRef: secondRef,
          environment: { CODEXHOST_THREAD_ID: "thread-2" },
        }),
      ),
      sessionOf(
        await adapter.open({
          kind: "resume",
          cwd: process.cwd(),
          nativeRef: skipRef,
          environment: { CODEXHOST_THREAD_ID: "thread-3" },
        }),
      ),
      sessionOf(
        await adapter.open({
          kind: "resume",
          cwd: process.cwd(),
          nativeRef: otherAccountRef,
          environment: { HOME: otherHome, CODEXHOST_THREAD_ID: "thread-4" },
        }),
      ),
    ]);
    const closeGate = deferred<undefined>();
    const firstRead = first.readSnapshot();
    await Promise.resolve();
    const sharedReader = required(transports[0]);
    sharedReader.closeSession.mockReturnValueOnce(closeGate.promise);
    const secondRead = second.readSnapshot();
    await vi.waitFor(() => expect(sharedReader.closeSession).toHaveBeenCalledOnce());
    expect(sharedReader.openSession).toHaveBeenCalledTimes(1);
    closeGate.resolve(undefined);
    expect((await firstRead).ok).toBe(true);
    expect((await secondRead).ok).toBe(true);
    expect(transports).toHaveLength(1);
    expect(sharedReader.initialize).toHaveBeenCalledTimes(1);
    expect(sharedReader.openSession.mock.calls).toEqual([
      [{ kind: "load", sessionId: firstRef.nativeSessionId, cwd: process.cwd() }],
      [{ kind: "load", sessionId: secondRef.nativeSessionId, cwd: otherHome }],
    ]);
    expect(sharedReader.closeSession).toHaveBeenCalledTimes(2);
    expect(sharedReader.close).not.toHaveBeenCalled();

    await first.close();
    expect(sharedReader.close).not.toHaveBeenCalled();

    expect((await skipSession.readSnapshot()).ok).toBe(true);
    expect((await otherAccount.readSnapshot()).ok).toBe(true);
    expect(transports).toHaveLength(3);
    expect(transports[1]?.skipPermissions).toBe(true);
    expect(transports[2]?.options.environment?.HOME).toBe(otherHome);

    await adapter.close();
    expect(transports.every((transport) => transport.close.mock.calls.length === 1)).toBe(true);
  });
  it("retires a faulted reader process, starts a fresh reader on the next snapshot, and joins cleanup on Adapter close", async () => {
    const { adapter, transports } = fixture();
    const { session: first } = await sessionOf(
      await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    const { session: second } = await sessionOf(
      await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    const retiredExited = deferred<undefined>();
    const readingFirst = first.readSnapshot();
    await Promise.resolve();
    const brokenReader = required(transports[0]);
    brokenReader.closeSession.mockRejectedValueOnce(
      new AntigravityTransportError("unavailable", "session/close timed out"),
    );
    brokenReader.close.mockReturnValue(retiredExited.promise);
    expect(await readingFirst).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(brokenReader.close).toHaveBeenCalledOnce();

    expect((await second.readSnapshot()).ok).toBe(true);
    expect(transports).toHaveLength(2);
    const healthyReader = required(transports[1]);
    expect(healthyReader.close).not.toHaveBeenCalled();

    let adapterClosed = false;
    const closing = adapter.close().then(() => {
      adapterClosed = true;
    });
    await vi.waitFor(() => expect(healthyReader.close).toHaveBeenCalledOnce());
    expect(adapterClosed).toBe(false);
    retiredExited.resolve(undefined);
    await closing;
    expect(adapterClosed).toBe(true);
  });
  it("propagates pooled reader cleanup failure when the Adapter closes", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(
      await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    expect((await session.readSnapshot()).ok).toBe(true);
    const reader = required(transports[0]);
    reader.close.mockRejectedValueOnce(new Error("reader cleanup failed"));
    await expect(adapter.close()).rejects.toThrow("reader cleanup failed");
    await expect(adapter.close()).rejects.toThrow("reader cleanup failed");
    adapters.splice(adapters.indexOf(adapter), 1);
  });
  it("does not let a pending cold history reader overwrite writable configuration", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(
      await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    const gate = deferred<undefined>();
    const reading = session.readSnapshot();
    await Promise.resolve();
    const reader = required(transports[0]);
    const open = required(reader.openSession.getMockImplementation());
    reader.openSession.mockImplementationOnce(async (input) => {
      await gate.promise;
      return open(input);
    });
    try {
      expect(await session.execute({ type: "model.select", model: model("claude") })).toEqual({
        ok: true,
        value: { completed: true },
      });
      expect(transports).toHaveLength(2);
      gate.resolve(undefined);
      expect(await reading).toMatchObject({
        ok: true,
        value: { state: { effectiveModel: model("claude") } },
      });
      expect(session.initialState.effectiveModel).toEqual(model("claude"));
    } finally {
      gate.resolve(undefined);
      await reading;
    }
  });
  it("closes an unopened restored Session without starting a process", async () => {
    const { adapter, transports } = fixture();
    const { session } = await sessionOf(
      await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    await session.close();
    await session.close();
    expect(transports).toHaveLength(0);
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
    expect(reader.closeSession).toHaveBeenCalledOnce();
    expect(reader.close).not.toHaveBeenCalled();
    reader.options.onFault?.(
      new AntigravityTransportError("processExited", "read-only connection died"),
    );
    expect(reader.close).toHaveBeenCalledOnce();
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
    expect(session.initialState.effectiveModel).toBeUndefined();
    if (!(session instanceof AntigravitySession)) throw new Error("Expected AntigravitySession");
    await session.initialize();
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
    const { session: brokenSession } = await sessionOf(
      await broken.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    expect(await brokenSession.readSnapshot()).toMatchObject({
      ok: false,
      error: { code: "protocolError" },
    });
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
  it.each(["approval", "question"] as const)(
    "validates and resolves %s exactly once",
    async (kind) => {
      const { adapter, transports } = fixture();
      const { session, outputs } = await sessionOf(
        await adapter.open({ kind: "create", cwd: process.cwd() }),
      );
      const transport = await start(session, transports);
      if (kind === "question") {
        required(transport.handler).onEvent({
          type: "tool.call",
          toolCallId: "question-tool",
          name: "ask_question",
          args: { questions: [{ question: "Which?" }] },
        });
      }
      const reply =
        kind === "approval"
          ? required(transport.handler).onPermission({
              sessionId: required(transport.sessionId),
              toolCall: { toolCallId: "tool", title: "Run" },
              options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
            })
          : required(transport.handler).onElicitation({
              mode: "form",
              sessionId: required(transport.sessionId),
              toolCallId: "question-tool",
              message: "Question",
              requestedSchema: {
                type: "object",
                required: ["q"],
                properties: {
                  q: {
                    type: "string",
                    oneOf: [{ const: "yes", title: "Yes" }],
                  },
                },
              },
            } as unknown as Parameters<AntigravityActivePromptHandler["onElicitation"]>[0]);
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
          ? { type: "approval" as const, actionId: "allow_once" }
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
      if (kind === "question") {
        expect(interaction.interaction).toMatchObject({
          type: "question",
          itemId: expect.stringMatching(/^tool-/u),
          questions: [expect.objectContaining({ id: "q", prompt: "Which?" })],
        });
      }
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
  it.skipIf(process.platform === "win32")(
    "resolves inspectAccount on the usage command_result line before CLI teardown",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "agy-quota-"));
      directories.push(home);
      const command = path.join(home, "agy");
      await writeFile(
        command,
        [
          "#!/bin/sh",
          'printf \'%s\\n\' \'{"event":"command_result","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-5h","window":"5h","remaining_fraction":0.75,"reset_time":"2026-11-14T20:16:50Z"}]}]}}}\'',
          "sleep 3",
          "",
        ].join("\n"),
      );
      await chmod(command, 0o755);
      const { adapter } = fixture({ command, inspectTimeoutMs: 5_000 });
      const started = Date.now();
      const account = await adapter.inspectAccount();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(account).toMatchObject({
        credits: { usedPercent: 25, periodType: "five_hour" },
      });
      expect(adapter.credits()?.usedPercent).toBe(25);
      await adapter.close();
    },
  );
});
