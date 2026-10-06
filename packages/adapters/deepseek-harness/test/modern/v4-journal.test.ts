import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decodeDeepSeekHarnessModelRef } from "../../src/model-catalog.js";

import {
  matchesModernForkHistory,
  ModernHistoryError,
  projectModernHistory,
  resolveModernForkBoundary,
} from "../../src/modern/history.js";
import {
  ModernJournalDesyncError,
  openModernJournal,
  type ModernJournalEvent,
  type ModernJournalRemote,
} from "../../src/modern/journal.js";
import { DEEPSEEK_V4_PROFILE } from "../../src/profiles/profile.js";
import {
  expandAssistantStream,
  parseAssistantBaseline,
  parseAssistantFrame,
} from "../../src/profiles/v4.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

const SESSION_ID = "session-v4";
const CWD = String.raw`E:\Coding\Project\fixture`;

class FollowFeed implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #items: IteratorResult<unknown>[] = [];
  #pending: ((value: IteratorResult<unknown>) => void) | undefined;
  #done = false;

  push(value: unknown): void {
    const item = { done: false as const, value };
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) pending(item);
    else this.#items.push(item);
  }

  next(): Promise<IteratorResult<unknown>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve(item);
    if (this.#done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.#pending = resolve;
    });
  }

  return(): Promise<IteratorResult<unknown>> {
    this.#done = true;
    this.#pending?.({ done: true, value: undefined });
    this.#pending = undefined;
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }
}

class FakeRemote implements ModernJournalRemote {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
  }> = [];

  constructor(readonly feed: FollowFeed) {}

  call<T>(): Promise<ModernRemoteResult<T>> {
    return Promise.reject(new Error("unexpected page call"));
  }

  openStream<T>(endpoint: string, args: Readonly<Record<string, unknown>>): AsyncIterable<T> {
    this.calls.push({ endpoint, args });
    return this.feed as AsyncIterable<T>;
  }
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

function record(value: ModernJournalEvent): Record<string, unknown> {
  return { type: "event", event: value };
}

function snapshot(
  events: readonly ModernJournalEvent[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const cursor = events.length - 1;
  return {
    type: "snapshot",
    header: {
      version: 4,
      id: SESSION_ID,
      createdAt: 1,
      cwd: CWD,
      isSeeded: false,
      delegationDepth: 0,
    },
    cursor,
    records: events.map(record),
    hasMore: false,
    projections: { asOfSeq: cursor, values: {} },
    assistantStream: { revision: 0 },
    ...overrides,
  };
}

function v4History(): ModernJournalEvent[] {
  return [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    event(
      2,
      "user/message",
      {
        id: "user-1",
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            attachment: { attachmentId: "sha256-file", name: "notes.txt", bytes: 5 },
          },
        ],
        source: { kind: "user", rpcId: "request-1" },
      },
      true,
    ),
    event(3, "assistant/attempt", {
      turn: 1,
      step: 1,
      stream: [
        {
          type: "chunk",
          time: 1_003,
          chunk: { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
        },
      ],
    }),
    event(
      4,
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
        },
        stream: [{ type: "text-chunks", time0: 1_004, index: 0, dt: [], texts: ["done"] }],
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      true,
    ),
    event(5, "session-log-deepseek/delivery-accepted", {
      sessionId: SESSION_ID,
      throughSeq: 4,
      sessionFormatVersion: 4,
    }),
    event(6, "step/end", { turn: 1, step: 1 }),
    event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
}

describe("DSH V4 journal wire", () => {
  it("closes follow when a reconnect baseline exceeds the live buffer bound", async () => {
    const feed = new FollowFeed();
    const close = vi.spyOn(feed, "return");
    feed.push(
      snapshot([], {
        assistantStream: {
          revision: 2,
          activeAttempt: {
            attemptId: "a",
            startedAfterSeq: -1,
            turn: 1,
            step: 1,
            nextIndex: 1,
            stream: [{ type: "text-chunks", time0: 1, index: 0, dt: [], texts: ["a"] }],
          },
        },
      }),
    );
    await expect(
      openModernJournal(
        new FakeRemote(feed),
        { sessionId: SESSION_ID, cwd: CWD },
        { maxBufferedLiveEvents: 1 },
      ),
    ).rejects.toMatchObject({ code: "limitExceeded" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves native raw empty tool fragments while rejecting invalid compact runs", () => {
    const chunk = { type: "tool-call-delta", index: 0, id: "", name: "", argumentsDelta: "{" };
    expect(expandAssistantStream([{ type: "chunk", time: 1, chunk }])).toEqual([
      { time: 1, chunk },
    ]);
    expect(
      parseAssistantFrame({
        type: "chunk",
        attemptId: "a",
        revision: 2,
        index: 0,
        time: 1,
        chunk,
      }),
    ).toMatchObject({ chunk });
    expect(() =>
      expandAssistantStream([
        { type: "tool-call-chunks", time0: 1, index: 0, id: "", name: "", dt: [], args: ["{"] },
      ]),
    ).toThrow();
  });

  it("reads native message feedback as log-only metadata", () => {
    const feedback = [
      event(0, "feedback/message-put", {
        sessionId: SESSION_ID,
        item: {
          messageId: "m",
          rating: "positive",
          version: "v1",
          createdAt: 1,
          updatedAt: 2,
          note: "useful",
        },
      }),
      event(1, "feedback/message-delete", { sessionId: SESSION_ID, messageId: "m" }),
    ];
    expect(
      projectModernHistory({ sessionId: SESSION_ID, events: feedback }).snapshot.turns,
    ).toEqual([]);
    for (const invalid of [
      { ...(feedback[0] as ModernJournalEvent), surfaceOp: "append" as const },
      event(0, "feedback/message-put", {
        sessionId: SESSION_ID,
        item: { messageId: "m", rating: "maybe", version: "v1", createdAt: 1, updatedAt: 2 },
      }),
      event(0, "feedback/message-delete", { sessionId: SESSION_ID }),
    ]) {
      expect(() => projectModernHistory({ sessionId: SESSION_ID, events: [invalid] })).toThrow();
    }
  });

  it("accepts native fractional Hook durations", () => {
    const hook = {
      turn: 1,
      point: "PostToolUse",
      handlerId: "hook",
      decision: "pass",
      durationMs: 9.40504199999998,
    };
    expect(() =>
      projectModernHistory({ sessionId: SESSION_ID, events: [event(0, "hook/result", hook)] }),
    ).not.toThrow();
    for (const durationMs of [-1, Infinity, NaN, "9.4"]) {
      expect(() =>
        projectModernHistory({
          sessionId: SESSION_ID,
          events: [event(0, "hook/result", { ...hook, durationMs })],
        }),
      ).toThrow();
    }
  });

  it("expands compact Assistant streams without changing delta boundaries", () => {
    expect(
      expandAssistantStream([
        { type: "text-chunks", time0: 10, index: 0, dt: [2], texts: ["a", "b"] },
        {
          type: "tool-call-chunks",
          time0: 20,
          index: 1,
          dt: [1],
          id: "call-1",
          name: "write",
          args: ["{", "}"],
        },
      ]),
    ).toEqual([
      { time: 10, chunk: { type: "text-delta", index: 0, text: "a" } },
      { time: 12, chunk: { type: "text-delta", index: 0, text: "b" } },
      {
        time: 20,
        chunk: {
          type: "tool-call-delta",
          index: 1,
          id: "call-1",
          name: "write",
          argumentsDelta: "{",
        },
      },
      {
        time: 21,
        chunk: {
          type: "tool-call-delta",
          index: 1,
          id: "call-1",
          name: "write",
          argumentsDelta: "}",
        },
      },
    ]);
  });

  it.each([
    [[{ type: "text-chunks", time0: 1, index: 0, dt: [], texts: [] }]],
    [[{ type: "text-chunks", time0: 1, index: 0, dt: [1], texts: ["x"] }]],
    [[{ type: "chunk", time: 1, chunk: { type: "future" } }]],
    [[{ type: "chunk", time: 1, chunk: { type: "usage", usage: { value: Number.NaN } } }]],
    [[{ type: "chunk", time: 1, chunk: { type: "usage", usage: { value: undefined } } }]],
  ])("rejects malformed compact stream %j", (stream) => {
    expect(() => expandAssistantStream(stream)).toThrow(/DSH V4/u);
  });

  it("requires a positive baseline revision for an active attempt", () => {
    expect(
      parseAssistantBaseline({
        revision: 1,
        activeAttempt: {
          attemptId: "attempt-1",
          startedAfterSeq: -1,
          turn: 1,
          step: 1,
          nextIndex: 0,
          stream: [],
        },
      }),
    ).toMatchObject({ revision: 1, activeAttempt: { nextIndex: 0, stream: [] } });
    expect(() =>
      parseAssistantBaseline({
        revision: 0,
        activeAttempt: {
          attemptId: "attempt-1",
          startedAfterSeq: 1,
          turn: 1,
          step: 1,
          nextIndex: 0,
          stream: [],
        },
      }),
    ).toThrow(/revision/u);
  });

  it("validates dense live frame fields", () => {
    expect(
      parseAssistantFrame({
        type: "chunk",
        attemptId: "attempt-1",
        revision: 2,
        index: 0,
        time: 10,
        chunk: { type: "text-delta", index: 0, text: "a" },
      }),
    ).toMatchObject({ type: "chunk", revision: 2, index: 0 });
    expect(() =>
      parseAssistantFrame({
        type: "chunk",
        attemptId: "attempt-1",
        revision: 2,
        index: 0,
        time: 10,
        chunk: { type: "future" },
      }),
    ).toThrow(/chunk/u);
  });

  it("opens with assistant streaming and keeps transient frames outside the durable cursor", async () => {
    const feed = new FollowFeed();
    feed.push(snapshot([event(0, "fixture/event", { ok: true })]));
    const remote = new FakeRemote(feed);
    const journal = await openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD });
    const live = journal.live[Symbol.asyncIterator]();
    feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "attempt-1",
        revision: 1,
        startedAfterSeq: 0,
        turn: 1,
        step: 1,
      },
    });
    feed.push({ type: "event", event: event(1, "fixture/event", { ok: true }) });

    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { type: "start", revision: 1 } },
    });
    await expect(live.next()).resolves.toMatchObject({ value: { seq: 1 } });
    expect(journal.cursor).toBe(0);
    expect(remote.calls[0]?.args).toEqual({
      request: {
        address: { kind: "session", sessionId: SESSION_ID },
        maxMessages: 200,
        assistantStream: true,
      },
    });
    await journal.close();
  });

  it("restores an active baseline before later revisions", async () => {
    const feed = new FollowFeed();
    feed.push(
      snapshot([], {
        assistantStream: {
          revision: 3,
          activeAttempt: {
            attemptId: "attempt-1",
            startedAfterSeq: -1,
            turn: 1,
            step: 1,
            nextIndex: 1,
            stream: [{ type: "text-chunks", time0: 10, index: 0, dt: [], texts: ["a"] }],
          },
        },
      }),
    );
    const journal = await openModernJournal(new FakeRemote(feed), {
      sessionId: SESSION_ID,
      cwd: CWD,
    });
    const live = journal.live[Symbol.asyncIterator]();
    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { type: "start", attemptId: "attempt-1" } },
    });
    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { type: "chunk", index: 0 } },
    });
    feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "attempt-1",
        revision: 4,
        index: 1,
        time: 11,
        chunk: { type: "text-delta", index: 0, text: "b" },
      },
    });
    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { revision: 4, index: 1 } },
    });
    await journal.close();
  });

  it("accepts revision one when a replacement Agent starts a new lifecycle", async () => {
    const feed = new FollowFeed();
    feed.push(snapshot([], { assistantStream: { revision: 3 } }));
    const journal = await openModernJournal(new FakeRemote(feed), {
      sessionId: SESSION_ID,
      cwd: CWD,
    });
    const live = journal.live[Symbol.asyncIterator]();
    feed.push({
      type: "assistant-stream",
      frame: {
        type: "start",
        attemptId: "replacement:1",
        revision: 1,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
      },
    });

    await expect(live.next()).resolves.toMatchObject({
      value: { type: "assistant-stream", frame: { type: "start", revision: 1 } },
    });
    await journal.close();
  });

  it("marks an Assistant revision gap for baseline recovery", async () => {
    const feed = new FollowFeed();
    feed.push(snapshot([], { assistantStream: { revision: 3 } }));
    const journal = await openModernJournal(new FakeRemote(feed), {
      sessionId: SESSION_ID,
      cwd: CWD,
    });
    const live = journal.live[Symbol.asyncIterator]();
    feed.push({
      type: "assistant-stream",
      frame: {
        type: "chunk",
        attemptId: "missed-start",
        revision: 5,
        index: 0,
        time: 10,
        chunk: { type: "text-delta", index: 0, text: "gap" },
      },
    });

    await expect(live.next()).rejects.toBeInstanceOf(ModernJournalDesyncError);
    await journal.close();
  });

  it.each([
    { version: 0, id: SESSION_ID, createdAt: 1, cwd: CWD },
    { version: 3, id: SESSION_ID, createdAt: 1, cwd: CWD, isSeeded: false },
  ])("rejects a pre-V4 journal header %j", async (header) => {
    const feed = new FollowFeed();
    feed.push(snapshot([], { header }));
    await expect(
      openModernJournal(new FakeRemote(feed), { sessionId: SESSION_ID, cwd: CWD }),
    ).rejects.toMatchObject({ code: "protocolError" });
  });

  it("projects retry Usage once per settlement and emits V4 references", () => {
    const projection = projectModernHistory({ sessionId: SESSION_ID, events: v4History() });

    expect(projection.snapshot.turns).toHaveLength(1);
    expect(projection.snapshot.turns[0]).toMatchObject({
      checkpoint: {
        checkpointId: "v4-turn-end:7",
        locator: { dshVersion: "0.1.7-rc.1" },
      },
      items: [{ item: { type: "agentMessage", text: "done" } }],
    });
    expect(projection.nativeRef).toMatchObject({
      formatVersion: 1,
      locator: { dshVersion: "0.1.7-rc.1" },
    });
    expect(projection.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
  });

  it("accepts an empty migrated message stream but rejects V0 chunk events and provenance", () => {
    const history = v4History();
    const message = history[4] as ModernJournalEvent;
    const data = message.data as Record<string, unknown>;
    const migrated = projectModernHistory({
      sessionId: SESSION_ID,
      events: [
        ...history.slice(0, 4),
        { ...message, data: { ...data, stream: [] } as never },
        ...history.slice(5),
      ],
    });
    expect(migrated.snapshot.turns[0]?.items).toMatchObject([
      { item: { type: "agentMessage", text: "done" } },
    ]);
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [
          ...history.slice(0, 3),
          event(3, "assistant/chunk", {
            turn: 1,
            step: 1,
            chunk: { type: "text-delta", index: 0, text: "x" },
          }),
        ],
      }),
    ).toThrow(ModernHistoryError);
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [...history.slice(0, 4), { ...message, sourceEventSeqs: [1] }],
      }),
    ).toThrow(ModernHistoryError);
  });

  it("uses the tagged V4 fork marker and rejects V0/V3 checkpoint namespaces", () => {
    const source = v4History();
    const boundary = resolveModernForkBoundary(source, "v4-turn-end:7");
    expect(boundary?.atSeq).toBe(7);
    expect(resolveModernForkBoundary(source, "turn-end:7")).toBeNull();
    expect(resolveModernForkBoundary(source, "v3-turn-end:7")).toBeNull();
    const child = [
      ...source,
      event(8, "session/end-seed", { inherited: true }),
      event(9, "agent-preset/selected", { agentPreset: "coding" }),
    ];
    expect(matchesModernForkHistory(source, child)).toBe(true);
    expect(matchesModernForkHistory(source, [...source, event(8, "session/end-seed", {})])).toBe(
      false,
    );
  });
});

describe("DSH V4 durable protocol", () => {
  const project = (events: readonly ModernJournalEvent[]) =>
    projectModernHistory({ sessionId: SESSION_ID, events });
  const system = (seq: number, text = "system instructions"): ModernJournalEvent =>
    event(
      seq,
      "system/message",
      {
        turn: 1,
        step: 1,
        message: {
          id: `system-${seq}`,
          role: "system",
          content: [{ type: "text", text }],
          source: { kind: "system-prompt" },
        },
      },
      true,
    );
  const prefix = () => [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    system(2),
  ];

  it("replays the tool-call Turn that DSH 0.2.0-rc.2 recorded live", () => {
    const rows = readFileSync(
      new URL("../fixtures/dsh-020rc2-tool-call-turn.v4.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const first = rows.shift();
    assert(first);
    const { type: recordType, ...header } = first;
    expect(recordType).toBe("session");
    expect(
      DEEPSEEK_V4_PROFILE.parseHeader(header, {
        sessionId: header.id as string,
        cwd: header.cwd as string,
      }),
    ).toMatchObject({ version: 4, delegationDepth: 0 });
    // DSH snapshots elide event seq/time and substitute the environment's tool catalog.
    const events = rows.map((row, seq) => {
      const data = row.data as Record<string, unknown>;
      if (row.type === "request/header") {
        const header = data.header as Record<string, unknown>;
        data.header = {
          ...header,
          tools: [
            {
              name: "bash",
              description: "fixture",
              parameters: { type: "object", properties: {} },
            },
          ],
        };
      }
      return { ...row, seq, time: 1_000 + seq } as unknown as ModernJournalEvent;
    });
    const projected = projectModernHistory({ sessionId: header.id as string, events });
    expect(projected.snapshot.turns).toHaveLength(1);
    const [turn] = projected.snapshot.turns;
    // The runtime-context message is native model input, not something the user typed.
    expect(turn?.input).toEqual([
      {
        type: "text",
        text: "Use the bash tool to run exactly: echo SNAPSHOT_OK. Then reply with the single word DONE and stop.",
      },
    ]);
    expect(turn?.items.map(({ item, outcome }) => [item.type, outcome?.status])).toEqual([
      ["reasoning", "succeeded"],
      ["toolExecution", "succeeded"],
      ["reasoning", "succeeded"],
      ["agentMessage", "succeeded"],
    ]);
    expect(turn?.items[1]?.item).toMatchObject({
      toolName: "bash",
      arguments: { command: "echo SNAPSHOT_OK" },
      output: { content: [{ type: "text", text: "SNAPSHOT_OK\n" }] },
    });
    expect(turn?.items[3]?.item).toMatchObject({ text: "DONE" });
    expect(turn?.checkpoint?.checkpointId).toBe(`v4-turn-end:${events.length - 1}`);
    assert(projected.effectiveModel);
    expect(decodeDeepSeekHarnessModelRef(projected.effectiveModel)).toMatchObject({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
  });

  it("folds system head replacements using event seqs without displaying system messages", () => {
    const history = [
      ...prefix(),
      {
        ...system(3, ""),
        sourceEventSeqs: [2],
        surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
      } as ModernJournalEvent,
      event(4, "request/context", {
        provider: "deepseek",
        model: "deepseek-v4",
        systemPromptUpdate: "in-history",
      }),
      event(5, "step/end", { turn: 1, step: 1 }),
      event(6, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];
    expect(project(history).snapshot.turns[0]).toMatchObject({ input: [], items: [] });
    for (const surfaceOp of [
      { op: "replace", start: 2, end: 2 },
      { op: "replace", startSeq: 1, endSeq: 2 },
      { op: "replace", startSeq: 2, endSeq: 3 },
      { op: "replace", startSeq: -0, endSeq: 2 },
    ])
      expect(() =>
        project([
          ...prefix(),
          { ...system(3), sourceEventSeqs: [2], surfaceOp } as ModernJournalEvent,
        ]),
      ).toThrow();
    expect(() =>
      project([
        ...prefix(),
        { ...system(3), sourceEventSeqs: [], surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 } },
      ]),
    ).toThrow();
    const user = event(
      3,
      "user/message",
      {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "cannot replace system" }],
        source: { kind: "user" },
      },
      true,
    );
    expect(() =>
      project([
        ...prefix(),
        { ...user, sourceEventSeqs: [2], surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 } },
      ]),
    ).toThrow(/system head/);
  });

  it("rejects retired system header data and invalid system message identity", () => {
    for (const message of [
      null,
      { id: "x", role: "user", content: [], source: { kind: "user" } },
      { id: "x", role: "system", content: [], source: { kind: "plugin" } },
    ]) {
      expect(() =>
        project([
          event(0, "turn/start", { turn: 1 }),
          event(1, "step/start", { turn: 1, step: 1 }),
          event(2, "system/message", { turn: 1, step: 1, message }, true),
        ]),
      ).toThrow();
    }
    expect(() =>
      project([
        ...prefix(),
        event(3, "request/header", {
          header: { config: { provider: "p", model: "m" }, system: "retired" },
          reason: "initial",
        }),
      ]),
    ).toThrow(/system/);
    expect(() =>
      project([
        ...prefix(),
        event(3, "request/context", { provider: "p", model: "m", systemPromptUpdate: "future" }),
      ]),
    ).toThrow();
  });

  const metadata: Array<[string, Record<string, unknown>]> = [
    [
      "deliverables/presented",
      { turn: 1, callId: "root", files: [{ path: "result.txt", description: "result" }] },
    ],
    ["subagent/catalog", { version: 0, childId: "child", childCreatedAt: 1, mode: "one-shot" }],
    [
      "subagent/catalog",
      { version: 0, childId: "child", childCreatedAt: 1, mode: "continuable", label: "worker" },
    ],
    ["feedback/record", {}],
    ["feedback/record", { text: "done", category: "task-result" }],
    [
      "feedback/message-put",
      {
        sessionId: SESSION_ID,
        item: {
          messageId: "m",
          rating: "negative",
          version: "v",
          createdAt: 1,
          updatedAt: 2,
          category: "other",
        },
      },
    ],
    [
      "tool/ptc-dispatch-start",
      { rootCallId: "root", parentCallId: "root", subCallId: "sub", name: "read", arguments: {} },
    ],
    [
      "tool/ptc-dispatch",
      {
        rootCallId: "root",
        parentCallId: "root",
        subCallId: "sub",
        name: "read",
        arguments: {},
        isError: false,
        content: [{ type: "text", text: "read" }],
      },
    ],
    [
      "team/member",
      {
        version: 2,
        teamId: "team",
        member: {
          id: "child",
          name: "worker",
          description: "task",
          provider: "local",
          context: "fresh",
          phase: "active",
        },
      },
    ],
    [
      "team/task",
      {
        version: 2,
        teamId: "team",
        task: {
          id: "task",
          revision: 1,
          subject: "task",
          description: "work",
          status: "pending",
          blockedBy: [],
          writeScopes: [],
        },
      },
    ],
    [
      "team/message/queued",
      {
        version: 2,
        teamId: "team",
        message: {
          id: "m",
          senderId: "a",
          senderName: "Alice",
          targetId: "b",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ],
    ["team/message/delivered", { version: 2, teamId: "team", messageId: "m", targetId: "b" }],
  ];

  it.each(metadata)("accepts native %s data and rejects extra wire fields", (type, data) => {
    expect(project([event(0, type, data)]).snapshot.turns).toEqual([]);
    expect(() => project([event(0, type, { ...data, unsupported: true })])).toThrow();
  });

  it.each([
    ["feedback/record", { category: "invalid" }],
    ["feedback/record", { text: " " }],
    ["deliverables/presented", { turn: 1, callId: "call", files: [{ path: "x", description: 1 }] }],
    ["deliverables/presented", { turn: 0, callId: "call", files: [] }],
    ["subagent/catalog", { version: 0, childId: "child", childCreatedAt: 1, mode: "continuable" }],
    ["subagent/catalog", { version: 1, childId: "child", childCreatedAt: 1, mode: "one-shot" }],
    ["team/member", { version: 1, teamId: "team", member: {} }],
    [
      "tool/code-dispatch-start",
      { rootCallId: "root", parentCallId: "root", subCallId: "sub", name: "read", arguments: {} },
    ],
  ] satisfies Array<[string, Record<string, unknown>]>)(
    "rejects invalid or retired %s data",
    (type, data) => {
      expect(() => project([event(0, type, data)])).toThrow();
    },
  );

  it("preserves unknown ignorable JSON metadata while rejecting malformed known metadata", async () => {
    const opaque = {
      ...event(0, "future/metadata", { valid: true }),
      ignorable: true,
      sourceEventSeqs: { opaque: true },
      surfaceOp: ["opaque"],
    } as const;
    const feed = new FollowFeed();
    feed.push(snapshot([opaque]));
    const journal = await openModernJournal(new FakeRemote(feed), {
      sessionId: SESSION_ID,
      cwd: CWD,
    });
    expect(journal.events).toEqual([opaque]);
    expect(project(journal.events).snapshot.turns).toEqual([]);
    await journal.close();
    expect(() => project([{ ...opaque, ignorable: undefined } as never])).toThrow();
    expect(() => project([event(0, "future/metadata", {})])).toThrow(/unknown required/);
    expect(() => project([{ ...opaque, type: "feedback/record" }])).toThrow(/surface metadata/);
  });

  it("rejects V0 replacement coordinates at the journal boundary", () => {
    const original = { ...system(3), sourceEventSeqs: [2] };
    expect(
      DEEPSEEK_V4_PROFILE.parseHistoryRecord(
        record({ ...original, surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 } }),
        1,
      )[0],
    ).toMatchObject({ surfaceOp: { startSeq: 2, endSeq: 2 } });
    expect(() =>
      DEEPSEEK_V4_PROFILE.parseHistoryRecord(
        record({ ...original, surfaceOp: { op: "replace", start: 2, end: 2 } }),
        1,
      ),
    ).toThrow();
  });

  it("validates file attachments and keeps tool-result blocks out of message content", () => {
    const file = { type: "file", attachment: { attachmentId: "file", name: "notes", bytes: 0 } };
    expect(() => DEEPSEEK_V4_PROFILE.validateContent([file])).not.toThrow();
    expect(() =>
      DEEPSEEK_V4_PROFILE.validateContent([
        { type: "file", attachment: { attachmentId: "file", name: "notes", bytes: -1 } },
      ]),
    ).toThrow();
    expect(() =>
      DEEPSEEK_V4_PROFILE.validateContent([
        { type: "tool-result", toolCallId: "t", content: [file] },
      ]),
    ).toThrow();
  });

  it("validates nested file and tool-result blocks in team messages", () => {
    const message = (content: unknown) =>
      event(0, "team/message/queued", {
        version: 2,
        teamId: "team",
        message: { id: "m", senderId: "a", senderName: "Alice", targetId: "b", content },
      });
    const block = {
      type: "tool-result",
      toolCallId: "t",
      content: [{ type: "file", attachment: { attachmentId: "file", name: "notes", bytes: 0 } }],
    };
    expect(project([message([block])]).snapshot.turns).toEqual([]);
    for (const invalid of [
      { ...block, toolCallId: undefined, id: "t" },
      { ...block, isError: "yes" },
    ]) {
      expect(() => project([message([invalid])])).toThrow();
    }
  });
});
