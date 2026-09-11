import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexTurnProjector } from "@codexhost/protocol-core";

import type { HarnessOutput, HostEvent, HostInteraction } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeCatalogSchema,
  hostTurnIdSchema,
  type HarnessPermissionModeCatalog,
  type HostTurnId,
} from "@codexhost/shared-contracts";

import {
  ModernJournalError,
  openModernJournal,
  type ModernJournal,
  type ModernJournalEvent,
  type ModernJournalLiveItem,
  type ModernJournalRemote,
} from "../../src/modern/journal.js";
import {
  DEEPSEEK_V012_PROFILE,
  DEEPSEEK_V015_PROFILE,
  type DeepSeekModernProfile,
} from "../../src/profiles/profile.js";
import { parseModernModelCatalog } from "../../src/modern/catalog.js";
import type {
  ModernControlJsonValue,
  ModernProjectionRow,
  ModernProjectionSeed,
} from "../../src/modern/control-store.js";
import {
  ModernRemoteConnectionError,
  type ModernRemoteCallOptions,
} from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";
import {
  ModernEventGateway,
  type ModernApprovalDelivery,
  type ModernQuestionDelivery,
} from "../../src/modern/event-gateway.js";
import {
  MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
  ModernHarnessSession,
  type ModernSessionControl,
} from "../../src/modern/session.js";

const SESSION_ID = "modern-session";
const MODEL_CATALOG = parseModernModelCatalog({
  default: { provider: "deepseek", model: "deepseek-v4" },
  routableProviders: ["deepseek"],
  groups: [
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [
        {
          id: "deepseek-v4",
          name: "DeepSeek V4",
          reasoning: {
            efforts: [
              { id: "off", name: "Off" },
              { id: "high", name: "High" },
            ],
            defaultEffort: "high",
          },
        },
      ],
    },
  ],
  failures: [],
});
const PERMISSION_CATALOG = harnessPermissionModeCatalogSchema.parse({
  modes: [
    { id: "ask", label: "Ask" },
    { id: "danger-full-access", label: "Full access", dangerous: true },
  ],
  defaultModeId: "ask",
});

class FakeControl implements ModernSessionControl {
  readonly #listeners = new Map<string, Set<(row: ModernProjectionRow | undefined) => void>>();
  readonly #rows: Record<string, ModernProjectionRow>;

  constructor(permissionModeId?: string) {
    this.#rows = {
      modelSelection: {
        value: {
          lastUsed: null,
          next: { provider: "deepseek", model: "deepseek-v4", reasoningEffort: "high" },
        },
        seq: 0,
      },
      ...(permissionModeId
        ? { permissions: { value: permissionValue(permissionModeId), seq: 0 } }
        : {}),
    };
  }

  seed(_sessionId: string, seed: ModernProjectionSeed): void {
    for (const [key, value] of Object.entries(seed.values)) {
      const current = this.#rows[key];
      if (!current || current.seq < seed.asOfSeq) {
        this.update(key, value as ModernControlJsonValue, seed.asOfSeq);
      }
    }
  }

  snapshot(): Readonly<Record<string, ModernProjectionRow>> {
    return this.#rows;
  }

  subscribe(
    _sessionId: string,
    key: string,
    listener: (row: ModernProjectionRow | undefined) => void,
  ): () => void {
    let listeners = this.#listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  waitFor(
    _sessionId: string,
    key: string,
    afterSeq: number,
    predicate: (value: ModernControlJsonValue) => boolean,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ModernProjectionRow> {
    const current = this.#rows[key];
    if (current && current.seq > afterSeq && predicate(current.value)) {
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        unsubscribe();
        reject(new Error("cancelled"));
      };
      const unsubscribe = this.subscribe(SESSION_ID, key, (row) => {
        if (!row || row.seq <= afterSeq || !predicate(row.value)) return;
        options.signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve(row);
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  update(key: string, value: ModernControlJsonValue, seq: number): void {
    const row = { value, seq } as ModernProjectionRow;
    this.#rows[key] = row;
    for (const listener of this.#listeners.get(key) ?? []) listener(row);
  }
}

class EventFeed
  implements AsyncIterable<ModernJournalLiveItem>, AsyncIterator<ModernJournalLiveItem>
{
  readonly #items: IteratorResult<ModernJournalLiveItem>[] = [];
  #pending: ((item: IteratorResult<ModernJournalLiveItem>) => void) | undefined;
  #done = false;
  readonly seen: ModernJournalEvent[] = [];

  push(value: ModernJournalLiveItem): void {
    if (this.#done) return;
    if (!("frame" in value)) this.seen.push(value);
    this.#deliver({ done: false, value });
  }

  finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#deliver({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<ModernJournalLiveItem>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve(item);
    if (this.#done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.#pending = resolve;
    });
  }

  return(): Promise<IteratorResult<ModernJournalLiveItem>> {
    this.finish();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ModernJournalLiveItem> {
    return this;
  }

  #deliver(item: IteratorResult<ModernJournalLiveItem>): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) pending(item);
    else this.#items.push(item);
  }
}

type CallHandler = (
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  options: ModernRemoteCallOptions | undefined,
) => ModernRemoteResult<unknown> | Promise<ModernRemoteResult<unknown>>;

class FakeRemote implements ModernJournalRemote {
  readonly calls: Array<{
    endpoint: string;
    args: Readonly<Record<string, unknown>>;
    signal: AbortSignal | undefined;
    options: ModernRemoteCallOptions | undefined;
  }> = [];
  streamCalls = 0;
  onUnscriptedCancel?: () => void;

  constructor(
    readonly handlers: CallHandler[],
    readonly replacementFeeds: AsyncIterable<unknown>[] = [],
  ) {}

  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    options?: ModernRemoteCallOptions,
  ): Promise<ModernRemoteResult<T>> {
    this.calls.push({ endpoint, args, signal, options });
    const handler = this.handlers.shift();
    if (!handler && endpoint === "session/cancel" && this.onUnscriptedCancel) {
      this.onUnscriptedCancel();
      return Promise.resolve(accepted()) as Promise<ModernRemoteResult<T>>;
    }
    if (!handler) return Promise.reject(new Error(`unexpected call: ${endpoint}`));
    return Promise.resolve(handler(endpoint, args, signal, options)) as Promise<
      ModernRemoteResult<T>
    >;
  }

  openStream<T>(): AsyncIterable<T> {
    this.streamCalls += 1;
    const feed = this.replacementFeeds.shift();
    if (!feed) throw new Error("unexpected openStream");
    return feed as AsyncIterable<T>;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  surface = false,
): ModernJournalEvent {
  return {
    type,
    seq,
    time: 1_000 + seq,
    data: data as never,
    ...(surface ? { surfaceOp: "append" as const } : {}),
  };
}

function eventBytes(value: ModernJournalEvent): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function userMessage(seq: number, text: string, rpcId?: string): ModernJournalEvent {
  return sourcedUserMessage(seq, text, {
    kind: "user",
    ...(rpcId === undefined ? {} : { rpcId }),
  });
}

function sourcedUserMessage(
  seq: number,
  text: string,
  source: Readonly<Record<string, unknown>>,
): ModernJournalEvent {
  return event(
    seq,
    "user/message",
    {
      id: `user-${seq}`,
      role: "user",
      content: [{ type: "text", text }],
      source,
    },
    true,
  );
}

function requestHeader(seq: number): ModernJournalEvent {
  return event(seq, "request/header", {
    header: { config: { provider: "deepseek", model: "deepseek-v4" } },
    reason: "initial",
  });
}

function inboxAdmission(seq: number, rpcId: string): ModernJournalEvent {
  return event(seq, "agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    inserted: [
      {
        id: `inbox-${seq}`,
        role: "user",
        content: [{ type: "text", text: "queued" }],
        source: { kind: "user", rpcId },
      },
    ],
  });
}

function assistantMessage(
  seq: number,
  text: string,
  reasoning: string,
  usage: unknown = { inputTokens: 2, outputTokens: 1 },
): ModernJournalEvent {
  return event(
    seq,
    "assistant/message",
    {
      turn: 1,
      step: 1,
      message: {
        id: `assistant-${seq}`,
        role: "assistant",
        content: [
          { type: "reasoning", text: reasoning },
          { type: "text", text },
          { type: "tool-call", id: "call-1", name: "write", arguments: "{}" },
        ],
        source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
      },
      usage,
    },
    true,
  );
}

function finalAssistantMessage(
  seq: number,
  turn: number,
  text: string,
  reasoning: string,
  step = 1,
): ModernJournalEvent {
  return event(
    seq,
    "assistant/message",
    {
      turn,
      step,
      message: {
        id: `assistant-${seq}`,
        role: "assistant",
        content: [
          { type: "reasoning", text: reasoning },
          { type: "text", text },
        ],
        source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
    true,
  );
}

function toolResult(seq: number): ModernJournalEvent {
  return event(
    seq,
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: {
        id: `result-${seq}`,
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "ok" }],
          },
        ],
        source: { kind: "tool", callId: "call-1" },
      },
      meta: { diffs: [{ path: "a.txt", oldText: null, newText: "x\n" }] },
    },
    true,
  );
}

function accepted(): ModernRemoteResult<unknown> {
  return { ok: true, value: { accepted: true } };
}

function permissionValue(currentValue: string): ModernControlJsonValue {
  return {
    options: PERMISSION_CATALOG.modes.map(({ id, label }) => ({ value: id, name: label })),
    currentValue,
  } as ModernControlJsonValue;
}

function turnId(value: string): HostTurnId {
  return hostTurnIdSchema.parse(value);
}

function setup(
  handlers: CallHandler[],
  history: ModernJournalEvent[] = [],
  uuids = ["autonomous-1", "request-1", "request-2"],
  promptCorrelationGraceMs = 5_000,
  permissionModes: HarnessPermissionModeCatalog | null = null,
  maxHistoryBytes?: number,
  acceptedCorrelationTimeoutMs = MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
  replacementFeeds: AsyncIterable<unknown>[] = [],
  profile: DeepSeekModernProfile = DEEPSEEK_V012_PROFILE,
  maxBufferedLiveBytes?: number,
  observationOnly = false,
): {
  feed: EventFeed;
  remote: FakeRemote;
  control: FakeControl;
  journal: ModernJournal & { closeCalls: number };
  session: ModernHarnessSession;
} {
  const feed = new EventFeed();
  const remote = new FakeRemote(handlers, replacementFeeds);
  const control = new FakeControl(permissionModes ? permissionModes.defaultModeId : undefined);
  const journal: ModernJournal & { closeCalls: number } = {
    profile,
    header:
      profile.sessionFormatVersion === 3
        ? { version: 3, id: SESSION_ID, createdAt: 1, isSeeded: false }
        : { version: 0, id: SESSION_ID, createdAt: 1 },
    cursor: history.length - 1,
    projections: { asOfSeq: history.length - 1, values: {} },
    events: history,
    live: feed,
    closeCalls: 0,
    close(): Promise<void> {
      this.closeCalls += 1;
      feed.finish();
      return Promise.resolve();
    },
  };
  // Native cancellation completes the journal before the transport detaches.
  remote.onUnscriptedCancel = () => {
    const entries = [...history, ...feed.seen];
    let seq = (entries.at(-1)?.seq ?? -1) + 1;
    const start = entries.findLast((entry) => entry.type === "turn/start");
    const turn = (start?.data as { turn?: number } | undefined)?.turn;
    const step = entries.findLast((entry) => entry.type === "step/start");
    const stepEnd = entries.findLast((entry) => entry.type === "step/end");
    const turnEnd = entries.findLast((entry) => entry.type === "turn/end");
    if (turn !== undefined && start && (!turnEnd || start.seq > turnEnd.seq)) {
      if (step && (!stepEnd || step.seq > stepEnd.seq))
        feed.push(event(seq++, "step/end", { turn, step: (step.data as { step: number }).step }));
      feed.push(
        event(seq, "turn/end", { turn, reason: { kind: "aborted", reason: { kind: "user" } } }),
      );
    }
  };
  let uuidIndex = 0;
  const session = new ModernHarnessSession({
    remote,
    journal,
    control,
    eventGateway: new ModernEventGateway(remote),
    modelCatalog: MODEL_CATALOG,
    permissionModes,
    sessionId: SESSION_ID,
    observationOnly,
    randomUUID: () => uuids[uuidIndex++] ?? `uuid-${uuidIndex}`,
    now: () => 10,
    promptCorrelationGraceMs,
    acceptedCorrelationTimeoutMs,
    ...(maxHistoryBytes === undefined ? {} : { maxHistoryBytes }),
    ...(maxBufferedLiveBytes === undefined ? {} : { maxBufferedLiveBytes }),
  });
  return { feed, remote, control, journal, session };
}

afterEach(() => {
  vi.useRealTimers();
});

async function nextEvent(iterator: AsyncIterator<HarnessOutput>): Promise<HostEvent> {
  const next = await iterator.next();
  expect(next.done).toBe(false);
  expect(next.value?.kind).toBe("event");
  return (next.value as Extract<HarnessOutput, { kind: "event" }>).event;
}

async function nextInteraction(iterator: AsyncIterator<HarnessOutput>): Promise<HostInteraction> {
  const next = await iterator.next();
  expect(next.done).toBe(false);
  expect(next.value?.kind).toBe("interaction");
  return (next.value as Extract<HarnessOutput, { kind: "interaction" }>).interaction;
}

function approvalDelivery(
  eventId: string,
  respond: ModernApprovalDelivery["respond"],
  request: ModernApprovalDelivery["request"] = {
    toolName: "write",
    callId: "call-1",
    reason: "Allow write?",
  },
): ModernApprovalDelivery {
  return { type: "approval", eventId, sessionId: SESSION_ID, request, respond };
}

function questionDelivery(
  eventId: string,
  request: ModernQuestionDelivery["request"],
  respond: ModernQuestionDelivery["respond"],
  reject: ModernQuestionDelivery["reject"],
): ModernQuestionDelivery {
  return { type: "question", eventId, sessionId: SESSION_ID, request, respond, reject };
}

function beginAutonomousTurn(test: ReturnType<typeof setup>): void {
  test.feed.push(event(0, "turn/start", { turn: 1 }));
  test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
  test.feed.push(
    sourcedUserMessage(2, "goal context", {
      kind: "goal",
      goalId: "goal-1",
      revision: 1,
      round: 1,
    }),
  );
  test.feed.push(requestHeader(3));
}

function finishNativeTurn(test: ReturnType<typeof setup>): void {
  test.feed.push(event(4, "step/end", { turn: 1, step: 1 }));
  test.feed.push(event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));
}

async function eventsThrough(
  iterator: AsyncIterator<HarnessOutput>,
  terminalType: HostEvent["type"],
): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  while (events.at(-1)?.type !== terminalType) events.push(await nextEvent(iterator));
  return events;
}

async function waitForGraceTimer(): Promise<void> {
  for (let attempt = 0; attempt < 10 && vi.getTimerCount() === 0; attempt += 1) {
    await Promise.resolve();
  }
  expect(vi.getTimerCount()).toBe(1);
}

describe("DeepSeek Harness Modern Session", () => {
  it.each(["status", "providerRetryAfterMs"])(
    "does not reconnect when a V3 finish contains an invalid %s",
    async (field) => {
      const follow = new EventFeed();
      follow.push({
        type: "snapshot",
        header: { version: 3, id: SESSION_ID, createdAt: 1, isSeeded: false },
        cursor: -1,
        records: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: {} },
        assistantStream: { revision: 0 },
      } as never);
      const remote = new FakeRemote([], [follow]);
      const journal = await openModernJournal(
        remote,
        { sessionId: SESSION_ID },
        { profile: DEEPSEEK_V015_PROFILE },
      );
      const session = new ModernHarnessSession({
        remote,
        journal,
        control: new FakeControl(),
        eventGateway: new ModernEventGateway(remote),
        modelCatalog: MODEL_CATALOG,
        permissionModes: null,
        sessionId: SESSION_ID,
      });
      const outputs = session.outputs[Symbol.asyncIterator]();
      try {
        follow.push({
          type: "assistant-stream",
          frame: {
            type: "start",
            attemptId: "a",
            revision: 1,
            startedAfterSeq: -1,
            turn: 1,
            step: 1,
          },
        });
        follow.push({
          type: "assistant-stream",
          frame: {
            type: "chunk",
            attemptId: "a",
            revision: 2,
            index: 0,
            time: 1,
            chunk: {
              type: "finish",
              reason: {
                kind: "error",
                failure: { message: "fixture", code: "fixture", [field]: 1.5 },
              },
            },
          },
        });
        const emitted = await eventsThrough(outputs, "session.faulted");
        expect(emitted.at(-1)).toMatchObject({
          type: "session.faulted",
          error: { code: "protocolError", retryable: false },
        });
        expect(remote.streamCalls).toBe(1);
      } finally {
        await session.close();
      }
    },
  );

  it("does not revisit the excluded durable prefix when a V3 attempt starts at the tail", async () => {
    const history = [
      event(0, "agent-preset/selected", { agentPreset: "standard" }),
      event(1, "turn/start", { turn: 1 }),
      event(2, "step/start", { turn: 1, step: 1 }),
      userMessage(3, "continue"),
    ];
    const test = setup(
      [],
      history,
      ["cursor-test"],
      5_000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [],
      DEEPSEEK_V015_PROFILE,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await eventsThrough(outputs, "turn.started");
    const readPrefix = vi.fn();
    for (const entry of history) {
      const seq = entry.seq;
      Object.defineProperty(entry, "seq", {
        configurable: true,
        get: () => {
          readPrefix();
          return seq;
        },
      });
    }
    try {
      test.feed.push({
        type: "assistant-stream",
        frame: {
          type: "start",
          attemptId: "tail",
          revision: 1,
          startedAfterSeq: 3,
          turn: 1,
          step: 1,
        },
      });
      test.feed.push({
        type: "assistant-stream",
        frame: {
          type: "chunk",
          attemptId: "tail",
          revision: 2,
          index: 0,
          time: 1,
          chunk: { type: "text-delta", index: 0, text: "live" },
        },
      });
      expect((await eventsThrough(outputs, "item.updated")).at(-1)).toMatchObject({
        update: { type: "text.append", text: "live" },
      });
      expect(readPrefix).not.toHaveBeenCalled();
    } finally {
      await test.session.close();
    }
  });

  it("retains live history at the exact byte bound and faults without replacement past it", async () => {
    const first = event(0, "agent-preset/selected", { agentPreset: "standard" });
    const second = event(1, "model/selection", {
      provider: "deepseek",
      model: "deepseek-v4",
      reasoningEffort: "high",
    });
    const test = setup([], [], undefined, 5_000, null, eventBytes(first));
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    test.feed.push(first);
    await Promise.resolve();
    expect(test.remote.streamCalls).toBe(0);
    test.feed.push(second);
    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "session.faulted", error: { code: "protocolError" } },
      },
    });
    expect(test.remote.streamCalls).toBe(0);
    await test.session.close();
  });

  it("rejects unsafe prompt correlation grace bounds", () => {
    expect(() => setup([], [], [], 0)).toThrow(/promptCorrelationGraceMs/u);
    expect(() => setup([], [], [], 2_147_483_648)).toThrow(/promptCorrelationGraceMs/u);
  });

  it("rejects unsafe accepted correlation timeout bounds", () => {
    expect(() => setup([], [], [], 5_000, null, undefined, 0)).toThrow(
      /acceptedCorrelationTimeoutMs/u,
    );
    expect(() => setup([], [], [], 5_000, null, undefined, 2_147_483_648)).toThrow(
      /acceptedCorrelationTimeoutMs/u,
    );
  });

  it.each([
    [new ModernJournalError("unavailable", "follow unavailable"), "unavailable", true],
    [
      new ModernJournalError("authenticationRequired", "follow authentication failed"),
      "authenticationRequired",
      false,
    ],
    [new ModernJournalError("processExited", "managed child exited"), "processExited", true],
    [new ModernJournalError("protocolError", "malformed follow"), "protocolError", false],
    [new ModernRemoteConnectionError("unavailable", "direct carrier failure"), "unavailable", true],
  ] as const)("preserves spontaneous journal fault %s as %s", async (failure, code, retryable) => {
    async function* failedLive(): AsyncGenerator<ModernJournalEvent> {
      throw failure;
    }
    const remote = new FakeRemote([]);
    const journal: ModernJournal = {
      header: { version: 0, id: SESSION_ID, createdAt: 1 },
      cursor: -1,
      projections: { asOfSeq: -1, values: {} },
      events: [],
      live: failedLive(),
      close: () => Promise.resolve(),
    };
    const session = new ModernHarnessSession({
      remote,
      journal,
      control: new FakeControl(),
      eventGateway: new ModernEventGateway(remote),
      modelCatalog: MODEL_CATALOG,
      permissionModes: null,
      sessionId: SESSION_ID,
    });
    const outputs = session.outputs[Symbol.asyncIterator]();

    expect(await nextEvent(outputs)).toMatchObject({
      type: "session.faulted",
      error: { code, retryable },
    });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
    await session.close();
  });

  it("uses exact prompt wire, preserves text parts, and projects text/reasoning/Tool/Diff/Usage", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const id = turnId("host-turn-1");
    const result = await test.session.execute({
      type: "turn.start",
      turnId: id,
      input: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(result).toEqual({ ok: true, value: { turnId: id } });
    expect(test.remote.calls[0]).toMatchObject({
      endpoint: "session/prompt",
      args: {
        request: {
          requestId: "request-1",
          sessionId: SESSION_ID,
          mode: "queue",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      },
    });

    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "firstsecond", "request-1"));
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: id });

    test.feed.push(
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "reasoning-delta", index: 0, text: "think" },
      }),
    );
    test.feed.push(
      event(4, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 1, text: "done" },
      }),
    );
    test.feed.push(
      event(5, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
      }),
    );
    test.feed.push(assistantMessage(6, "done", "think"));
    test.feed.push(
      event(7, "tool/call", {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "write",
        arguments: "{}",
      }),
    );
    test.feed.push(toolResult(8));
    test.feed.push(event(9, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(10, "turn/end", { turn: 1, reason: { kind: "completed" } }));

    const emitted = await eventsThrough(outputs, "turn.completed");
    expect(emitted.some((item) => item.type === "turn.autonomous.started")).toBe(false);
    expect(emitted.filter((item) => item.type === "session.usage.changed")).toHaveLength(1);
    expect(
      emitted
        .filter((item) => item.type === "item.completed")
        .map((item) => (item.type === "item.completed" ? item.snapshot.item.type : "")),
    ).toEqual(["reasoning", "agentMessage", "toolExecution", "fileChange"]);
    expect(emitted.at(-1)).toMatchObject({
      type: "turn.completed",
      turnId: id,
      nativeTurnRef: { nativeTurnKey: "turn:1" },
      outcome: { status: "succeeded", checkpoint: { checkpointId: "turn-end:10" } },
    });

    const snapshot = await test.session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "firstsecond" }], items: expect.any(Array) }] },
    });
    await test.session.close();
  });

  it("publishes only final reasoning across revised, delta-free, and repeated Turns", async () => {
    const test = setup(
      [() => accepted(), () => accepted(), () => accepted(), () => accepted()],
      [],
      ["request-1", "request-2", "request-3", "request-4"],
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const cases = [
      {
        chunks: [{ type: "reasoning-delta", index: 0, text: "first thought\n\n" }],
        final: "first thought",
        text: "answer one",
      },
      {
        chunks: [{ type: "reasoning-delta", index: 0, text: "use path A" }],
        final: "used path B",
        text: "answer two",
      },
      {
        chunks: [
          { type: "block-start", index: 0, blockType: "reasoning" },
          { type: "block-end", index: 0, block: { type: "reasoning", text: "final block" } },
        ],
        final: "final block",
        text: "answer three",
      },
      {
        chunks: [{ type: "block-end", index: 0, block: { type: "reasoning", text: "end only" } }],
        final: "end only",
        text: "answer four",
      },
    ];
    let seq = 0;

    for (const [index, value] of cases.entries()) {
      const nativeTurn = index + 1;
      const id = turnId(`host-turn-${nativeTurn}`);
      await expect(
        test.session.execute({
          type: "turn.start",
          turnId: id,
          input: [{ type: "text", text: `prompt ${nativeTurn}` }],
        }),
      ).resolves.toEqual({ ok: true, value: { turnId: id } });
      test.feed.push(event(seq++, "turn/start", { turn: nativeTurn }));
      test.feed.push(event(seq++, "step/start", { turn: nativeTurn, step: 1 }));
      test.feed.push(userMessage(seq++, `prompt ${nativeTurn}`, `request-${nativeTurn}`));
      expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: id });
      for (const chunk of value.chunks) {
        test.feed.push(event(seq++, "assistant/chunk", { turn: nativeTurn, step: 1, chunk }));
      }
      test.feed.push(
        event(seq++, "assistant/chunk", {
          turn: nativeTurn,
          step: 1,
          chunk: { type: "text-delta", index: 1, text: value.text },
        }),
      );
      test.feed.push(finalAssistantMessage(seq++, nativeTurn, value.text, value.final));
      test.feed.push(event(seq++, "step/end", { turn: nativeTurn, step: 1 }));
      test.feed.push(event(seq++, "turn/end", { turn: nativeTurn, reason: { kind: "completed" } }));

      const emitted = await eventsThrough(outputs, "turn.completed");
      expect(
        emitted.flatMap((item) => (item.type === "item.started" ? [item.item.type] : [])),
      ).toEqual(["agentMessage", "reasoning"]);
      expect(
        emitted.flatMap((item) =>
          item.type === "item.completed" ? [item.snapshot.item.type] : [],
        ),
      ).toEqual(["reasoning", "agentMessage"]);
      expect(
        emitted.find(
          (item) => item.type === "item.completed" && item.snapshot.item.type === "reasoning",
        ),
      ).toMatchObject({ snapshot: { item: { text: value.final } } });
      expect(emitted.at(-1)).toMatchObject({
        type: "turn.completed",
        outcome: { status: "succeeded" },
      });
    }

    const snapshot = await test.session.readSnapshot();
    expect(snapshot).toMatchObject({ ok: true });
    if (!snapshot.ok) throw new Error("expected Modern history Snapshot");
    expect(snapshot.value.turns.map((turn) => turn.items.map(({ item }) => item.type))).toEqual(
      cases.map(() => ["reasoning", "agentMessage"]),
    );
    await test.session.close();
  });

  it("omits empty final reasoning and does not carry it into later steps", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const id = turnId("host-turn-empty-reasoning");
    await test.session.execute({
      type: "turn.start",
      turnId: id,
      input: [{ type: "text", text: "prompt" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "prompt", "request-1"));
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: id });
    test.feed.push(
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "block-start", index: 0, blockType: "reasoning" },
      }),
    );
    test.feed.push(
      event(4, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "block-end", index: 0, block: { type: "reasoning", text: "" } },
      }),
    );
    test.feed.push(finalAssistantMessage(5, 1, "first answer", "", 1));
    test.feed.push(event(6, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(7, "step/start", { turn: 1, step: 2 }));
    test.feed.push(
      event(8, "assistant/chunk", {
        turn: 1,
        step: 2,
        chunk: { type: "reasoning-delta", index: 0, text: "draft" },
      }),
    );
    test.feed.push(
      event(9, "assistant/chunk", {
        turn: 1,
        step: 2,
        chunk: { type: "text-delta", index: 1, text: "second answer" },
      }),
    );
    test.feed.push(finalAssistantMessage(10, 1, "second answer", "final thought", 2));
    test.feed.push(event(11, "step/end", { turn: 1, step: 2 }));
    test.feed.push(event(12, "step/start", { turn: 1, step: 3 }));
    test.feed.push(
      event(13, "assistant/chunk", {
        turn: 1,
        step: 3,
        chunk: { type: "reasoning-delta", index: 0, text: "removed provisional thought" },
      }),
    );
    test.feed.push(
      event(14, "assistant/chunk", {
        turn: 1,
        step: 3,
        chunk: { type: "text-delta", index: 1, text: "third answer" },
      }),
    );
    test.feed.push(finalAssistantMessage(15, 1, "third answer", "", 3));
    test.feed.push(event(16, "step/end", { turn: 1, step: 3 }));
    test.feed.push(event(17, "turn/end", { turn: 1, reason: { kind: "completed" } }));

    const emitted = await eventsThrough(outputs, "turn.completed");
    const reasoningItems = emitted.flatMap((item) =>
      item.type === "item.completed" && item.snapshot.item.type === "reasoning"
        ? [item.snapshot.item]
        : [],
    );
    expect(reasoningItems).toHaveLength(1);
    expect(reasoningItems[0]).toMatchObject({
      text: "final thought",
      itemId: expect.stringContaining("step:2"),
    });
    const snapshot = await test.session.readSnapshot();
    expect(snapshot).toMatchObject({ ok: true });
    if (!snapshot.ok) throw new Error("expected multi-step Modern history Snapshot");
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "agentMessage",
      "reasoning",
      "agentMessage",
      "agentMessage",
    ]);
    await test.session.close();
  });

  it("keeps streamed assistant text prefix validation strict", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const id = turnId("host-turn-text-prefix");
    await test.session.execute({
      type: "turn.start",
      turnId: id,
      input: [{ type: "text", text: "prompt" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "prompt", "request-1"));
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: id });
    test.feed.push(
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "draft" },
      }),
    );
    test.feed.push(finalAssistantMessage(4, 1, "revised", "must not publish"));

    const emitted = await eventsThrough(outputs, "session.faulted");
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "session.faulted",
        error: expect.objectContaining({
          code: "protocolError",
          message: "Modern assistant message does not match its streamed prefix",
        }),
      }),
    );
    expect(
      emitted.some(
        (item) =>
          (item.type === "item.started" && item.item.type === "reasoning") ||
          (item.type === "item.completed" && item.snapshot.item.type === "reasoning"),
      ),
    ).toBe(false);
    await expect(test.session.close()).rejects.toThrow(
      "native execution stop was not confirmed before the Session fault",
    );
  });

  it("ignores live surface replacement copies for correlation and visible output", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const id = turnId("host-turn-surface-replacement");
    await test.session.execute({
      type: "turn.start",
      turnId: id,
      input: [{ type: "text", text: "visible prompt" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "visible prompt", "request-1"));
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: id });
    test.feed.push({
      ...userMessage(3, "model-only prompt", "request-1"),
      surfaceOp: { op: "replace", start: 2, end: 2 },
      sourceEventSeqs: [2],
    });
    test.feed.push(
      event(4, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "visible answer" },
      }),
    );
    test.feed.push(finalAssistantMessage(5, 1, "visible answer", ""));
    test.feed.push({
      ...finalAssistantMessage(6, 1, "model-only answer", "model-only thought"),
      surfaceOp: { op: "replace", start: 5, end: 5 },
      sourceEventSeqs: [5],
    });
    test.feed.push(event(7, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(8, "turn/end", { turn: 1, reason: { kind: "completed" } }));

    const emitted = await eventsThrough(outputs, "turn.completed");
    const completedMessages = emitted.flatMap((item) =>
      item.type === "item.completed" && item.snapshot.item.type === "agentMessage"
        ? [item.snapshot.item.text]
        : [],
    );
    expect(completedMessages).toEqual(["visible answer"]);
    expect(JSON.stringify(emitted)).not.toContain("model-only");
    const snapshot = await test.session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "visible prompt" }],
            items: [{ item: { type: "agentMessage", text: "visible answer" } }],
          },
        ],
      },
    });
    await test.session.close();
  });

  it("publishes final reasoning after incomplete-history resume and journal replacement", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "resumed", "old-request"),
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "reasoning-delta", index: 0, text: "obsolete draft\n\n" },
      }),
      event(4, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 1, text: "recovered answer" },
      }),
    ];
    const replacementEvents = [
      ...history,
      finalAssistantMessage(5, 1, "recovered answer", "authoritative thought"),
      event(6, "step/end", { turn: 1, step: 1 }),
      event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];
    const replacement = new EventFeed();
    replacement.push({
      type: "snapshot",
      header: { version: 0, id: SESSION_ID, createdAt: 1 },
      cursor: 7,
      records: replacementEvents.map((item) => ({ type: "event", event: item })),
      hasMore: false,
      projections: { asOfSeq: 7, values: {} },
    } as never);
    const test = setup(
      [],
      history,
      ["autonomous-recovery"],
      5_000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [replacement],
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.autonomous.started",
      turnId: "autonomous-recovery",
    });
    expect(await nextEvent(outputs)).toEqual({
      type: "turn.started",
      turnId: "autonomous-recovery",
    });

    test.feed.finish();
    const emitted = await eventsThrough(outputs, "turn.completed");
    expect(test.remote.streamCalls).toBe(1);
    expect(
      emitted.flatMap((item) => (item.type === "item.started" ? [item.item.type] : [])),
    ).toEqual(["agentMessage", "reasoning"]);
    expect(
      emitted.flatMap((item) => (item.type === "item.completed" ? [item.snapshot.item.type] : [])),
    ).toEqual(["reasoning", "agentMessage"]);
    expect(
      emitted.find(
        (item) => item.type === "item.completed" && item.snapshot.item.type === "reasoning",
      ),
    ).toMatchObject({ snapshot: { item: { text: "authoritative thought" } } });
    expect(emitted.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    const snapshot = await test.session.readSnapshot();
    expect(snapshot).toMatchObject({ ok: true });
    if (!snapshot.ok) throw new Error("expected recovered Modern history Snapshot");
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "reasoning",
      "agentMessage",
    ]);
    await test.session.close();
  });

  it("buffers turn/start and step/start through a multi-message claim until any rpcId matches", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => receipt.promise], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const order: string[] = [];
    const firstOutput = outputs.next().then((value) => {
      order.push("output");
      return value;
    });
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-1"),
      input: [{ type: "text", text: "mine" }],
    });

    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "foreign", "foreign-request"));
    test.feed.push({
      ...finalAssistantMessage(3, 1, "model-only replacement", ""),
      surfaceOp: { op: "replace", start: 2, end: 2 },
      sourceEventSeqs: [2],
    });
    test.feed.push(userMessage(4, "context-without-rpc"));
    test.feed.push(userMessage(5, "mine", "request-1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    receipt.resolve(accepted());
    expect(await execution).toMatchObject({ ok: true });
    order.push("result");
    const first = await firstOutput;
    expect(order).toEqual(["result", "output"]);
    expect(first.value).toEqual({
      kind: "event",
      event: { type: "turn.started", turnId: "host-turn-1" },
    });
    await test.session.close();
  });

  it("keeps a live Turn healthy when chunk and message Usage telemetry are malformed", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const id = turnId("host-turn-usage");
    await test.session.execute({
      type: "turn.start",
      turnId: id,
      input: [{ type: "text", text: "usage" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "usage", "request-1"));
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: id });

    test.feed.push(
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
      }),
    );
    test.feed.push(
      event(4, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "usage", usage: { inputTokens: "broken", outputTokens: 99 } },
      }),
    );
    test.feed.push(
      assistantMessage(5, "done", "think", {
        inputTokens: 10,
        outputTokens: "broken",
      }),
    );
    test.feed.push(event(6, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }));

    const emitted = await eventsThrough(outputs, "turn.completed");
    expect(emitted.some(({ type }) => type === "session.faulted")).toBe(false);
    const usageEvents = emitted.filter(({ type }) => type === "session.usage.changed");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: "session.usage.changed",
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    expect(emitted.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await expect(test.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ outcome: { status: "succeeded" } }] },
    });
    await test.session.close();
  });

  it("materializes an unmatched first user-message batch as one autonomous Turn", async () => {
    const test = setup([], [], ["autonomous-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "one", "foreign"));
    test.feed.push(userMessage(3, "two"));
    test.feed.push(
      event(4, "request/header", {
        header: { config: { provider: "deepseek", model: "deepseek-v4" } },
        reason: "initial",
      }),
    );

    expect(await nextEvent(outputs)).toEqual({
      type: "turn.autonomous.started",
      turnId: "autonomous-1",
      input: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    });
    expect(await nextEvent(outputs)).toEqual({
      type: "turn.started",
      turnId: "autonomous-1",
    });
    await test.session.close();
  });

  it.each([
    ["plugin", { kind: "plugin", plugin: "fixture" }],
    ["goal", { kind: "goal", goalId: "goal-1", revision: 1, round: 1 }],
  ])(
    "starts a live autonomous Turn at the boundary after a %s user/message",
    async (_kind, source) => {
      const test = setup([], [], ["autonomous-source"]);
      const outputs = test.session.outputs[Symbol.asyncIterator]();
      test.feed.push(event(0, "turn/start", { turn: 1 }));
      test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
      test.feed.push(sourcedUserMessage(2, "context", source));
      test.feed.push(requestHeader(3));

      expect(await nextEvent(outputs)).toEqual({
        type: "turn.autonomous.started",
        turnId: "autonomous-source",
        input: [],
      });
      expect(await nextEvent(outputs)).toEqual({
        type: "turn.started",
        turnId: "autonomous-source",
      });
      await test.session.close();
    },
  );

  it("resumes visible incomplete history as an autonomous Turn without completing it in snapshots", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "resumed", "old-request"),
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "partial" },
      }),
    ];
    const test = setup([], history, ["autonomous-resume"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.autonomous.started",
      turnId: "autonomous-resume",
    });
    expect(await nextEvent(outputs)).toEqual({
      type: "turn.started",
      turnId: "autonomous-resume",
    });
    expect(await nextEvent(outputs)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "partial" },
    });
    await expect(test.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [] },
    });
    await test.session.close();
  });

  it("observes active text without acquiring native execution or cancelling it on close", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "child task"),
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "partial" },
      }),
    ];
    const test = setup(
      [],
      history,
      ["observed-turn"],
      undefined,
      null,
      undefined,
      undefined,
      [],
      DEEPSEEK_V012_PROFILE,
      undefined,
      true,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await eventsThrough(outputs, "item.updated");
    const first = await test.session.readSnapshot();
    expect(first).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ text: "child task" }],
            outcome: { status: "unknown" },
            items: [{ item: { text: "partial" } }],
          },
        ],
      },
    });
    if (first.ok) first.value.turns[0]?.items.splice(0);
    expect(await test.session.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ items: [{ item: { text: "partial" } }] }] },
    });
    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("forbidden"),
        input: [{ type: "text", text: "no" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await expect(
      test.session.commands.execute({ turnId: turnId("command"), commandId: "dsh.compact" }),
    ).resolves.toMatchObject({ ok: false });
    await test.session.cancelNative();
    await Promise.all([test.session.close(), test.session.close()]);
    expect(test.remote.calls).toEqual([]);
    expect(test.journal.closeCalls).toBe(1);
    expect(await outputs.next()).toMatchObject({ done: true });
    expect(test.session.observationJournal().events).toEqual(history);
  });

  it("does not resume incomplete history whose only assistant surface is a replacement", async () => {
    const replacement = {
      ...finalAssistantMessage(7, 2, "model-only answer", "model-only thought"),
      surfaceOp: { op: "replace" as const, start: 2, end: 2 },
      sourceEventSeqs: [2],
    };
    const test = setup(
      [],
      [
        event(0, "turn/start", { turn: 1 }),
        event(1, "step/start", { turn: 1, step: 1 }),
        userMessage(2, "visible history"),
        event(3, "step/end", { turn: 1, step: 1 }),
        event(4, "turn/end", { turn: 1, reason: { kind: "completed" } }),
        event(5, "turn/start", { turn: 2 }),
        event(6, "step/start", { turn: 2, step: 1 }),
        replacement,
      ],
      ["must-not-materialize"],
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();

    expect(test.remote.streamCalls).toBe(0);
    await expect(test.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ type: "text", text: "visible history" }] }] },
    });
    await expect(test.session.close()).rejects.toThrow(
      "cannot confirm stop before the native Turn is correlated",
    );
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it.each([
    ["plugin", { kind: "plugin", plugin: "fixture" }],
    ["goal", { kind: "goal", goalId: "goal-1", revision: 1, round: 1 }],
  ])("resumes an incomplete %s user/message Turn as autonomous", async (_kind, source) => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      sourcedUserMessage(2, "context", source),
    ];
    const test = setup([], history, ["autonomous-resume-source"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    expect(await nextEvent(outputs)).toEqual({
      type: "turn.autonomous.started",
      turnId: "autonomous-resume-source",
      input: [],
    });
    expect(await nextEvent(outputs)).toEqual({
      type: "turn.started",
      turnId: "autonomous-resume-source",
    });
    await test.session.close();
  });

  it.each(["terminal-first", "receipt-first"])(
    "uses exact cancel wire and completes once when %s",
    async (order) => {
      const cancelReceipt = deferred<ModernRemoteResult<unknown>>();
      const test = setup([() => accepted(), () => cancelReceipt.promise], [], ["request-1"]);
      const outputs = test.session.outputs[Symbol.asyncIterator]();
      const id = turnId("host-turn-1");
      await test.session.execute({
        type: "turn.start",
        turnId: id,
        input: [{ type: "text", text: "go" }],
      });
      test.feed.push(event(0, "turn/start", { turn: 1 }));
      test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
      test.feed.push(userMessage(2, "go", "request-1"));
      expect(await nextEvent(outputs)).toMatchObject({ type: "turn.started" });

      const cancellation = test.session.execute({ type: "turn.cancel", turnId: id });
      expect(test.remote.calls[1]).toMatchObject({
        endpoint: "session/cancel",
        args: { request: { sessionId: SESSION_ID } },
      });
      if (order === "receipt-first") {
        cancelReceipt.resolve(accepted());
        await expect(cancellation).resolves.toEqual({
          ok: true,
          value: { cancellationRequested: true },
        });
      }
      test.feed.push(event(3, "step/end", { turn: 1, step: 1 }));
      test.feed.push(
        event(4, "turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }),
      );
      const terminal = await nextEvent(outputs);
      expect(terminal).toMatchObject({ type: "turn.completed", outcome: { status: "cancelled" } });
      if (order === "terminal-first") {
        cancelReceipt.resolve(accepted());
        await expect(cancellation).resolves.toMatchObject({ ok: true });
      }
      await Promise.resolve();
      await test.session.close();
      const done = await outputs.next();
      expect(done.done).toBe(true);
    },
  );

  it("accepts an uncertain prompt when its native user requestId arrives during grace", async () => {
    vi.useFakeTimers();
    const test = setup(
      [() => Promise.reject(new Error("transport failed"))],
      [],
      ["request-1"],
      50,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-1"),
      input: [{ type: "text", text: "late" }],
    });
    await waitForGraceTimer();
    expect(test.remote.calls).toHaveLength(1);

    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "late", "request-1"));
    await expect(execution).resolves.toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.started",
      turnId: "host-turn-1",
    });
    test.feed.push(event(3, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(4, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    const terminal = await nextEvent(outputs);
    expect(terminal).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-1",
      outcome: { status: "succeeded" },
    });
    await test.session.close();
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("accepts an uncertain prompt from its durable inbox admission proof", async () => {
    vi.useFakeTimers();
    const test = setup(
      [() => Promise.reject(new Error("transport failed"))],
      [],
      ["request-1"],
      50,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-inbox"),
      input: [{ type: "text", text: "queued" }],
    });
    await waitForGraceTimer();
    test.feed.push(inboxAdmission(0, "request-1"));
    await expect(execution).resolves.toMatchObject({ ok: true });
    expect(test.remote.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    test.feed.push(event(1, "turn/start", { turn: 1 }));
    test.feed.push(event(2, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(3, "queued", "request-1"));
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.started",
      turnId: "host-turn-inbox",
    });
    expect(vi.getTimerCount()).toBe(0);
    test.feed.push(event(4, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-inbox",
    });
    await test.session.close();
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("faults an accepted prompt when no correlatable durable user message arrives", async () => {
    vi.useFakeTimers();
    const test = setup(
      [() => accepted()],
      [],
      ["request-1", "autonomous-1"],
      500,
      null,
      undefined,
      50,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();

    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("host-turn-accepted-without-echo"),
        input: [{ type: "text", text: "queued" }],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(1);

    test.feed.push(inboxAdmission(0, "request-1"));
    test.feed.push(event(1, "turn/start", { turn: 1 }));
    test.feed.push(event(2, "turn/end", { turn: 1, reason: { kind: "blocked" } }));
    const autonomous = await eventsThrough(outputs, "turn.completed");
    expect(autonomous.map(({ type }) => type)).toEqual([
      "turn.autonomous.started",
      "turn.started",
      "turn.completed",
    ]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(50);
    const emitted = await eventsThrough(outputs, "session.faulted");
    expect(emitted.map(({ type }) => type)).toEqual(["turn.completed", "session.faulted"]);
    expect(emitted[0]).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-accepted-without-echo",
      outcome: { status: "failed", error: { code: "protocolError", retryable: false } },
    });
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("host-turn-after-correlation-fault"),
        input: [{ type: "text", text: "retry" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("clears an accepted prompt correlation deadline when the Session closes", async () => {
    vi.useFakeTimers();
    const test = setup([() => accepted()], [], ["request-1"], 500, null, undefined, 50);
    const outputs = test.session.outputs[Symbol.asyncIterator]();

    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("host-turn-close-correlation"),
        input: [{ type: "text", text: "close" }],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(1);

    await expect(test.session.close()).rejects.toThrow(
      "cannot confirm stop before the native Turn is correlated",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-close-correlation",
      outcome: { status: "cancelled" },
    });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("faults only after uncertain prompt correlation grace expires", async () => {
    vi.useFakeTimers();
    const secret = "UNCERTAIN_SECRET_CANARY";
    const test = setup(
      [() => Promise.reject(new Error(`api_key=${secret}`))],
      [],
      ["request-1"],
      50,
      null,
      undefined,
      500,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-timeout"),
      input: [{ type: "text", text: "once" }],
    });
    await waitForGraceTimer();
    expect(test.remote.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);

    const result = await execution;
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await nextEvent(outputs)).toMatchObject({ type: "session.faulted" });
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("host-turn-2"),
        input: [{ type: "text", text: "retry" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("settles uncertain prompt grace as closed without faulting", async () => {
    vi.useFakeTimers();
    const test = setup(
      [() => Promise.reject(new Error("transport failed"))],
      [],
      ["request-1"],
      50,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-close-grace"),
      input: [{ type: "text", text: "close" }],
    });
    await waitForGraceTimer();
    await expect(test.session.close()).rejects.toThrow(
      "cannot confirm stop before the native Turn is correlated",
    );
    await expect(execution).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(test.remote.calls.map(({ endpoint }) => endpoint)).toEqual([
      "session/prompt",
      "session/cancel",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("settles uncertain prompt grace with an existing protocol fault", async () => {
    vi.useFakeTimers();
    const test = setup(
      [() => Promise.reject(new Error("transport failed"))],
      [],
      ["request-1"],
      50,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-fault-grace"),
      input: [{ type: "text", text: "fault" }],
    });
    await waitForGraceTimer();
    test.feed.push(event(0, "plugin/required-future", { value: true }));
    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError", retryable: false },
    });
    expect(test.remote.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await nextEvent(outputs)).toMatchObject({ type: "session.faulted" });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("keeps uncertain correlation while an unrelated autonomous Turn completes", async () => {
    vi.useFakeTimers();
    const test = setup(
      [() => Promise.reject(new Error("transport failed"))],
      [],
      ["request-1", "autonomous-1"],
      500,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-after-autonomous"),
      input: [{ type: "text", text: "mine" }],
    });
    await waitForGraceTimer();

    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(sourcedUserMessage(2, "plugin context", { kind: "plugin", plugin: "fixture" }));
    test.feed.push(requestHeader(3));
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.autonomous.started",
      turnId: "autonomous-1",
      input: [],
    });
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.started" });
    test.feed.push(event(4, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    const autonomousTail = await eventsThrough(outputs, "turn.completed");
    expect(autonomousTail.at(-1)).toMatchObject({
      type: "turn.completed",
      turnId: "autonomous-1",
    });
    expect(vi.getTimerCount()).toBe(1);

    test.feed.push(event(6, "turn/start", { turn: 2 }));
    test.feed.push(event(7, "step/start", { turn: 2, step: 1 }));
    test.feed.push(userMessage(8, "mine", "request-1"));
    await expect(execution).resolves.toMatchObject({ ok: true });
    expect(test.remote.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.started",
      turnId: "host-turn-after-autonomous",
    });
    test.feed.push(event(9, "step/end", { turn: 2, step: 1 }));
    test.feed.push(event(10, "turn/end", { turn: 2, reason: { kind: "completed" } }));
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-after-autonomous",
    });
    await test.session.close();
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("protocol-faults a Remote rejection that contradicts an observed durable requestId", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => receipt.promise], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-1"),
      input: [{ type: "text", text: "mine" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "mine", "request-1"));
    receipt.resolve({
      ok: false,
      error: { code: "session/agent-busy", message: "rejected", details: {} },
    });
    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError", retryable: false },
    });
    const emitted = await eventsThrough(outputs, "session.faulted");
    expect(emitted.some((item) => item.type === "turn.autonomous.started")).toBe(false);
    expect(emitted.map(({ type }) => type)).toEqual([
      "turn.started",
      "turn.completed",
      "session.faulted",
    ]);
  });

  it("keeps a pre-receipt durable match Host-bound when a later event faults", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => receipt.promise], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-1"),
      input: [{ type: "text", text: "mine" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "mine", "request-1"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("host-turn-2"),
        input: [{ type: "text", text: "second" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });

    test.feed.push(event(3, "plan/mode", { active: "malformed" }));
    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError", retryable: false },
    });
    const emitted = await eventsThrough(outputs, "session.faulted");
    expect(emitted.some(({ type }) => type === "turn.autonomous.started")).toBe(false);
    expect(emitted.map(({ type }) => type)).toEqual([
      "turn.started",
      "turn.completed",
      "session.faulted",
    ]);
    expect(emitted[1]).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-1",
      outcome: { status: "failed" },
    });
  });

  it("settles an accepted pending Turn once when close happens before native turn/start", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-1"),
      input: [{ type: "text", text: "queued" }],
    });
    await expect(test.session.close()).rejects.toThrow(
      "cannot confirm stop before the native Turn is correlated",
    );
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-1",
      outcome: { status: "cancelled" },
    });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("keeps a pre-receipt durable match Host-bound when close races the receipt", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => receipt.promise], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-1"),
      input: [{ type: "text", text: "mine" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "mine", "request-1"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(test.session.close()).rejects.toThrow(
      "cannot confirm stop before the native Turn is correlated",
    );
    await expect(execution).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-1",
      outcome: { status: "cancelled" },
    });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("settles an accepted pending Turn once when a protocol fault happens before native turn/start", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-1"),
      input: [{ type: "text", text: "queued" }],
    });
    test.feed.push(event(0, "plugin/required-future", { value: true }));
    const emitted = await eventsThrough(outputs, "session.faulted");
    expect(emitted.map(({ type }) => type)).toEqual(["turn.completed", "session.faulted"]);
    expect(emitted[0]).toMatchObject({
      type: "turn.completed",
      turnId: "host-turn-1",
      outcome: { status: "failed" },
    });
  });

  it("rejects uncorrelated accepted closure instead of claiming native stop", async () => {
    const test = setup([() => accepted()]);
    await test.session.execute({
      type: "turn.start",
      turnId: turnId("uncorrelated-close"),
      input: [{ type: "text", text: "go" }],
    });
    await expect(test.session.close()).rejects.toThrow(
      "cannot confirm stop before the native Turn is correlated",
    );
    expect(test.remote.calls.filter(({ endpoint }) => endpoint === "session/cancel")).toHaveLength(
      1,
    );
  });

  it("ends outputs when a native cancel fault races close", async () => {
    const test = setup([() => ({ ok: true, value: { accepted: false } })]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    beginAutonomousTurn(test);
    await nextEvent(outputs);
    await expect(test.session.close()).rejects.toThrow("invalid receipt");
    const remaining: HarnessOutput[] = [];
    for (;;) {
      const next = await outputs.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining).toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({ type: "session.faulted" }),
      }),
    );
    expect(test.journal.closeCalls).toBe(1);
  });

  it("rejects stop confirmation when an active Session faults before close", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await test.session.execute({
      type: "turn.start",
      turnId: turnId("fault-first"),
      input: [{ type: "text", text: "mine" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "mine", "request-1"));
    await nextEvent(outputs);
    test.session.fault({ code: "protocolError", message: "broken journal", retryable: false });
    await eventsThrough(outputs, "session.faulted");
    await expect(test.session.close()).rejects.toThrow(
      "native execution stop was not confirmed before the Session fault",
    );
    await expect(test.session.close()).rejects.toThrow(
      "native execution stop was not confirmed before the Session fault",
    );
    expect(test.feed.seen.some(({ type }) => type === "turn/end")).toBe(false);
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not let an autonomous terminal confirm an unrelated uncertain prompt stopped", async () => {
    const test = setup(
      [() => Promise.reject(new Error("lost receipt"))],
      [],
      ["request-1", "autonomous-1"],
      50_000,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("uncertain"),
      input: [{ type: "text", text: "mine" }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(sourcedUserMessage(2, "plugin context", { kind: "plugin", plugin: "fixture" }));
    test.feed.push(requestHeader(3));
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.autonomous.started" });
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.started" });
    await expect(test.session.close()).rejects.toThrow(
      "cannot confirm stop before the native Turn is correlated",
    );
    await expect(execution).resolves.toMatchObject({ ok: false });
    expect(test.remote.calls.map(({ endpoint }) => endpoint)).toEqual([
      "session/prompt",
      "session/cancel",
    ]);
  });

  it("settles a prompt accepted during close when a subsequent fault owns cleanup", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const cancel = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => receipt.promise, () => cancel.promise], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const execution = test.session.execute({
      type: "turn.start",
      turnId: turnId("late-accepted"),
      input: [{ type: "text", text: "mine" }],
    });
    const rejected = expect(test.session.close()).rejects.toThrow();
    receipt.resolve(accepted());
    await expect(execution).resolves.toMatchObject({ ok: true });
    test.session.fault({
      code: "protocolError",
      message: "fault after late admission",
      retryable: false,
    });
    await rejected;
    const emitted = await eventsThrough(outputs, "session.faulted");
    expect(emitted.map(({ type }) => type)).toEqual(["turn.completed", "session.faulted"]);
    expect(emitted[0]).toMatchObject({ turnId: "late-accepted", outcome: { status: "failed" } });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("waits for native stop after a cancel receipt and shares close confirmation", async () => {
    const test = setup([() => accepted()]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    beginAutonomousTurn(test);
    await nextEvent(outputs);
    let closed = false;
    const first = test.session.close().then(() => {
      closed = true;
    });
    const second = test.session.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("after-close"),
        input: [{ type: "text", text: "blocked" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(test.remote.calls.filter(({ endpoint }) => endpoint === "session/cancel")).toHaveLength(
      1,
    );
    finishNativeTurn(test);
    await Promise.all([first, second]);
    expect(closed).toBe(true);
  });

  it("rejects close when a cancel receipt never becomes a native terminal", async () => {
    vi.useFakeTimers();
    const test = setup([() => accepted()]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    beginAutonomousTurn(test);
    await nextEvent(outputs);
    const result = expect(test.session.close()).rejects.toThrow("did not confirm native Turn stop");
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    await expect(test.session.close()).rejects.toThrow("did not confirm native Turn stop");
  });

  it("closes an active Turn exactly once and ignores late terminal history", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await test.session.execute({
      type: "turn.start",
      turnId: turnId("host-turn-1"),
      input: [{ type: "text", text: "go" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "go", "request-1"));
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.started" });
    await test.session.close();
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    test.feed.push(event(3, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(4, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("confirms a same-value Model selection without a Native mutation", async () => {
    const test = setup([]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();

    await expect(
      test.session.execute({
        type: "model.select",
        model: MODEL_CATALOG.catalog.models[0]?.ref as never,
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(test.remote.calls).toEqual([]);
    expect(await nextEvent(outputs)).toEqual({
      type: "session.state.changed",
      state: test.session.initialState,
    });
    await test.session.close();
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it.each([
    ["Thinking", { type: "thinking.select", thinkingOptionId: "high" }, null],
    ["Permission", { type: "permissionMode.select", permissionModeId: "ask" }, PERMISSION_CATALOG],
  ] as const)(
    "confirms same-value %s once without a Native mutation",
    async (_label, command, modes) => {
      const test = setup([], [], ["autonomous-1"], 5_000, modes);
      const outputs = test.session.outputs[Symbol.asyncIterator]();

      await expect(test.session.execute(command as never)).resolves.toEqual({
        ok: true,
        value: { completed: true },
      });
      expect(test.remote.calls).toEqual([]);
      expect(await nextEvent(outputs)).toEqual({
        type: "session.state.changed",
        state: test.session.initialState,
      });
      await test.session.close();
      await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
    },
  );

  it("selects Thinking through session/selectModel and publishes only confirmed control state", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => receipt.promise]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const selected = {
      provider: "deepseek",
      model: "deepseek-v4",
      reasoningEffort: "off",
    };

    const selecting = test.session.execute({
      type: "thinking.select",
      thinkingOptionId: "off" as never,
    });
    await vi.waitFor(() => expect(test.remote.calls).toHaveLength(1));
    test.control.update(
      "modelSelection",
      { lastUsed: null, next: selected } as ModernControlJsonValue,
      1,
    );
    receipt.resolve({ ok: true, value: { selected } });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(test.remote.calls[0]).toMatchObject({
      endpoint: "session/selectModel",
      args: {
        request: {
          sessionId: SESSION_ID,
          provider: "deepseek",
          model: "deepseek-v4",
          reasoningEffort: "off",
        },
      },
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveThinkingOptionId: "off" },
    });
    await test.session.close();
  });

  it("selects Permission through the exact command and confirms its projection", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => receipt.promise], [], ["autonomous-1"], 5_000, PERMISSION_CATALOG);
    const outputs = test.session.outputs[Symbol.asyncIterator]();

    const selecting = test.session.execute({
      type: "permissionMode.select",
      permissionModeId: "danger-full-access" as never,
    });
    await vi.waitFor(() => expect(test.remote.calls).toHaveLength(1));
    expect(test.remote.calls[0]).toMatchObject({
      endpoint: "commands/execute",
      args: {
        agentId: SESSION_ID,
        line: "/permission danger-full-access",
        images: [],
      },
      options: { timeoutMs: null },
    });
    expect(test.remote.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    test.control.update("permissions", permissionValue("danger-full-access"), 1);
    receipt.resolve({
      ok: true,
      value: {
        commandId: "permission-1",
        result: { kind: "success", text: "full access" },
      },
    });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "danger-full-access" },
    });
    await test.session.close();
  });

  it("does not let late journal configuration roll back newer control state", async () => {
    const test = setup([]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    test.control.update(
      "modelSelection",
      {
        lastUsed: null,
        next: { provider: "deepseek", model: "deepseek-v4", reasoningEffort: "off" },
      } as ModernControlJsonValue,
      2,
    );
    expect(await nextEvent(outputs)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveThinkingOptionId: "off" },
    });

    test.feed.push(
      event(0, "model/selection", {
        provider: "deepseek",
        model: "deepseek-v4",
        reasoningEffort: "high",
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(test.session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectiveThinkingOptionId: "off" } },
    });
    await test.session.close();
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("keeps public command discovery readable during an active Turn", async () => {
    const test = setup([() => accepted()], [], ["request-1"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await test.session.execute({
      type: "turn.start",
      turnId: turnId("active-turn"),
      input: [{ type: "text", text: "go" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "go", "request-1"));
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.started" });

    await expect(test.session.commands.list()).resolves.toMatchObject({
      ok: true,
      value: { commands: [{ id: "dsh.compact" }, { id: "dsh.goal" }, { id: "dsh.plan" }] },
    });
    expect(test.remote.calls.map(({ endpoint }) => endpoint)).not.toContain("commands/list");
    await test.session.close();
  });

  it("runs a Host command Turn and activates a buffered autonomous Turn afterwards", async () => {
    const execution = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => execution.promise]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const commandTurnId = turnId("command-turn");

    await expect(
      test.session.commands.execute({
        turnId: commandTurnId,
        commandId: "dsh.goal",
        arguments: { text: "ship" },
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: commandTurnId } });
    expect(test.remote.calls[0]).toMatchObject({
      endpoint: "commands/execute",
      args: { agentId: SESSION_ID, line: "/goal ship", images: [] },
      options: { timeoutMs: null },
    });
    expect(test.remote.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: commandTurnId });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "item.started",
      turnId: commandTurnId,
      item: { type: "commandExecution", command: "/goal ship" },
    });

    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(
      sourcedUserMessage(2, "goal context", { kind: "goal", goalId: "g", revision: 1, round: 1 }),
    );
    test.feed.push(requestHeader(3));
    test.feed.push(event(4, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));

    execution.resolve({
      ok: true,
      value: { commandId: "native-command", result: { kind: "success", text: "goal set" } },
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "item.completed",
      turnId: commandTurnId,
      snapshot: { outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: commandTurnId,
      outcome: { status: "succeeded" },
    });
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.autonomous.started" });
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await test.session.close();
  });

  it("blocks prompts, configuration, and a second command while a command is active", async () => {
    const execution = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => execution.promise]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const activeTurnId = turnId("active-command");
    await expect(
      test.session.commands.execute({ turnId: activeTurnId, commandId: "dsh.compact" }),
    ).resolves.toEqual({ ok: true, value: { turnId: activeTurnId } });
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: activeTurnId });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "item.started",
      turnId: activeTurnId,
      item: { type: "contextCompaction" },
    });

    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("blocked-prompt"),
        input: [{ type: "text", text: "blocked" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    await expect(
      test.session.execute({ type: "thinking.select", thinkingOptionId: "off" as never }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    await expect(
      test.session.commands.execute({
        turnId: turnId("blocked-command"),
        commandId: "dsh.compact",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(test.remote.calls).toHaveLength(1);

    execution.resolve({
      ok: true,
      value: { commandId: "native-command", result: { kind: "success" } },
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: activeTurnId,
      outcome: { status: "succeeded" },
    });
    await test.session.close();
  });

  it("rejects command admission when configuration changes before acceptance", async () => {
    const test = setup([]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const executing = test.session.commands.execute({
      turnId: turnId("command-race"),
      commandId: "dsh.compact",
    });
    test.control.update(
      "modelSelection",
      {
        lastUsed: null,
        next: { provider: "deepseek", model: "deepseek-v4", reasoningEffort: "off" },
      } as ModernControlJsonValue,
      1,
    );
    await expect(executing).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(test.remote.calls).toHaveLength(0);
    expect(await nextEvent(outputs)).toMatchObject({ type: "session.state.changed" });
    await test.session.close();
  });

  it("rejects commands while an autonomous Turn is active without native discovery", async () => {
    const test = setup([], [], ["autonomous-after-admission"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();

    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(
      sourcedUserMessage(2, "goal context", {
        kind: "goal",
        goalId: "goal-1",
        revision: 1,
        round: 1,
      }),
    );
    test.feed.push(requestHeader(3));
    expect(await nextEvent(outputs)).toEqual({
      type: "turn.autonomous.started",
      turnId: "autonomous-after-admission",
      input: [],
    });
    expect(await nextEvent(outputs)).toEqual({
      type: "turn.started",
      turnId: "autonomous-after-admission",
    });
    await expect(
      test.session.commands.execute({
        turnId: turnId("command-autonomous-race"),
        commandId: "dsh.compact",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(test.remote.calls).toHaveLength(0);
    test.feed.push(event(4, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: "autonomous-after-admission",
      outcome: { status: "succeeded" },
    });
    await test.session.close();
  });

  it("cancels an active command with exactly one Item and Turn terminal", async () => {
    const execution = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => execution.promise]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const commandTurnId = turnId("cancelled-command");
    await test.session.commands.execute({
      turnId: commandTurnId,
      commandId: "dsh.compact",
    });
    await nextEvent(outputs);
    await nextEvent(outputs);

    await expect(
      test.session.execute({ type: "turn.cancel", turnId: commandTurnId }),
    ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
    expect(test.remote.calls[0]?.signal?.aborted).toBe(true);
    execution.reject(new ModernRemoteConnectionError("cancelled", "cancelled"));
    const emitted = await eventsThrough(outputs, "turn.completed");
    expect(emitted.map(({ type }) => type)).toEqual(["item.completed", "turn.completed"]);
    expect(emitted[0]).toMatchObject({
      type: "item.completed",
      turnId: commandTurnId,
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(emitted[1]).toMatchObject({
      type: "turn.completed",
      turnId: commandTurnId,
      outcome: { status: "cancelled" },
    });
    await expect(
      test.session.execute({ type: "turn.cancel", turnId: commandTurnId }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await test.session.close();
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("closes an active command once without activating its buffered autonomous Turn", async () => {
    const execution = deferred<ModernRemoteResult<unknown>>();
    const test = setup([() => execution.promise]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const commandTurnId = turnId("closed-command");
    await test.session.commands.execute({
      turnId: commandTurnId,
      commandId: "dsh.compact",
    });
    await nextEvent(outputs);
    await nextEvent(outputs);

    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(
      sourcedUserMessage(2, "goal context", {
        kind: "goal",
        goalId: "goal-1",
        revision: 1,
        round: 1,
      }),
    );
    test.feed.push(requestHeader(3));
    test.feed.push(event(4, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(test.session.close()).rejects.toThrow(
      "cannot confirm stop before the native Turn is correlated",
    );
    expect(test.remote.calls[0]?.signal?.aborted).toBe(true);
    expect(await nextEvent(outputs)).toMatchObject({
      type: "item.completed",
      turnId: commandTurnId,
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: commandTurnId,
      outcome: { status: "cancelled" },
    });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
    execution.resolve({
      ok: true,
      value: { commandId: "late-command", result: { kind: "success" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("faults an accepted command exactly once after an uncertain execute failure", async () => {
    const test = setup([
      () => Promise.reject(new ModernRemoteConnectionError("unavailable", "lost response")),
    ]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await test.session.commands.execute({
      turnId: turnId("uncertain-command"),
      commandId: "dsh.compact",
    });

    const emitted = await eventsThrough(outputs, "session.faulted");
    expect(emitted.filter(({ type }) => type === "item.completed")).toHaveLength(1);
    expect(emitted.filter(({ type }) => type === "turn.completed")).toHaveLength(1);
    expect(emitted.at(-1)).toMatchObject({
      type: "session.faulted",
      error: { code: "unavailable" },
    });
    expect(test.remote.calls.map(({ endpoint }) => endpoint)).toEqual(["commands/execute"]);
    expect(test.remote.calls[0]).toMatchObject({ options: { timeoutMs: null } });
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(test.session.close()).rejects.toThrow(
      "native execution stop was not confirmed before the Session fault",
    );
  });

  it("publishes an early Host-bound Approval and delivers allow/deny exactly", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const allow = vi.fn<ModernApprovalDelivery["respond"]>(async () => undefined);
    const deny = vi.fn<ModernApprovalDelivery["respond"]>(async () => undefined);
    const test = setup(
      [() => receipt.promise],
      [],
      ["request-early", "approval-allow", "approval-deny"],
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const hostTurnId = turnId("host-bound-interaction");
    const starting = test.session.execute({
      type: "turn.start",
      turnId: hostTurnId,
      input: [{ type: "text", text: "go" }],
    });
    test.session.onDelivery(approvalDelivery("event-allow", allow));
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "go", "request-early"));
    test.feed.push(requestHeader(3));
    receipt.resolve(accepted());

    await expect(starting).resolves.toEqual({ ok: true, value: { turnId: hostTurnId } });
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: hostTurnId });
    expect(await nextInteraction(outputs)).toEqual({
      type: "approval",
      interactionId: "approval-allow",
      turnId: hostTurnId,
      title: "Allow write?",
      description: "write (call-1)",
      subject: { type: "nativeAction" },
      actions: [
        { id: "allow-once", label: "Allow once", effect: "allowOnce" },
        { id: "reject", label: "Reject", effect: "deny" },
      ],
    });
    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "approval-allow" as never,
        response: { type: "approval", actionId: "allow-once" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(allow).toHaveBeenCalledExactlyOnceWith("allowed-once");
    expect(await nextEvent(outputs)).toEqual({
      type: "interaction.closed",
      interactionId: "approval-allow",
      turnId: hostTurnId,
      reason: "responded",
    });

    test.session.onDelivery(approvalDelivery("event-deny", deny));
    expect(await nextInteraction(outputs)).toMatchObject({
      type: "approval",
      interactionId: "approval-deny",
      turnId: hostTurnId,
    });
    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "approval-deny" as never,
        response: { type: "approval", actionId: "reject" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(deny).toHaveBeenCalledExactlyOnceWith("rejected");
    expect(await nextEvent(outputs)).toMatchObject({
      type: "interaction.closed",
      interactionId: "approval-deny",
      reason: "responded",
    });

    finishNativeTurn(test);
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: hostTurnId,
      outcome: { status: "succeeded" },
    });
    await test.session.close();
  });

  it("publishes an early autonomous Question and round-trips every answer shape", async () => {
    const respond = vi.fn<ModernQuestionDelivery["respond"]>(async () => undefined);
    const reject = vi.fn<ModernQuestionDelivery["reject"]>(async () => undefined);
    const test = setup([], [], ["autonomous-question", "question-answer", "question-cancel"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const turn = turnId("autonomous-question");
    test.session.onDelivery(
      questionDelivery(
        "event-question",
        {
          questions: [
            {
              id: "choice",
              question: "Choose scope",
              detail: "Used for this run",
              header: "Scope",
              options: [
                { label: "Workspace", description: "Current checkout" },
                { label: "Repository" },
              ],
            },
            { id: "text", question: "Notes", detail: "Markdown accepted" },
            {
              id: "multi",
              question: "Targets",
              options: [{ label: "Tests" }, { label: "Docs" }],
              multiSelect: true,
            },
            {
              id: "custom",
              question: "Destination",
              options: [{ label: "Known" }],
            },
            {
              id: "plan",
              question: "Apply plan?",
              options: [{ label: "Apply" }, { label: "Revise" }],
              intent: { kind: "plan-review", approve: "Apply" },
            },
          ],
        },
        respond,
        reject,
      ),
    );
    beginAutonomousTurn(test);

    expect(await nextEvent(outputs)).toEqual({
      type: "turn.autonomous.started",
      turnId: turn,
      input: [],
    });
    expect(await nextEvent(outputs)).toEqual({ type: "turn.started", turnId: turn });
    expect(await nextInteraction(outputs)).toEqual({
      type: "question",
      interactionId: "question-answer",
      turnId: turn,
      title: "Scope",
      questions: [
        {
          id: "choice",
          type: "choice",
          prompt: "Choose scope\n\nUsed for this run",
          options: [
            { value: "Workspace", label: "Workspace", description: "Current checkout" },
            { value: "Repository", label: "Repository" },
          ],
          multiple: false,
          allowOther: true,
          optional: false,
        },
        {
          id: "text",
          type: "text",
          prompt: "Notes\n\nMarkdown accepted",
          multiline: true,
          secret: false,
          optional: false,
        },
        {
          id: "multi",
          type: "choice",
          prompt: "Targets",
          options: [
            { value: "Tests", label: "Tests" },
            { value: "Docs", label: "Docs" },
          ],
          multiple: true,
          allowOther: true,
          optional: false,
        },
        {
          id: "custom",
          type: "choice",
          prompt: "Destination",
          options: [{ value: "Known", label: "Known" }],
          multiple: false,
          allowOther: true,
          optional: false,
        },
        {
          id: "plan",
          type: "choice",
          prompt: "Apply plan?",
          options: [
            { value: "Apply", label: "Apply" },
            { value: "Revise", label: "Revise" },
          ],
          multiple: false,
          allowOther: false,
          optional: false,
        },
      ],
    });
    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "question-answer" as never,
        response: {
          type: "question",
          answers: {
            choice: ["Workspace"],
            text: ["Keep comments"],
            multi: ["Tests", "Docs"],
            custom: ["Elsewhere"],
            plan: ["Apply"],
          },
        },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      answers: [
        { id: "choice", selected: ["Workspace"] },
        { id: "text", selected: [], custom: "Keep comments" },
        { id: "multi", selected: ["Tests", "Docs"] },
        { id: "custom", selected: [], custom: "Elsewhere" },
        { id: "plan", selected: ["Apply"] },
      ],
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "interaction.closed",
      interactionId: "question-answer",
      reason: "responded",
    });

    test.session.onDelivery(
      questionDelivery(
        "event-cancel",
        { questions: [{ id: "cancel", question: "Continue?" }] },
        respond,
        reject,
      ),
    );
    expect(await nextInteraction(outputs)).toMatchObject({
      type: "question",
      interactionId: "question-cancel",
    });
    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "question-cancel" as never,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(reject).toHaveBeenCalledTimes(1);
    expect(await nextEvent(outputs)).toMatchObject({
      type: "interaction.closed",
      interactionId: "question-cancel",
      reason: "cancelled",
    });

    finishNativeTurn(test);
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: turn,
      outcome: { status: "succeeded" },
    });
    await test.session.close();
  });

  it("rejects malformed Interaction responses without settling either delivery", async () => {
    const approvalRespond = vi.fn<ModernApprovalDelivery["respond"]>(async () => undefined);
    const questionRespond = vi.fn<ModernQuestionDelivery["respond"]>(async () => undefined);
    const questionReject = vi.fn<ModernQuestionDelivery["reject"]>(async () => undefined);
    const test = setup([], [], ["invalid-response-turn", "invalid-approval", "invalid-question"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    beginAutonomousTurn(test);
    await nextEvent(outputs);
    await nextEvent(outputs);
    test.session.onDelivery(approvalDelivery("invalid-approval-event", approvalRespond));
    test.session.onDelivery(
      questionDelivery(
        "invalid-question-event",
        {
          questions: [
            {
              id: "target",
              question: "Where?",
              options: [{ label: "Workspace" }],
              multiSelect: true,
            },
          ],
        },
        questionRespond,
        questionReject,
      ),
    );
    await nextInteraction(outputs);
    await nextInteraction(outputs);

    const invalidCommands = [
      {
        type: "interaction.respond",
        interactionId: "invalid-approval",
        response: { type: "question", answers: {} },
      },
      {
        type: "interaction.respond",
        interactionId: "invalid-approval",
        response: { type: "approval", actionId: "unknown" },
      },
      {
        type: "interaction.respond",
        interactionId: "invalid-question",
        response: {
          type: "question",
          answers: { target: ["Workspace"], unknown: ["value"] },
        },
      },
      {
        type: "interaction.respond",
        interactionId: "invalid-question",
        response: { type: "question", answers: {} },
      },
      {
        type: "interaction.respond",
        interactionId: "invalid-question",
        response: { type: "question", answers: { target: ["custom-one", "custom-two"] } },
      },
    ] as const;
    for (const command of invalidCommands) {
      await expect(test.session.execute(command as never)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalidRequest", retryable: false },
      });
    }
    expect(approvalRespond).not.toHaveBeenCalled();
    expect(questionRespond).not.toHaveBeenCalled();
    expect(questionReject).not.toHaveBeenCalled();

    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "invalid-approval" as never,
        response: { type: "approval", actionId: "reject" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "invalid-question" as never,
        response: { type: "question", answers: { target: ["custom-one"] } },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(approvalRespond).toHaveBeenCalledExactlyOnceWith("rejected");
    expect(questionRespond).toHaveBeenCalledExactlyOnceWith({
      answers: [{ id: "target", selected: [], custom: "custom-one" }],
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "interaction.closed",
      interactionId: "invalid-approval",
    });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "interaction.closed",
      interactionId: "invalid-question",
    });
    finishNativeTurn(test);
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.completed" });
    await test.session.close();
  });

  it("serializes duplicate responses and settles an onCancel/response race once", async () => {
    const firstSettlement = deferred<undefined>();
    const racedSettlement = deferred<undefined>();
    const firstRespond = vi.fn<ModernApprovalDelivery["respond"]>(() => firstSettlement.promise);
    const racedRespond = vi.fn<ModernApprovalDelivery["respond"]>(() => racedSettlement.promise);
    const test = setup([], [], ["response-race-turn", "concurrent-response", "cancel-race"]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    beginAutonomousTurn(test);
    await nextEvent(outputs);
    await nextEvent(outputs);

    test.session.onDelivery(approvalDelivery("concurrent-event", firstRespond));
    await nextInteraction(outputs);
    const first = test.session.execute({
      type: "interaction.respond",
      interactionId: "concurrent-response" as never,
      response: { type: "approval", actionId: "allow-once" },
    });
    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "concurrent-response" as never,
        response: { type: "approval", actionId: "reject" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(firstRespond).toHaveBeenCalledExactlyOnceWith("allowed-once");
    firstSettlement.resolve(undefined);
    await expect(first).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(await nextEvent(outputs)).toMatchObject({
      type: "interaction.closed",
      interactionId: "concurrent-response",
      reason: "responded",
    });
    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "concurrent-response" as never,
        response: { type: "approval", actionId: "allow-once" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    test.session.onCancel("concurrent-event");

    test.session.onDelivery(approvalDelivery("raced-event", racedRespond));
    await nextInteraction(outputs);
    const raced = test.session.execute({
      type: "interaction.respond",
      interactionId: "cancel-race" as never,
      response: { type: "approval", actionId: "reject" },
    });
    test.session.onCancel("raced-event");
    expect(await nextEvent(outputs)).toMatchObject({
      type: "interaction.closed",
      interactionId: "cancel-race",
      reason: "cancelled",
    });
    racedSettlement.resolve(undefined);
    await expect(raced).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(racedRespond).toHaveBeenCalledExactlyOnceWith("rejected");

    finishNativeTurn(test);
    expect(await nextEvent(outputs)).toMatchObject({
      type: "turn.completed",
      turnId: "response-race-turn",
    });
    await test.session.close();
  });

  it("treats a queued delivery as busy and closes without activating or cancelling Native", async () => {
    const respond = vi.fn<ModernApprovalDelivery["respond"]>(async () => undefined);
    const test = setup([]);
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    test.session.onDelivery(approvalDelivery("queued-event", respond));

    await expect(
      test.session.execute({
        type: "turn.start",
        turnId: turnId("blocked-turn"),
        input: [{ type: "text", text: "go" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    await expect(
      test.session.execute({
        type: "model.select",
        model: MODEL_CATALOG.catalog.models[0]?.ref as never,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    await expect(
      test.session.commands.execute({
        turnId: turnId("blocked-command"),
        commandId: "dsh.compact",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(test.remote.calls).toEqual([]);

    await test.session.close();
    expect(respond).not.toHaveBeenCalled();
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it.each(["native completion", "Session fault", "Session close"] as const)(
    "closes a pending Interaction once before %s terminal output",
    async (terminal) => {
      const respond = vi.fn<ModernApprovalDelivery["respond"]>(async () => undefined);
      const test = setup([], [], ["terminal-order-turn", "terminal-interaction"]);
      const outputs = test.session.outputs[Symbol.asyncIterator]();
      beginAutonomousTurn(test);
      await nextEvent(outputs);
      await nextEvent(outputs);
      test.session.onDelivery(approvalDelivery("terminal-event", respond));
      await nextInteraction(outputs);

      let emitted: HostEvent[];
      if (terminal === "native completion") {
        finishNativeTurn(test);
        emitted = await eventsThrough(outputs, "turn.completed");
      } else if (terminal === "Session fault") {
        test.session.fault({
          code: "unavailable",
          message: "event transport was lost",
          retryable: true,
        });
        emitted = await eventsThrough(outputs, "session.faulted");
      } else {
        await test.session.close();
        emitted = await eventsThrough(outputs, "turn.completed");
      }

      expect(emitted.map(({ type }) => type)).toEqual(
        terminal === "Session fault"
          ? ["interaction.closed", "turn.completed", "session.faulted"]
          : ["interaction.closed", "turn.completed"],
      );
      expect(emitted.filter(({ type }) => type === "interaction.closed")).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "interaction.closed",
        interactionId: "terminal-interaction",
        turnId: "terminal-order-turn",
        reason: "cancelled",
      });
      if (terminal === "Session fault") {
        await expect(test.session.close()).rejects.toThrow(
          "native execution stop was not confirmed before the Session fault",
        );
      } else {
        await test.session.close();
      }
      await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
    },
  );

  it("rejects an invalid Model and an unknown Interaction ID", async () => {
    const test = setup([]);
    await expect(
      test.session.execute({
        type: "model.select",
        model: { id: "deepseek-harness-model-v2.invalid" as never },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest", retryable: false } });
    await expect(
      test.session.execute({
        type: "interaction.respond",
        interactionId: "interaction-1" as never,
        response: { type: "approval", actionId: "allow" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await test.session.close();
  });

  it("bounds v015 attempt buffering even while its live feed is being consumed", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "bounded"),
    ];
    const test = setup(
      [],
      history,
      ["bounded-v015"],
      5000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [],
      DEEPSEEK_V015_PROFILE,
      200,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    test.feed.push({
      type: "assistant-stream",
      frame: { type: "start", attemptId: "a", revision: 1, startedAfterSeq: 2, turn: 1, step: 1 },
    });
    for (let index = 0; index < 2; index += 1) {
      test.feed.push({
        type: "assistant-stream",
        frame: {
          type: "chunk",
          attemptId: "a",
          revision: index + 2,
          index,
          time: 1,
          chunk: { type: "text-delta", index: 0, text: "hello" },
        },
      });
    }
    const emitted = await eventsThrough(outputs, "session.faulted");
    expect(emitted.at(-1)).toMatchObject({
      type: "session.faulted",
      error: { diagnostic: "limitExceeded" },
    });
    await expect(test.session.close()).rejects.toThrow("native execution stop was not confirmed");
  });

  it("streams v0.1.5 attempts and cancels failed retry text before the successful message", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "retry this"),
    ];
    const test = setup(
      [],
      history,
      ["autonomous-v015"],
      5_000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [],
      DEEPSEEK_V015_PROFILE,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await Promise.resolve();

    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "unknown-attempt",
        revision: 5,
        index: 0,
        time: 1_001,
        chunk: { type: "text-delta", index: 0, text: "unknown ghost" },
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId: "unknown-attempt",
        revision: 6,
        index: 1,
        outcome: { kind: "abandoned" },
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "retired-agent-attempt",
        revision: 7,
        startedAfterSeq: 2,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "retired-agent-attempt",
        revision: 8,
        index: 0,
        time: 1_002,
        chunk: { type: "text-delta", index: 0, text: "retired ghost" },
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "attempt-failed",
        revision: 1,
        startedAfterSeq: 2,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "attempt-failed",
        revision: 2,
        index: 0,
        time: 1_003,
        chunk: { type: "text-delta", index: 0, text: "ghost" },
      },
    });
    test.feed.push(
      event(3, "assistant/attempt", {
        turn: 1,
        step: 1,
        stream: [{ type: "text-chunks", time0: 1_003, index: 0, dt: [], texts: ["ghost"] }],
      }),
    );
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId: "attempt-failed",
        revision: 3,
        index: 1,
        outcome: { kind: "committed", eventType: "assistant/attempt", seq: 3 },
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "attempt-visible",
        revision: 4,
        startedAfterSeq: 3,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "attempt-visible",
        revision: 5,
        index: 0,
        time: 1_004,
        chunk: { type: "text-delta", index: 0, text: "done" },
      },
    });
    const emitted: HostEvent[] = [];
    while (
      !emitted.some(
        (entry) =>
          entry.type === "item.updated" &&
          entry.update.type === "text.append" &&
          entry.update.text === "done",
      )
    ) {
      emitted.push(await nextEvent(outputs));
    }
    expect(test.feed.seen.some((entry) => entry.type === "assistant/message")).toBe(false);
    test.feed.push(
      event(
        4,
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "assistant-4",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          },
          stream: [{ type: "text-chunks", time0: 1_004, index: 0, dt: [], texts: ["done"] }],
          usage: { inputTokens: 2, outputTokens: 1 },
        },
        true,
      ),
    );
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId: "attempt-visible",
        revision: 6,
        index: 1,
        outcome: { kind: "committed", eventType: "assistant/message", seq: 4 },
      },
    });
    test.feed.push(event(5, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(6, "turn/end", { turn: 1, reason: { kind: "completed" } }));

    while (!emitted.some(({ type }) => type === "turn.completed")) {
      emitted.push(await nextEvent(outputs));
    }
    expect(JSON.stringify(emitted)).not.toContain("unknown ghost");
    expect(emitted.filter(({ type }) => type === "item.started")).toHaveLength(3);
    const ui = new CodexTurnProjector({
      threadId: "stream-retry-thread",
      turnId: turnId("autonomous-v015"),
      cwd: "/fixture",
      startedAtMs: 1_000,
    });
    const wire = emitted.flatMap((entry) => {
      switch (entry.type) {
        case "turn.started":
        case "item.started":
        case "item.updated":
        case "item.completed":
        case "turn.completed":
          return ui.project(entry).messages;
        default:
          return [];
      }
    });
    expect(
      wire
        .filter(({ method }) => method === "item/completed")
        .map(({ params }) =>
          params && typeof params === "object" && !Array.isArray(params) ? params.item : undefined,
        ),
    ).toMatchObject([
      {
        type: "agentMessage",
        text: "retired ghost\n\n[生成尝试已取消 / Generation attempt cancelled]",
      },
      { type: "agentMessage", text: "ghost\n\n[生成尝试已取消 / Generation attempt cancelled]" },
      { type: "agentMessage", text: "done" },
    ]);
    expect(emitted.filter(({ type }) => type === "item.completed")).toEqual([
      expect.objectContaining({
        snapshot: {
          item: expect.objectContaining({
            text: "retired ghost\n\n[生成尝试已取消 / Generation attempt cancelled]",
          }),
          outcome: { status: "cancelled" },
        },
      }),
      expect.objectContaining({
        snapshot: {
          item: expect.objectContaining({
            text: "ghost\n\n[生成尝试已取消 / Generation attempt cancelled]",
          }),
          outcome: { status: "cancelled" },
        },
      }),
      expect.objectContaining({
        snapshot: {
          item: expect.objectContaining({ text: "done" }),
          outcome: { status: "succeeded" },
        },
      }),
    ]);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "item.updated",
        update: { type: "text.append", text: "done" },
      }),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        outcome: expect.objectContaining({
          checkpoint: expect.objectContaining({ checkpointId: "v3-turn-end:6" }),
        }),
      }),
    );
    const snapshot = await test.session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns[0]?.items.map(({ item }) => item)).toEqual([
        expect.objectContaining({ type: "agentMessage", text: "done" }),
      ]);
    }
    await test.session.close();
  });

  it("publishes buffered v0.1.5 chunks as soon as the correlated Host Turn is admitted", async () => {
    const receipt = deferred<ModernRemoteResult<unknown>>();
    const test = setup(
      [() => receipt.promise],
      [],
      ["stream-request"],
      5_000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [],
      DEEPSEEK_V015_PROFILE,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    const started = test.session.execute({
      type: "turn.start",
      turnId: turnId("bound-stream"),
      input: [{ type: "text", text: "stream" }],
    });
    test.feed.push(event(0, "turn/start", { turn: 1 }));
    test.feed.push(event(1, "step/start", { turn: 1, step: 1 }));
    test.feed.push(userMessage(2, "stream", "stream-request"));
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "pending-stream",
        revision: 1,
        startedAfterSeq: 2,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "pending-stream",
        revision: 2,
        index: 0,
        time: 1_003,
        chunk: { type: "text-delta", index: 0, text: "before settlement" },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    receipt.resolve(accepted());
    await expect(started).resolves.toMatchObject({ ok: true });
    const emitted = await eventsThrough(outputs, "item.updated");
    expect(emitted).toEqual([
      { type: "turn.started", turnId: "bound-stream" },
      expect.objectContaining({ type: "item.started", turnId: "bound-stream" }),
      expect.objectContaining({
        type: "item.updated",
        turnId: "bound-stream",
        update: { type: "text.append", text: "before settlement" },
      }),
    ]);
    expect(test.feed.seen.some((entry) => entry.type === "assistant/message")).toBe(false);
    await test.session.close();
  });

  it("cancels a partial attempt when the replacement journal has no active assistant baseline", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "no baseline"),
    ];
    const replacement = new EventFeed();
    replacement.push({
      type: "snapshot",
      header: { version: 3, id: SESSION_ID, createdAt: 1, isSeeded: false },
      cursor: 2,
      records: history.map((entry) => ({ type: "event", event: entry })),
      hasMore: false,
      projections: { asOfSeq: 2, values: {} },
      assistantStream: { revision: 0 },
    } as never);
    const test = setup(
      [],
      history,
      ["lost-attempt"],
      5_000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [replacement],
      DEEPSEEK_V015_PROFILE,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "lost",
        revision: 1,
        startedAfterSeq: 2,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "lost",
        revision: 2,
        index: 0,
        time: 1_003,
        chunk: { type: "text-delta", index: 0, text: "partial" },
      },
    });
    const emitted = await eventsThrough(outputs, "item.updated");
    test.feed.finish();
    await vi.waitFor(() => expect(test.remote.streamCalls).toBe(1));
    replacement.push({ type: "event", event: event(3, "step/end", { turn: 1, step: 1 }) } as never);
    replacement.push({
      type: "event",
      event: event(4, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    } as never);
    emitted.push(...(await eventsThrough(outputs, "turn.completed")));
    expect(emitted.filter(({ type }) => type === "item.completed")).toEqual([
      expect.objectContaining({
        snapshot: {
          item: expect.objectContaining({
            text: "partial\n\n[生成尝试已取消 / Generation attempt cancelled]",
          }),
          outcome: { status: "cancelled" },
        },
      }),
    ]);
    expect(emitted.some(({ type }) => type === "session.faulted")).toBe(false);
    await test.session.close();
  });

  it.each([false, true])(
    "deduplicates a reconnected v0.1.5 attempt when settlement is in the replacement snapshot: %s",
    async (settled) => {
      const history = [
        event(0, "turn/start", { turn: 1 }),
        event(1, "step/start", { turn: 1, step: 1 }),
        userMessage(2, "reconnect"),
      ];
      const message = event(
        3,
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "reconnected-message",
            role: "assistant",
            content: [{ type: "text", text: "partial!" }],
            source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          },
          stream: [
            { type: "text-chunks", time0: 1_003, index: 0, dt: [1], texts: ["par", "tial"] },
          ],
        },
        true,
      );
      const replacement = new EventFeed();
      replacement.push({
        type: "snapshot",
        header: { version: 3, id: SESSION_ID, createdAt: 1, isSeeded: false },
        cursor: settled ? 3 : 2,
        records: [...history, ...(settled ? [message] : [])].map((entry) => ({
          type: "event",
          event: entry,
        })),
        hasMore: false,
        projections: { asOfSeq: settled ? 3 : 2, values: {} },
        assistantStream: {
          revision: 3,
          activeAttempt: {
            attemptId: "reconnected",
            startedAfterSeq: 2,
            turn: 1,
            step: 1,
            nextIndex: 2,
            stream: [
              { type: "text-chunks", time0: 1_003, index: 0, dt: [1], texts: ["par", "tial"] },
            ],
          },
        },
      } as never);
      const test = setup(
        [],
        history,
        ["reconnect-turn"],
        5_000,
        null,
        undefined,
        MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
        [replacement],
        DEEPSEEK_V015_PROFILE,
      );
      const outputs = test.session.outputs[Symbol.asyncIterator]();
      test.feed.push({
        type: "assistant-stream",
        frame: {
          type: "start",
          attemptId: "reconnected",
          revision: 1,
          startedAfterSeq: 2,
          turn: 1,
          step: 1,
        },
      });
      test.feed.push({
        type: "assistant-stream",
        frame: {
          type: "chunk",
          attemptId: "reconnected",
          revision: 2,
          index: 0,
          time: 1_003,
          chunk: { type: "text-delta", index: 0, text: "par" },
        },
      });
      const emitted = await eventsThrough(outputs, "item.updated");
      expect(emitted.at(-1)).toMatchObject({ update: { text: "par" } });
      test.feed.finish();
      await vi.waitFor(() => expect(test.remote.streamCalls).toBe(1));
      if (!settled) {
        emitted.push(...(await eventsThrough(outputs, "item.updated")));
        expect(emitted.at(-1)).toMatchObject({ update: { text: "tial" } });
        replacement.push({ type: "event", event: message } as never);
      }
      replacement.push({
        type: "assistant-stream",
        frame: {
          type: "end",
          attemptId: "reconnected",
          revision: 4,
          index: 2,
          outcome: { kind: "committed", eventType: "assistant/message", seq: 3 },
        },
      });
      replacement.push({
        type: "event",
        event: event(4, "step/end", { turn: 1, step: 1 }),
      } as never);
      replacement.push({
        type: "event",
        event: event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }),
      } as never);
      emitted.push(...(await eventsThrough(outputs, "turn.completed")));
      expect(emitted.filter(({ type }) => type === "item.started")).toHaveLength(1);
      expect(emitted.filter(({ type }) => type === "item.completed")).toEqual([
        expect.objectContaining({
          snapshot: {
            item: expect.objectContaining({ text: "partial!" }),
            outcome: { status: "succeeded" },
          },
        }),
      ]);
      expect(
        emitted
          .flatMap((entry) =>
            entry.type === "item.updated" && entry.update.type === "text.append"
              ? [entry.update.text]
              : [],
          )
          .join(""),
      ).toBe("partial!");
      expect(emitted.some(({ type }) => type === "session.faulted")).toBe(false);
      await test.session.close();
    },
  );

  it.each([1, 2])(
    "recovers across %s failed attempts and a successful same-step retry when stream end frames were lost",
    async (failures) => {
      const history = [
        event(0, "turn/start", { turn: 1 }),
        event(1, "step/start", { turn: 1, step: 1 }),
        userMessage(2, "retry while offline"),
      ];
      const settled = Array.from({ length: failures }, (_, index) =>
        event(3 + index, "assistant/attempt", { turn: 1, step: 1, stream: [] }),
      );
      const messageSeq = 3 + failures;
      settled.push(
        event(
          messageSeq,
          "assistant/message",
          {
            turn: 1,
            step: 1,
            message: {
              id: "retry-message",
              role: "assistant",
              content: [{ type: "text", text: "retry succeeded" }],
              source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
            },
            stream: [],
          },
          true,
        ),
      );
      settled.push(event(messageSeq + 1, "step/end", { turn: 1, step: 1 }));
      settled.push(event(messageSeq + 2, "turn/end", { turn: 1, reason: { kind: "completed" } }));
      const replacement = new EventFeed();
      replacement.push({
        type: "snapshot",
        header: { version: 3, id: SESSION_ID, createdAt: 1, isSeeded: false },
        cursor: messageSeq + 2,
        records: [...history, ...settled].map((entry) => ({ type: "event", event: entry })),
        hasMore: false,
        projections: { asOfSeq: messageSeq + 2, values: {} },
        assistantStream: { revision: 0 },
      } as never);
      const test = setup(
        [],
        history,
        ["offline-retry"],
        5_000,
        null,
        undefined,
        MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
        [replacement],
        DEEPSEEK_V015_PROFILE,
      );
      const outputs = test.session.outputs[Symbol.asyncIterator]();
      test.feed.push({
        type: "assistant-stream",
        frame: {
          type: "start",
          attemptId: "old-failed-attempt",
          revision: 1,
          startedAfterSeq: 2,
          turn: 1,
          step: 1,
        },
      });
      test.feed.push({
        type: "assistant-stream",
        frame: {
          type: "chunk",
          attemptId: "old-failed-attempt",
          revision: 2,
          index: 0,
          time: 1_003,
          chunk: { type: "text-delta", index: 0, text: "failed partial" },
        },
      });
      const emitted = await eventsThrough(outputs, "item.updated");
      test.feed.finish();
      emitted.push(...(await eventsThrough(outputs, "turn.completed")));
      expect(emitted.at(-1)).toMatchObject({
        type: "turn.completed",
        outcome: { status: "succeeded" },
      });
      expect(emitted.some(({ type }) => type === "session.faulted")).toBe(false);
      expect(
        emitted.flatMap((entry) => (entry.type === "item.completed" ? [entry.snapshot] : [])),
      ).toEqual([
        {
          item: expect.objectContaining({
            text: "failed partial\n\n[生成尝试已取消 / Generation attempt cancelled]",
          }),
          outcome: { status: "cancelled" },
        },
        {
          item: expect.objectContaining({ text: "retry succeeded" }),
          outcome: { status: "succeeded" },
        },
      ]);
      const snapshot = await test.session.readSnapshot();
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok)
        expect(snapshot.value.turns[0]?.items).toEqual([
          {
            item: expect.objectContaining({ text: "retry succeeded" }),
            outcome: { status: "succeeded" },
          },
        ]);
      await test.session.close();
    },
  );

  it("cancels an abandoned v0.1.5 attempt and preserves a revised final message without prefix pollution", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "retry"),
    ];
    const test = setup(
      [],
      history,
      ["abandoned-turn"],
      5_000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [],
      DEEPSEEK_V015_PROFILE,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "abandoned",
        revision: 1,
        startedAfterSeq: 2,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "abandoned",
        revision: 2,
        index: 0,
        time: 1_003,
        chunk: { type: "text-delta", index: 0, text: "discarded" },
      },
    });
    const emitted = await eventsThrough(outputs, "item.updated");
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId: "abandoned",
        revision: 3,
        index: 1,
        outcome: { kind: "abandoned" },
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "revised",
        revision: 4,
        startedAfterSeq: 2,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "revised",
        revision: 5,
        index: 0,
        time: 1_004,
        chunk: { type: "text-delta", index: 0, text: "provisional" },
      },
    });
    while (
      !emitted.some(
        (entry) =>
          entry.type === "item.updated" &&
          entry.update.type === "text.append" &&
          entry.update.text === "provisional",
      )
    ) {
      emitted.push(await nextEvent(outputs));
    }
    test.feed.push(
      event(
        3,
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "revised-message",
            role: "assistant",
            content: [{ type: "text", text: "authoritative" }],
            source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          },
          stream: [{ type: "text-chunks", time0: 1_004, index: 0, dt: [], texts: ["provisional"] }],
        },
        true,
      ),
    );
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId: "revised",
        revision: 6,
        index: 1,
        outcome: { kind: "committed", eventType: "assistant/message", seq: 3 },
      },
    });
    test.feed.push(event(4, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    emitted.push(...(await eventsThrough(outputs, "turn.completed")));
    const completed = emitted.flatMap((entry) =>
      entry.type === "item.completed" ? [entry.snapshot] : [],
    );
    expect(completed).toEqual([
      {
        item: expect.objectContaining({
          text: "discarded\n\n[生成尝试已取消 / Generation attempt cancelled]",
        }),
        outcome: { status: "cancelled" },
      },
      {
        item: expect.objectContaining({
          text: "provisional\n\n[生成尝试已取消 / Generation attempt cancelled]",
        }),
        outcome: { status: "cancelled" },
      },
      {
        item: expect.objectContaining({ text: "authoritative" }),
        outcome: { status: "succeeded" },
      },
    ]);
    expect(new Set(completed.map(({ item }) => item.itemId)).size).toBe(3);
    expect(
      emitted.filter(
        (entry) =>
          entry.type === "item.updated" &&
          entry.update.type === "text.append" &&
          entry.update.text === "\n\n[生成尝试已取消 / Generation attempt cancelled]",
      ),
    ).toHaveLength(2);
    expect(emitted.some(({ type }) => type === "session.faulted")).toBe(false);
    await test.session.close();
  });

  it("reopens v0.1.5 journal state after a known attempt index gap", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "recover stream"),
    ];
    const replacement = new EventFeed();
    replacement.push({
      type: "snapshot",
      header: { version: 3, id: SESSION_ID, createdAt: 1, isSeeded: false },
      cursor: 2,
      records: history.map((entry) => ({ type: "event", event: entry })),
      hasMore: false,
      projections: { asOfSeq: 2, values: {} },
      assistantStream: { revision: 0 },
    } as never);
    const test = setup(
      [],
      history,
      ["desync-recovery"],
      5_000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [replacement],
      DEEPSEEK_V015_PROFILE,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.autonomous.started" });
    expect(await nextEvent(outputs)).toMatchObject({ type: "turn.started" });

    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "gapped-attempt",
        revision: 1,
        startedAfterSeq: 2,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "gapped-attempt",
        revision: 2,
        index: 1,
        time: 1_003,
        chunk: { type: "text-delta", index: 0, text: "missed zero" },
      },
    });
    await vi.waitFor(() => expect(test.remote.streamCalls).toBe(1));

    replacement.push({
      type: "event",
      event: event(
        3,
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "assistant-3",
            role: "assistant",
            content: [{ type: "text", text: "recovered" }],
            source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          },
          stream: [],
          usage: { inputTokens: 2, outputTokens: 1 },
        },
        true,
      ),
    } as never);
    replacement.push({
      type: "event",
      event: event(4, "step/end", { turn: 1, step: 1 }),
    } as never);
    replacement.push({
      type: "event",
      event: event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    } as never);

    const emitted = await eventsThrough(outputs, "turn.completed");
    expect(JSON.stringify(emitted)).not.toContain("missed zero");
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "item.updated",
        update: { type: "text.append", text: "recovered" },
      }),
    );
    await test.session.close();
  });

  it("accepts an end frame when its v0.1.5 settlement was already in the opening snapshot", async () => {
    const history = [
      event(0, "turn/start", { turn: 1 }),
      event(1, "step/start", { turn: 1, step: 1 }),
      userMessage(2, "resume this"),
      event(
        3,
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "assistant-3",
            role: "assistant",
            content: [{ type: "text", text: "settled" }],
            source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
          },
          stream: [{ type: "text-chunks", time0: 1_003, index: 0, dt: [], texts: ["settled"] }],
          usage: { inputTokens: 2, outputTokens: 1 },
        },
        true,
      ),
    ];
    const test = setup(
      [],
      history,
      ["opening-settlement"],
      5_000,
      null,
      undefined,
      MODERN_ACCEPTED_CORRELATION_TIMEOUT_MS,
      [],
      DEEPSEEK_V015_PROFILE,
    );
    const outputs = test.session.outputs[Symbol.asyncIterator]();
    await Promise.resolve();
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "opening-attempt",
        revision: 4,
        startedAfterSeq: 2,
        turn: 1,
        step: 1,
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "opening-attempt",
        revision: 4,
        index: 0,
        time: 1_003,
        chunk: { type: "text-delta", index: 0, text: "settled" },
      },
    });
    test.feed.push({
      type: "assistant-stream",
      frame: {
        type: "end",
        attemptId: "opening-attempt",
        revision: 5,
        index: 1,
        outcome: { kind: "committed", eventType: "assistant/message", seq: 3 },
      },
    });
    test.feed.push(event(4, "step/end", { turn: 1, step: 1 }));
    test.feed.push(event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));

    const emitted: HostEvent[] = [];
    while (!emitted.some(({ type }) => type === "turn.completed")) {
      emitted.push(await nextEvent(outputs));
    }
    expect(emitted).not.toContainEqual(expect.objectContaining({ type: "session.faulted" }));
    expect(
      emitted.filter(
        (output) =>
          output.type === "item.updated" &&
          output.update.type === "text.append" &&
          output.update.text === "settled",
      ),
    ).toHaveLength(1);
    await test.session.close();
  });
});
