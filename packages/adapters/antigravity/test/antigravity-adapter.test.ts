import assert from "node:assert/strict";
import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
import {
  answerStep,
  createNativeHistoryDatabase,
  systemStep,
  userStep,
} from "./support/native-history-fixture.js";
import { writeNativeTimingDatabase } from "./support/native-timing-fixture.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

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
function fixture(
  options: ConstructorParameters<typeof AntigravityAdapter>[0] = {},
  configureTransport?: (transport: FakeTransport, index: number) => void,
) {
  const transports: FakeTransport[] = [];
  const adapter = new AntigravityAdapter({
    ...options,
    createTransport: (input) => {
      const transport = new FakeTransport(input);
      configureTransport?.(transport, transports.length);
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
      const home = await mkdtemp(path.join(os.tmpdir(), "agy-usage-open-"));
      directories.push(home);
      const nativeRef = ref();
      if (kind === "resume")
        (await createNativeHistoryDatabase(home, nativeRef.nativeSessionId)).close();
      const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
      const { session, outputs } = await sessionOf(
        await adapter.open(
          kind === "resume" ? { kind, cwd: home, nativeRef } : { kind, cwd: home },
        ),
      );
      if (kind === "resume") {
        expect((await session.readSnapshot()).ok).toBe(true);
        expect(transports).toHaveLength(0);
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
    const nativeRef = ref();
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    userStep(db, 0, "Persisted input without usage");
    db.close();
    const { adapter } = fixture({ environment: { HOME: home, USERPROFILE: home } });
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "resume", nativeRef, cwd: home }),
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
  it("forks a committed prefix without holding up the running or next source Turn", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-live-fork-"));
    directories.push(home);
    const resume = deferred<undefined>();
    const { adapter, transports } = fixture(
      { environment: { HOME: home, USERPROFILE: home } },
      (transport, index) => {
        if (index === 1) {
          const open = required(transport.openSession.getMockImplementation());
          transport.openSession.mockImplementation(async (input) => {
            await resume.promise;
            return open(input);
          });
        }
      },
    );
    const nativeRef = ref();
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);`);
    db.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(
      randomUUID(),
      nativeRef.nativeSessionId,
    );
    try {
      const source = await sessionOf(await adapter.open({ kind: "resume", cwd: home, nativeRef }));
      const transport = await start(source.session, transports);
      userStep(db, 0, "early input");
      answerStep(db, 1, "early answer");
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(source.outputs);
      const terminal = events(source.outputs).find((event) => event.type === "turn.completed");
      assert(terminal?.outcome.checkpoint);
      const request = {
        kind: "fork" as const,
        cwd: home,
        sourceRef: nativeRef,
        checkpoint: terminal.outcome.checkpoint,
      };
      transport.result = deferred();
      await start(source.session, transports, "t2");
      await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalledTimes(2));
      const busy = { ok: false, error: { code: "sessionBusy", retryable: true } };
      expect(await adapter.open(request)).toMatchObject({
        ...busy,
        error: { ...busy.error, message: expect.stringContaining("no committed user input") },
      });
      // A committed wake between these prompts is outside the earlier user checkpoint.
      systemStep(db, 2, "wake-between-prompts");
      answerStep(db, 3, "timer expired", "wake-between-prompts");
      userStep(db, 4, "source-only input");
      expect(
        await adapter.open({
          ...request,
          checkpoint: { ...request.checkpoint, checkpointId: "turn-1" },
        }),
      ).toMatchObject(busy);
      expect(
        await adapter.open({ kind: "rollbackLastTurn", cwd: home, sourceRef: nativeRef }),
      ).toMatchObject(busy);

      const forked = adapter.open(request);
      await vi.waitFor(() => expect(transports).toHaveLength(2));
      expect(transport.cancel).not.toHaveBeenCalled();
      answerStep(db, 5, "source-only answer");
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(source.outputs, "t2");
      transport.result = deferred();
      await start(source.session, [transport], "t3");
      await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalledTimes(3));
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(source.outputs, "t3");
      resume.resolve(undefined);

      const branch = await sessionOf(await forked);
      const derivedId = required(branch.session.initialState.nativeRef).nativeSessionId;
      expect(derivedId).not.toBe(nativeRef.nativeSessionId);
      const inputs = async (session: HarnessSession) => {
        const snapshot = await session.readSnapshot();
        assert(snapshot.ok);
        return snapshot.value.turns.map((turn) => turn.input);
      };
      expect(await inputs(branch.session)).toEqual([[{ type: "text", text: "early input" }]]);
      const branchTransport = await start(branch.session, transports, "branch");
      const derivedDb = new DatabaseSync(nativeFork.nativeConversationDbPath(derivedId, home));
      try {
        userStep(derivedDb, 2, "branch-only input");
        answerStep(derivedDb, 3, "branch-only answer");
      } finally {
        derivedDb.close();
      }
      branchTransport.result.resolve({ stopReason: "end_turn" });
      await completed(branch.outputs, "branch");
      expect(await inputs(branch.session)).toEqual([
        [{ type: "text", text: "early input" }],
        [{ type: "text", text: "branch-only input" }],
      ]);
      expect(await inputs(source.session)).toEqual([
        [{ type: "text", text: "early input" }],
        [],
        [{ type: "text", text: "source-only input" }],
      ]);
    } finally {
      resume.resolve(undefined);
      db.close();
    }
  });
  it.each(["retry", "trailing"])(
    "collects a late transcript via %s and attributes cross-Turn timing",
    async (mode) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "agy-native-metering-"));
      directories.push(home);
      const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
      const { session, outputs } = await sessionOf(
        await adapter.open({ kind: "create", cwd: home }),
      );
      const transport = await start(session, transports);
      const sessionId = required(transport.sessionId);
      const created = Date.now();
      const metadata = [
        {
          step: 1,
          input: 13035,
          cached: 0,
          output: 146,
          thought: 107,
          created,
          started: created + 1,
          completed: created + 3,
        },
      ];
      const database = new DatabaseSync(await writeNativeTimingDatabase(home, metadata, sessionId));
      try {
        database.exec("DELETE FROM gen_metadata");
      } finally {
        database.close();
      }
      const log = path.join(
        home,
        ".gemini/antigravity-cli/brain",
        sessionId,
        ".system_generated/logs/transcript.jsonl",
      );
      await mkdir(path.dirname(log), { recursive: true });
      const notice = () =>
        required(transport.handler).onEvent({ type: "usage.context", used: 13181, size: 1048576 });
      const commitTranscript = () =>
        writeFile(
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
      const expectRequest = () =>
        expect(events(outputs).filter((event) => event.type === "usage.request")).toMatchObject([
          { request: { outputTokens: 146, cacheWriteInputTokens: 0, reasoningOutputTokens: 107 } },
        ]);
      if (mode === "retry") {
        const historyCount = () =>
          events(outputs).filter((event) => event.type === "usage.history").length;
        const before = historyCount();
        notice();
        await vi.waitFor(() => expect(historyCount()).toBeGreaterThan(before));
        expect(events(outputs).filter((event) => event.type === "usage.request")).toEqual([]);
        await commitTranscript();
        await vi.waitFor(expectRequest);
      } else {
        // Hold the first filesystem read at EOF so the next scan is the only one that sees the commit.
        await writeFile(log, "");
        const eof = deferred<undefined>();
        const release = deferred<undefined>();
        const { createReadStream, read, open, close } = await vi.importActual<typeof fs>("node:fs");
        vi.mocked(fs.createReadStream).mockImplementationOnce((file, options) =>
          createReadStream(file, {
            ...(typeof options === "string" ? { encoding: options } : options),
            fs: {
              open,
              close,
              read: (fd, buffer, offset, length, position, callback) => {
                read(fd, buffer, offset, length, position, (error, bytesRead, data) => {
                  eof.resolve(undefined);
                  void release.promise.then(() => callback(error, bytesRead, data));
                });
              },
            },
          }),
        );
        const work = session.refreshUsage?.();
        await eof.promise;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          await commitTranscript();
          notice();
          notice();
          release.resolve(undefined);
          await work;
          await setImmediate();
          expectRequest();
        } finally {
          release.resolve(undefined);
          await vi.runAllTimersAsync();
          vi.useRealTimers();
        }
      }
      expect(events(outputs).filter((event) => event.type === "usage.request.timing")).toEqual([]);
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
      expect(events(outputs).filter((event) => event.type === "usage.request.timing")).toEqual([]);
      delete transport.handler;
      transport.result = deferred<AntigravityPromptResult>();
      await start(session, transports, "t2");
      await writeNativeTimingDatabase(home, metadata, sessionId);
      notice();
      await vi.waitFor(() =>
        expect(events(outputs).filter((event) => event.type === "usage.request.timing")).toEqual([
          {
            type: "usage.request.timing",
            turnId: "t1",
            timing: {
              requestId: "step:1",
              requestStartedAtMs: created,
              timeToFirstOutputMs: 1,
              output: { outputTokens: 39, startedAtMs: created + 1, completedAtMs: created + 3 },
            },
          },
        ]),
      );
      expect(events(outputs).filter((event) => event.type === "usage.request")).toHaveLength(1);
      expect(
        events(outputs)
          .filter((event) => event.type === "usage.history")
          .at(-1),
      ).toEqual({ type: "usage.history", complete: true });
    },
  );

  it("streams ordered text/reasoning, usage and stable Turn identity", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-stream-turn-"));
    directories.push(home);
    const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
    const { session, outputs } = await sessionOf(await adapter.open({ kind: "create", cwd: home }));
    const transport = await start(session, transports);
    const db = await createNativeHistoryDatabase(home, required(transport.sessionId));
    try {
      userStep(db, 0, "hello", "prompt");
      answerStep(db, 1, "hello", "prompt");
    } finally {
      db.close();
    }
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
    await vi.waitFor(() => expect(transport.handler).not.toBe(oldHandler));
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
  it("switches away from a retired resume Model when opening a cold Session", async () => {
    const { adapter, transports } = fixture();
    const nativeRef = ref();
    const { session, outputs } = await sessionOf(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef,
        model: model("gemini-4-carbon"),
        thinkingOptionId: thinking("xhigh"),
        permissionModeId: mode("dangerously-skip-permissions"),
      }),
    );
    expect(transports).toHaveLength(0);
    expect(
      await session.execute({ type: "model.select", model: model("still-retired") }),
    ).toMatchObject({
      ok: false,
      error: { code: "unsupported", message: expect.stringContaining("still-retired") },
    });
    expect(transports).toHaveLength(1);
    expect(transports[0]?.close).toHaveBeenCalledTimes(1);

    expect(await session.execute({ type: "model.select", model: model("claude") })).toEqual({
      ok: true,
      value: { completed: true },
    });
    expect(transports).toHaveLength(2);
    expect(transports[1]?.skipPermissions).toBe(true);
    expect(transports[1]?.setConfigOption.mock.calls).toEqual([["model", "claude"]]);
    expect(session.initialState).toMatchObject({
      effectiveModel: model("claude"),
      effectiveThinkingOptionId: "low",
      effectivePermissionModeId: "dangerously-skip-permissions",
    });
    expect(events(outputs).filter((event) => event.type === "session.state.changed")).toEqual([
      expect.objectContaining({
        type: "session.state.changed",
        state: expect.objectContaining({
          effectiveModel: model("claude"),
          effectiveThinkingOptionId: "low",
          effectivePermissionModeId: "dangerously-skip-permissions",
        }),
      }),
    ]);
  });
  it("does not publish or submit a prompt on the old Model when selection overlaps a successful cold open", async () => {
    const opening = deferred<undefined>();
    const confirmed = deferred<AntigravityAcpConfigOption[]>();
    const { adapter, transports } = fixture({}, (transport) => {
      transport.initialize.mockImplementationOnce(async () => {
        await opening.promise;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      transport.queuedSessionEvents.push({ type: "config.update", configOptions: config() });
    });
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    expect(
      await session.execute({
        type: "turn.start",
        turnId: turnId("t1"),
        input: [{ type: "text", text: "hello" }],
      }),
    ).toMatchObject({ ok: true });
    const transport = required(transports[0]);
    transport.setConfigOption.mockImplementationOnce(async () => {
      transport.eventHandler?.({ type: "config.update", configOptions: config() });
      return confirmed.promise;
    });
    const selected = session.execute({ type: "model.select", model: model("claude") });
    const states = () => events(outputs).filter((event) => event.type === "session.state.changed");
    opening.resolve(undefined);
    await vi.waitFor(() => expect(transport.setConfigOption).toHaveBeenCalled());
    expect(states()).toEqual([]);
    expect(transport.prompt).not.toHaveBeenCalled();
    confirmed.resolve(
      config().map((entry) =>
        entry.id === "model" ? { ...entry, currentValue: "claude" } : entry,
      ),
    );
    expect(await selected).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalled());
    expect(states()).toMatchObject([{ state: { effectiveModel: model("claude") } }]);
    transport.result.resolve({ stopReason: "end_turn" });
    await completed(outputs);
  });
  it("recovers cold Model selection when an in-flight cold open fails on a retired Model", async () => {
    const gate = deferred<{
      opened: {
        sessionId: string;
        configOptions: AntigravityAcpConfigOption[];
        modes: { currentModeId: string; availableModes: [] };
      };
    }>();
    const { adapter, transports } = fixture();
    const originalCreate = required(adapter.options.createTransport);
    adapter.options.createTransport = (options) => {
      const transport = originalCreate(options) as FakeTransport;
      if (transports.length === 1) {
        transport.openSession.mockImplementationOnce(() => gate.promise);
      }
      return transport;
    };
    const nativeRef = ref();
    const { session } = await sessionOf(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef,
        model: model("gemini-4-carbon"),
        thinkingOptionId: thinking("high"),
      }),
    );
    if (!(session instanceof AntigravitySession)) throw new Error("Expected AntigravitySession");
    const initPromise = session.initialize().catch((error: unknown) => error);
    await vi.waitFor(() => expect(transports[0]?.openSession).toHaveBeenCalledTimes(1));

    const selectPromise = session.execute({ type: "model.select", model: model("claude") });
    gate.resolve({
      opened: {
        sessionId: nativeRef.nativeSessionId,
        configOptions: config(),
        modes: { currentModeId: "default", availableModes: [] },
      },
    });

    expect(await initPromise).toBeInstanceOf(AntigravityTransportError);
    expect(await selectPromise).toEqual({ ok: true, value: { completed: true } });
    expect(transports).toHaveLength(2);
    expect(session.initialState.effectiveModel).toEqual(model("claude"));
  });
  it("ignores an unsupported saved Thinking option when resuming a cold Session", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: ref(),
        model: model("claude"),
        thinkingOptionId: thinking("xhigh"),
      }),
    );
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: mode("plan"),
      }),
    ).toEqual({ ok: true, value: { completed: true } });
    expect(transports[0]?.setConfigOption.mock.calls).toEqual([["model", "claude"]]);
    expect(transports[0]?.setMode).toHaveBeenCalledWith("plan");
    expect(session.initialState).toMatchObject({
      effectiveModel: model("claude"),
      effectiveThinkingOptionId: "low",
      effectivePermissionModeId: "plan",
    });
    expect(events(outputs).filter((event) => event.type === "session.state.changed")).toEqual([
      expect.objectContaining({
        type: "session.state.changed",
        state: expect.objectContaining({
          effectiveModel: model("claude"),
          effectiveThinkingOptionId: "low",
          effectivePermissionModeId: "plan",
        }),
      }),
    ]);
  });
  it("publishes final thinking state in a single change on effort-suffixed Model selection", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "create", cwd: process.cwd() }),
    );
    await start(session, transports);
    const before = events(outputs).filter((event) => event.type === "session.state.changed").length;
    expect(await session.execute({ type: "model.select", model: model("gemini-high") })).toEqual({
      ok: true,
      value: { completed: true },
    });
    const stateEvents = events(outputs).filter((event) => event.type === "session.state.changed");
    expect(stateEvents).toHaveLength(before + 1);
    expect(stateEvents.at(-1)).toMatchObject({
      type: "session.state.changed",
      state: expect.objectContaining({
        effectiveModel: model("gemini"),
        effectiveThinkingOptionId: "high",
      }),
    });
  });
  it("selects a valid Thinking option on a cold Session with stale unsupported Thinking and serializes concurrent selections", async () => {
    const { adapter, transports } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: ref(),
        model: model("claude"),
        thinkingOptionId: thinking("xhigh"),
      }),
    );
    const [first, second] = await Promise.all([
      session.execute({ type: "model.select", model: model("gemini") }),
      session.execute({ type: "thinking.select", thinkingOptionId: thinking("high") }),
    ]);
    expect(first).toEqual({ ok: true, value: { completed: true } });
    expect(second).toEqual({ ok: true, value: { completed: true } });
    expect(transports).toHaveLength(1);
    expect(session.initialState).toMatchObject({
      effectiveModel: model("gemini"),
      effectiveThinkingOptionId: "high",
    });
    expect(events(outputs).filter((event) => event.type === "session.state.changed")).toHaveLength(
      2,
    );
  });
  it("publishes the opened connected state when a cold Thinking selection rejects", async () => {
    const { adapter } = fixture();
    const { session, outputs } = await sessionOf(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: ref(),
        model: model("claude"),
        thinkingOptionId: thinking("xhigh"),
      }),
    );
    expect(
      await session.execute({ type: "thinking.select", thinkingOptionId: thinking("xhigh") }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(session.initialState).toMatchObject({
      effectiveModel: model("claude"),
      effectiveThinkingOptionId: "low",
    });
    expect(events(outputs).filter((event) => event.type === "session.state.changed")).toHaveLength(
      1,
    );
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
    expect(prompt).toContain("harness inspect --help");
    expect(prompt).toContain("the exact advertised Model Ref for the requested speed");
  });
  it("reads cold SQLite history, then resumes with the saved configuration for writing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-history-resume-"));
    directories.push(home);
    const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
    const nativeRef = ref(undefined, { permissionModeId: "dangerously-skip-permissions" });
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      userStep(db, 0, "old question");
      answerStep(db, 1, "old answer");
      const { session, outputs } = await sessionOf(
        await adapter.open({
          kind: "resume",
          cwd: home,
          nativeRef,
          model: model("claude"),
          thinkingOptionId: thinking("high"),
        }),
      );
      const snapshot = await session.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: { turns: [{ nativeTurnRef: { nativeTurnKey: "turn-0" } }] },
      });
      expect(snapshot.ok && snapshot.value.state).toBeUndefined();
      expect(session.initialState).toEqual({ nativeRef });
      expect(transports).toHaveLength(0);
      const writer = await start(session, transports);
      expect(writer.skipPermissions).toBe(true);
      expect(writer.openSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: "resume", sessionId: nativeRef.nativeSessionId }),
      );
      expect(session.initialState).toMatchObject({
        effectiveModel: model("claude"),
        effectiveThinkingOptionId: "high",
      });
      userStep(db, 2, "hello");
      writer.result.resolve({ stopReason: "end_turn" });
      await completed(outputs);
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({
          type: "turn.completed",
          nativeTurnRef: expect.objectContaining({ nativeTurnKey: "turn-1" }),
        }),
      );
    } finally {
      db.close();
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
        }));
        return transport;
      },
    });
    adapters.push(broken);
    const { session: brokenSession } = await sessionOf(
      await broken.open({ kind: "resume", cwd: process.cwd(), nativeRef: ref() }),
    );
    assert(brokenSession instanceof AntigravitySession);
    await expect(brokenSession.initialize()).rejects.toMatchObject({ kind: "protocolError" });
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
    "refreshing project availability invalidates the default model catalog without mixing directories",
    async () => {
      const project = await mkdtemp(path.join(os.tmpdir(), "agy-catalog-"));
      directories.push(project);
      const command = path.join(project, "agy");
      const writeModels = (model: string) =>
        writeFile(
          command,
          `#!/bin/sh\nif [ "$1" = '--version' ]; then echo 'agy 1.5.8'; else printf '${model}\\t%s\\n' "$PWD"; fi\n`,
          { mode: 0o755 },
        );
      const { adapter } = fixture({ command });
      await writeModels("old-model");
      expect(await adapter.inspect()).toMatchObject({
        catalog: { models: [{ ref: { id: "old-model" } }] },
      });
      await adapter.inspect({ cwd: project });
      await writeModels("new-model");
      await adapter.inspect({ cwd: project, purpose: "availability", refresh: true });
      expect(await adapter.inspect()).toMatchObject({
        catalog: { models: [{ ref: { id: "new-model" }, label: await realpath(process.cwd()) }] },
      });
      expect(await adapter.inspect({ cwd: project })).toMatchObject({
        catalog: { models: [{ ref: { id: "new-model" }, label: await realpath(project) }] },
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

describe("Antigravity foreground native commits", () => {
  async function setup() {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-turn-commit-"));
    directories.push(home);
    const nativeRef = ref();
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
    const { session, outputs } = await sessionOf(
      await adapter.open({ kind: "resume", nativeRef, cwd: home }),
    );
    const transport = await start(session, transports);
    return { home, nativeRef, session, outputs, transport, db };
  }

  function nextRead() {
    const readCount = nativeBoundaries.readNativeTurnCount;
    const firstRead = deferred<number>();
    vi.spyOn(nativeBoundaries, "readNativeTurnCount").mockImplementationOnce(async (file) => {
      const count = await readCount(file);
      firstRead.resolve(count);
      return count;
    });
    return firstRead.promise;
  }

  const terminal = (outputs: HarnessOutput[], id = "t1") =>
    required(
      events(outputs).find((event) => event.type === "turn.completed" && event.turnId === id),
    );

  it("publishes a durable Turn when the input commits after the first post-response read", async () => {
    const { session, outputs, transport, db } = await setup();
    const firstRead = nextRead();
    try {
      db.exec("BEGIN IMMEDIATE");
      userStep(db, 0, "hello", "prompt");
      answerStep(db, 1, "hello there", "prompt");
      required(transport.handler).onEvent({ type: "agent.text", text: "hello there" });
      transport.result.resolve({ stopReason: "end_turn" });
      expect(await firstRead).toBe(0);
      db.exec("COMMIT");
      await completed(outputs);
      expect(terminal(outputs)).toMatchObject({
        nativeTurnRef: { nativeTurnKey: "turn-0" },
        outcome: { status: "succeeded", checkpoint: { checkpointId: "turn-0" } },
      });
      expect(await session.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: [{ nativeTurnRef: { nativeTurnKey: "turn-0" } }] },
      });
    } finally {
      db.close();
    }
  });

  it.each(["no write", "unreadable"])(
    "does not fabricate an identity for success with %s",
    async (mode) => {
      const { outputs, transport, db } = await setup();
      try {
        if (mode === "unreadable") db.exec("ALTER TABLE steps RENAME TO unavailable_steps");
        required(transport.handler).onEvent({
          type: "agent.text",
          text: "output is not a boundary",
        });
        transport.result.resolve({ stopReason: "end_turn" });
        await completed(outputs);
        expect(terminal(outputs)).toEqual({
          type: "turn.completed",
          turnId: "t1",
          ephemeral: true,
          outcome: { status: "succeeded" },
        });
      } finally {
        db.close();
      }
    },
  );

  it.each(["cancel", "close", "fault"])(
    "settles only once on %s during the commit wait",
    async (action) => {
      const { session, outputs, transport, db } = await setup();
      const firstRead = nextRead();
      try {
        required(transport.handler).onResponse?.();
        transport.result.resolve({ stopReason: "end_turn" });
        expect(await firstRead).toBe(0);
        if (action === "cancel") {
          expect(await session.execute({ type: "turn.cancel", turnId: turnId("t1") })).toEqual({
            ok: true,
            value: { cancellationRequested: true },
          });
          expect(transport.cancel).not.toHaveBeenCalled();
        } else if (action === "close") await session.close();
        else
          transport.options.onFault?.(new AntigravityTransportError("processExited", "ACP exited"));
        userStep(db, 0, "hello", "prompt");
        await completed(outputs);
        expect(terminal(outputs)).toMatchObject({
          outcome: { status: action === "fault" ? "failed" : "cancelled" },
        });
        expect(terminal(outputs)).not.toHaveProperty("nativeTurnRef");
        expect(terminal(outputs)).not.toHaveProperty("ephemeral");
        if (action !== "fault") expect(transport.cancel).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it("settles a cancellation during usage collection without dropping the committed identity", async () => {
    const { session, outputs, transport, db } = await setup();
    const gate =
      deferred<
        Awaited<ReturnType<AntigravitySessionUsageTracker["collectNewTranscriptRequests"]>>
      >();
    const collect = vi
      .spyOn(AntigravitySessionUsageTracker.prototype, "collectNewTranscriptRequests")
      .mockReturnValueOnce(gate.promise);
    try {
      userStep(db, 0, "hello", "prompt");
      transport.result.resolve({ stopReason: "end_turn" });
      await vi.waitFor(() => expect(collect).toHaveBeenCalled());
      expect(await session.execute({ type: "turn.cancel", turnId: turnId("t1") })).toMatchObject({
        ok: true,
      });
      gate.resolve({ requests: [], timings: [], complete: true, usage: null });
      await completed(outputs);
      expect(terminal(outputs)).toMatchObject({
        nativeTurnRef: { nativeTurnKey: "turn-0" },
        outcome: { status: "cancelled", checkpoint: { checkpointId: "turn-0" } },
      });
      expect(transport.cancel).not.toHaveBeenCalled();
    } finally {
      gate.resolve({ requests: [], timings: [], complete: true, usage: null });
      db.close();
    }
  });

  it.each(["refusal", "cancelled"])(
    "preserves the native identity of a committed %s",
    async (stopReason) => {
      const { session, outputs, transport, db } = await setup();
      try {
        userStep(db, 0, "hello", "prompt");
        if (stopReason === "cancelled")
          await session.execute({ type: "turn.cancel", turnId: turnId("t1") });
        transport.result.resolve({ stopReason });
        await completed(outputs);
        expect(terminal(outputs)).toMatchObject({
          nativeTurnRef: { nativeTurnKey: "turn-0" },
          outcome: { status: stopReason === "refusal" ? "failed" : "cancelled" },
        });
      } finally {
        db.close();
      }
    },
  );

  it.each(["before the successor", "during the successor", "in the same batch as the successor"])(
    "attributes a late native boundary committed %s",
    async (when) => {
      const { session, outputs, transport, db } = await setup();
      const writeFirst = () => {
        userStep(db, 0, "hello", "first");
        answerStep(db, 1, "first answer", "first");
      };
      try {
        transport.result.resolve({ stopReason: "end_turn" });
        await completed(outputs);
        expect(terminal(outputs)).toMatchObject({ ephemeral: true });
        if (when === "before the successor") writeFirst();
        transport.result = deferred();
        expect(
          await session.execute({
            type: "turn.start",
            turnId: turnId("t2"),
            input: [{ type: "text", text: "second question" }],
          }),
        ).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalledTimes(2));
        if (when !== "before the successor") writeFirst();
        if (when !== "during the successor") {
          userStep(db, 2, "second question", "second");
          answerStep(db, 3, "second answer", "second");
        }
        transport.result.resolve({ stopReason: "end_turn" });
        await completed(outputs, "t2");
        if (when === "during the successor")
          expect(terminal(outputs, "t2")).not.toHaveProperty("nativeTurnRef");
        else
          expect(terminal(outputs, "t2")).toMatchObject({
            nativeTurnRef: { nativeTurnKey: "turn-1" },
          });
        const snapshot = await session.readSnapshot();
        assert(snapshot.ok);
        expect(snapshot.value.turns[0]).toMatchObject({
          input: [{ text: "hello" }],
          nativeTurnRef: { nativeTurnKey: "turn-0" },
          items: [{ item: { text: "first answer" } }],
        });
      } finally {
        db.close();
      }
    },
  );

  it("uses the last native input for a merged Turn and publishes a committed wake after it", async () => {
    const { session, outputs, transport, db } = await setup();
    const firstRead = nextRead();
    try {
      required(transport.handler).onResponse?.();
      transport.result.resolve({ stopReason: "end_turn" });
      expect(await firstRead).toBe(0);
      db.exec("BEGIN IMMEDIATE");
      userStep(db, 0, "hel", "prompt");
      userStep(db, 1, "lo", "prompt");
      answerStep(db, 2, "hello there", "prompt");
      systemStep(db, 3, "wake");
      answerStep(db, 4, "wake answer", "wake");
      transport.eventHandler?.({ type: "agent.text", text: "wake answer" });
      db.exec("COMMIT");
      await completed(outputs);
      expect(terminal(outputs)).toMatchObject({
        nativeTurnRef: { nativeTurnKey: "turn-1" },
        outcome: { checkpoint: { checkpointId: "turn-1" } },
      });
      await vi.waitFor(() => {
        expect(
          events(outputs).filter(
            ({ type }) => type === "turn.completed" || type === "turn.autonomous.completed",
          ),
        ).toMatchObject([
          { type: "turn.completed", turnId: "t1" },
          {
            type: "turn.autonomous.completed",
            snapshot: { nativeTurnRef: { nativeTurnKey: "wake-3" }, input: [] },
          },
        ]);
      });
      const snapshot = await session.readSnapshot();
      assert(snapshot.ok);
      expect(
        snapshot.value.turns.map(({ nativeTurnRef, input }) => [
          nativeTurnRef.nativeTurnKey,
          input,
        ]),
      ).toEqual([
        ["turn-1", [{ type: "text", text: "hello" }]],
        ["wake-3", []],
      ]);
    } finally {
      db.close();
    }
  });
});

describe("Antigravity idle wake Turns", () => {
  const wakes = (outputs: HarnessOutput[]) =>
    events(outputs).filter((event) => event.type === "turn.autonomous.completed");

  async function setup() {
    const home = await mkdtemp(path.join(os.tmpdir(), "agy-wake-"));
    directories.push(home);
    const { adapter, transports } = fixture({ environment: { HOME: home, USERPROFILE: home } });
    const { session, outputs } = await sessionOf(await adapter.open({ kind: "create", cwd: home }));
    const transport = await start(session, transports);
    const db = await createNativeHistoryDatabase(home, required(transport.sessionId));
    userStep(db, 0, "hello", "prompt");
    answerStep(db, 1, "hello there", "prompt");
    return { home, adapter, transports, session, outputs, transport, db };
  }

  it("keeps pre-submit idle output on the preceding native Turn", async () => {
    const { home, adapter, session, outputs, transport, db } = await setup();
    try {
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs);
      const usageGate =
        deferred<
          Awaited<ReturnType<AntigravitySessionUsageTracker["collectNewTranscriptRequests"]>>
        >();
      const collect = vi
        .spyOn(AntigravitySessionUsageTracker.prototype, "collectNewTranscriptRequests")
        .mockReturnValueOnce(usageGate.promise);
      const refresh = session.refreshUsage?.();
      await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce());
      transport.result = deferred();
      await start(session, [transport], "t2");
      // Same run ID as the first prompt, not a new autonomous wake.
      systemStep(db, 2, "prompt");
      answerStep(db, 3, "late reply", "prompt");
      transport.eventHandler?.({ type: "agent.text", text: "late reply" });
      usageGate.resolve({ requests: [], timings: [], complete: true, usage: null });
      await refresh;
      await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalledTimes(2));
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs, "t2");
      expect(wakes(outputs)).toEqual([]);
      expect(events(outputs).some(({ type }) => type === "item.background.started")).toBe(false);
      const snapshot = await session.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          turns: [
            {
              input: [{ text: "hello" }],
              items: [{ item: { text: "hello there\n\nlate reply" } }],
            },
          ],
        },
      });
      const nativeRef = required(session.initialState.nativeRef);
      await session.close();
      const reopened = await adapter.open({ kind: "resume", cwd: home, nativeRef });
      assert(reopened.ok);
      const cold = await reopened.value.readSnapshot();
      assert(snapshot.ok && cold.ok);
      expect(cold.value.turns).toEqual(snapshot.value.turns);
    } finally {
      db.close();
    }
  });

  it("does not assign orphan idle output to a cancelled pre-submit successor or its predecessor", async () => {
    const { session, outputs, transport, db } = await setup();
    try {
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs);
      const usageGate =
        deferred<
          Awaited<ReturnType<AntigravitySessionUsageTracker["collectNewTranscriptRequests"]>>
        >();
      const collect = vi
        .spyOn(AntigravitySessionUsageTracker.prototype, "collectNewTranscriptRequests")
        .mockReturnValueOnce(usageGate.promise);
      const refresh = session.refreshUsage?.();
      await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce());
      await start(session, [transport], "cancel-before-submit");
      expect(
        await session.execute({ type: "turn.cancel", turnId: turnId("cancel-before-submit") }),
      ).toEqual({ ok: true, value: { cancellationRequested: true } });
      usageGate.resolve({ requests: [], timings: [], complete: true, usage: null });
      await refresh;
      await completed(outputs, "cancel-before-submit");
      transport.eventHandler?.({ type: "agent.text", text: "orphan" });
      await setImmediate();
      expect(wakes(outputs)).toEqual([]);
      expect(events(outputs).some(({ type }) => type === "item.background.started")).toBe(false);
    } finally {
      await session.close();
      db.close();
    }
  });

  it("publishes committed idle output once, with the same identity and items as cold history", async () => {
    const { home, adapter, session, outputs, transport, db } = await setup();
    try {
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs);
      systemStep(db, 2, "wake");
      systemStep(db, 3, "wake");
      transport.eventHandler?.({ type: "agent.thought", text: "wake in progress" });
      expect(wakes(outputs)).toEqual([]);
      answerStep(db, 4, "wake answer", "wake");
      // No ACP stop response is sent for a wake, and no new user prompt is needed.
      await vi.waitFor(() => expect(wakes(outputs)).toHaveLength(1));
      expect(wakes(outputs)[0]?.snapshot).toMatchObject({
        input: [],
        nativeTurnRef: { nativeTurnKey: "wake-2" },
        items: [{ item: { type: "agentMessage", text: "wake answer" } }],
      });
      transport.eventHandler?.({ type: "agent.text", text: "wake answer" });
      transport.result = deferred();
      await start(session, [transport], "t2");
      await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalledTimes(2));
      userStep(db, 5, "next", "next");
      answerStep(db, 6, "next answer", "next");
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs, "t2");
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({
          type: "turn.completed",
          turnId: "t2",
          nativeTurnRef: expect.objectContaining({ nativeTurnKey: "turn-1" }),
        }),
      );
      const nativeRef = required(session.initialState.nativeRef);
      await session.close();
      const reopened = await adapter.open({ kind: "resume", cwd: home, nativeRef });
      assert(reopened.ok);
      const snapshot = await reopened.value.readSnapshot();
      assert(snapshot.ok);
      expect(snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
        "turn-0",
        "wake-2",
        "turn-1",
      ]);
      expect(snapshot.value.turns[0]?.items.map(({ item }) => item)).toMatchObject([
        { text: "hello there" },
      ]);
      expect(wakes(outputs).map((event) => event.snapshot)).toEqual([snapshot.value.turns[1]]);
    } finally {
      db.close();
    }
  });

  it("keeps polling after a notification whose wake has not reached SQLite", async () => {
    const { session, outputs, transport, db } = await setup();
    try {
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs);
      systemStep(db, 2, "first-wake");
      answerStep(db, 3, "first answer", "first-wake");
      // At the first poll only A exists; B's sole notification precedes even its system step.
      transport.eventHandler?.({ type: "agent.text", text: "second answer" });
      await vi.waitFor(() => expect(wakes(outputs)).toHaveLength(1));
      expect(wakes(outputs)[0]?.snapshot.nativeTurnRef.nativeTurnKey).toBe("wake-2");
      systemStep(db, 4, "second-wake");
      answerStep(db, 5, "second answer", "second-wake");
      await vi.waitFor(() =>
        expect(wakes(outputs).map(({ snapshot }) => snapshot.nativeTurnRef.nativeTurnKey)).toEqual([
          "wake-2",
          "wake-4",
        ]),
      );
    } finally {
      await session.close();
      db.close();
    }
  });

  it("accepts a new prompt while an idle tool wake is not ready to publish", async () => {
    const { session, outputs, transport, db } = await setup();
    try {
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs);
      systemStep(db, 2, "wake");
      transport.eventHandler?.({ type: "tool.call", toolCallId: "shell", name: "run_command" });
      transport.result = deferred();
      expect(
        await session.execute({
          type: "turn.start",
          turnId: turnId("t2"),
          input: [{ type: "text", text: "next" }],
        }),
      ).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalledTimes(2));
      expect(wakes(outputs)).toEqual([]);
      userStep(db, 4, "next", "next");
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs, "t2");
      expect(wakes(outputs)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("observes updates after the wire response without publishing ahead of the user terminal", async () => {
    const { session, outputs, transport, db } = await setup();
    try {
      const gate = deferred<number>();
      vi.spyOn(nativeBoundaries, "readNativeTurnCount").mockReturnValueOnce(gate.promise);
      transport.handler?.onResponse?.();
      transport.result.resolve({ stopReason: "end_turn" });
      systemStep(db, 2, "wake");
      answerStep(db, 3, "wake answer", "wake");
      transport.eventHandler?.({ type: "agent.text", text: "wake answer" });
      expect(wakes(outputs)).toEqual([]);
      gate.resolve(1);
      await vi.waitFor(() => expect(wakes(outputs)).toHaveLength(1));
      const all = events(outputs);
      expect(all.findIndex((event) => event.type === "turn.autonomous.completed")).toBeGreaterThan(
        all.findIndex((event) => event.type === "turn.completed" && event.turnId === "t1"),
      );
      await session.close();
    } finally {
      db.close();
    }
  });

  it.each(["close", "fault"])("does not publish an incomplete wake after %s", async (end) => {
    const { session, outputs, transport, db } = await setup();
    try {
      transport.result.resolve({ stopReason: "end_turn" });
      await completed(outputs);
      systemStep(db, 2, "wake");
      transport.eventHandler?.({ type: "agent.thought", text: "partial" });
      if (end === "close") await session.close();
      else
        transport.options.onFault?.(new AntigravityTransportError("processExited", "ACP exited"));
      answerStep(db, 3, "too late", "wake");
      await setImmediate();
      expect(wakes(outputs)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
