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
import {
  DEEPSEEK_V012_PROFILE,
  DEEPSEEK_V015_PROFILE,
  deepSeekModernProfile,
} from "../../src/profiles/profile.js";
import {
  expandV015AssistantStream,
  parseV015AssistantBaseline,
  parseV015AssistantFrame,
} from "../../src/profiles/v015.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

const SESSION_ID = "session-v015";
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
      version: 3,
      id: SESSION_ID,
      createdAt: 1,
      cwd: CWD,
      isSeeded: false,
    },
    cursor,
    records: events.map(record),
    hasMore: false,
    projections: { asOfSeq: cursor, values: {} },
    assistantStream: { revision: 0 },
    ...overrides,
  };
}

function v015History(): ModernJournalEvent[] {
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
      sessionFormatVersion: 3,
    }),
    event(6, "step/end", { turn: 1, step: 1 }),
    event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
}

describe("DeepSeek v0.1.5 RC profile", () => {
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
        { profile: DEEPSEEK_V015_PROFILE, maxBufferedLiveEvents: 1 },
      ),
    ).rejects.toMatchObject({ code: "limitExceeded" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves native raw empty tool fragments while rejecting invalid compact runs", () => {
    const chunk = { type: "tool-call-delta", index: 0, id: "", name: "", argumentsDelta: "{" };
    expect(expandV015AssistantStream([{ type: "chunk", time: 1, chunk }])).toEqual([
      { time: 1, chunk },
    ]);
    expect(
      parseV015AssistantFrame({
        type: "chunk",
        attemptId: "a",
        revision: 2,
        index: 0,
        time: 1,
        chunk,
      }),
    ).toMatchObject({ chunk });
    expect(() =>
      expandV015AssistantStream([
        { type: "tool-call-chunks", time0: 1, index: 0, id: "", name: "", dt: [], args: ["{"] },
      ]),
    ).toThrow();
    expect(() => DEEPSEEK_V012_PROFILE.validateChunk(chunk)).toThrow();
  });

  it("reads native message feedback as log-only metadata and rejects it in v012", () => {
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
      projectModernHistory({
        sessionId: SESSION_ID,
        profile: DEEPSEEK_V015_PROFILE,
        events: feedback,
      }).snapshot.turns,
    ).toEqual([]);
    expect(() => projectModernHistory({ sessionId: SESSION_ID, events: feedback })).toThrow();
    for (const invalid of [
      { ...(feedback[0] as ModernJournalEvent), surfaceOp: "append" as const },
      event(0, "feedback/message-put", {
        sessionId: SESSION_ID,
        item: { messageId: "m", rating: "maybe", version: "v1", createdAt: 1, updatedAt: 2 },
      }),
      event(0, "feedback/message-delete", { sessionId: SESSION_ID }),
    ]) {
      expect(() =>
        projectModernHistory({
          sessionId: SESSION_ID,
          profile: DEEPSEEK_V015_PROFILE,
          events: [invalid],
        }),
      ).toThrow();
    }
  });

  it.each([DEEPSEEK_V012_PROFILE, DEEPSEEK_V015_PROFILE])(
    "accepts native fractional Hook durations in $version",
    (profile) => {
      const hook = {
        turn: 1,
        point: "PostToolUse",
        handlerId: "hook",
        decision: "pass",
        durationMs: 9.40504199999998,
      };
      expect(() =>
        projectModernHistory({
          sessionId: SESSION_ID,
          profile,
          events: [event(0, "hook/result", hook)],
        }),
      ).not.toThrow();
      for (const durationMs of [-1, Infinity, NaN, "9.4"]) {
        expect(() =>
          projectModernHistory({
            sessionId: SESSION_ID,
            profile,
            events: [event(0, "hook/result", { ...hook, durationMs })],
          }),
        ).toThrow();
      }
    },
  );

  it("expands compact Assistant streams without changing delta boundaries", () => {
    expect(
      expandV015AssistantStream([
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
    expect(() => expandV015AssistantStream(stream)).toThrow(/v0\.1\.5/u);
  });

  it("requires a positive baseline revision for an active attempt", () => {
    expect(
      parseV015AssistantBaseline({
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
      parseV015AssistantBaseline({
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
      parseV015AssistantFrame({
        type: "chunk",
        attemptId: "attempt-1",
        revision: 2,
        index: 0,
        time: 10,
        chunk: { type: "text-delta", index: 0, text: "a" },
      }),
    ).toMatchObject({ type: "chunk", revision: 2, index: 0 });
    expect(() =>
      parseV015AssistantFrame({
        type: "chunk",
        attemptId: "attempt-1",
        revision: 2,
        index: 0,
        time: 10,
        chunk: { type: "future" },
      }),
    ).toThrow(/chunk/u);
  });

  it("opens v3 with assistant streaming and keeps transient frames outside the durable cursor", async () => {
    const feed = new FollowFeed();
    feed.push(snapshot([event(0, "fixture/event", { ok: true })]));
    const remote = new FakeRemote(feed);
    const journal = await openModernJournal(
      remote,
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V015_PROFILE },
    );
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
    const journal = await openModernJournal(
      new FakeRemote(feed),
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V015_PROFILE },
    );
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
    const journal = await openModernJournal(
      new FakeRemote(feed),
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V015_PROFILE },
    );
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
    const journal = await openModernJournal(
      new FakeRemote(feed),
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V015_PROFILE },
    );
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

  it("isolates v0 and v3 wire formats", async () => {
    const v0Feed = new FollowFeed();
    v0Feed.push(
      snapshot([], {
        header: { version: 0, id: SESSION_ID, createdAt: 1, cwd: CWD },
      }),
    );
    await expect(
      openModernJournal(
        new FakeRemote(v0Feed),
        { sessionId: SESSION_ID, cwd: CWD },
        { profile: DEEPSEEK_V015_PROFILE },
      ),
    ).rejects.toMatchObject({ code: "protocolError" });

    const v3Feed = new FollowFeed();
    v3Feed.push(snapshot([]));
    await expect(
      openModernJournal(
        new FakeRemote(v3Feed),
        { sessionId: SESSION_ID, cwd: CWD },
        { profile: DEEPSEEK_V012_PROFILE },
      ),
    ).rejects.toMatchObject({ code: "protocolError" });
  });

  it("projects retry Usage once per v3 settlement and emits v3 references", () => {
    const projection = projectModernHistory({
      sessionId: SESSION_ID,
      events: v015History(),
      profile: DEEPSEEK_V015_PROFILE,
    });

    expect(projection.snapshot.turns).toHaveLength(1);
    expect(projection.snapshot.turns[0]).toMatchObject({
      checkpoint: {
        checkpointId: "v3-turn-end:7",
        locator: { dshVersion: "0.1.5-rc.1" },
      },
      items: [{ item: { type: "agentMessage", text: "done" } }],
    });
    expect(projection.nativeRef).toMatchObject({
      formatVersion: 1,
      locator: { dshVersion: "0.1.5-rc.1" },
    });
    expect(projection.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
  });

  it("accepts an empty migrated message stream but rejects v3 chunk events and provenance", () => {
    const history = v015History();
    const message = history[4] as ModernJournalEvent;
    const data = message.data as Record<string, unknown>;
    const migrated = projectModernHistory({
      sessionId: SESSION_ID,
      events: [
        ...history.slice(0, 4),
        { ...message, data: { ...data, stream: [] } as never },
        ...history.slice(5),
      ],
      profile: DEEPSEEK_V015_PROFILE,
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
        profile: DEEPSEEK_V015_PROFILE,
      }),
    ).toThrow(ModernHistoryError);
    expect(() =>
      projectModernHistory({
        sessionId: SESSION_ID,
        events: [...history.slice(0, 4), { ...message, sourceEventSeqs: [1] }],
        profile: DEEPSEEK_V015_PROFILE,
      }),
    ).toThrow(ModernHistoryError);
  });

  it("uses the tagged v3 fork marker and rejects a v1 checkpoint namespace", () => {
    const source = v015History();
    const boundary = resolveModernForkBoundary(source, "v3-turn-end:7", DEEPSEEK_V015_PROFILE);
    expect(boundary?.atSeq).toBe(7);
    expect(resolveModernForkBoundary(source, "turn-end:7", DEEPSEEK_V015_PROFILE)).toBeNull();
    const child = [
      ...source,
      event(8, "session/end-seed", { inherited: true }),
      event(9, "agent-preset/selected", { agentPreset: "coding" }),
    ];
    expect(matchesModernForkHistory(source, child, DEEPSEEK_V015_PROFILE)).toBe(true);
    expect(
      matchesModernForkHistory(
        source,
        [...source, event(8, "session/end-seed", {})],
        DEEPSEEK_V015_PROFILE,
      ),
    ).toBe(false);
  });
});

describe("DSH 0.1.5-rc.1 V3 durable protocol", () => {
  const project = (events: readonly ModernJournalEvent[]) =>
    projectModernHistory({
      sessionId: SESSION_ID,
      events,
      profile: DEEPSEEK_V015_PROFILE,
    });
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
          source: { kind: "plugin", plugin: "agent-loop" },
        },
      },
      true,
    );
  const prefix = () => [
    event(0, "turn/start", { turn: 1 }),
    event(1, "step/start", { turn: 1, step: 1 }),
    system(2),
  ];

  it("replays the RC's recorded empty-response retry, system message and request header", () => {
    const rows = readFileSync(
      new URL("../fixtures/dsh-015rc1-empty-response-retry.v3.jsonl", import.meta.url),
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
      DEEPSEEK_V015_PROFILE.parseHeader(header, {
        sessionId: header.id as string,
        cwd: header.cwd as string,
      }).version,
    ).toBe(3);
    // DSH snapshots elide event seq/time and substitute the environment's tool catalog.
    const events = rows.map((row, seq) => {
      const data = row.data as Record<string, unknown>;
      if (row.type === "request/header") {
        const header = data.header as Record<string, unknown>;
        expect(header).not.toHaveProperty("system");
        data.header = {
          ...header,
          tools: [
            {
              name: "fixture",
              description: "fixture",
              parameters: { type: "object", properties: {} },
            },
          ],
        };
      }
      return { ...row, seq, time: 1_000 + seq } as unknown as ModernJournalEvent;
    });
    const projected = projectModernHistory({
      sessionId: header.id as string,
      events,
      profile: DEEPSEEK_V015_PROFILE,
    });
    expect(projected.snapshot.turns).toHaveLength(1);
    expect(projected.snapshot.turns[0]).toMatchObject({
      items: [{ item: { type: "agentMessage", text: "Recovered." } }],
    });
    expect(projected.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    assert(projected.effectiveModel);
    expect(decodeDeepSeekHarnessModelRef(projected.effectiveModel)).toMatchObject({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
  });

  it("keeps exact executable and durable format versions isolated", () => {
    expect(deepSeekModernProfile("0.1.2-rc.1")).toBe(DEEPSEEK_V012_PROFILE);
    expect(deepSeekModernProfile("0.1.5-rc.1")).toBe(DEEPSEEK_V015_PROFILE);
    for (const version of ["0.1.3-rc.1", "0.1.5-rc.2", "0.1.5-rc.1+build"]) {
      expect(() => deepSeekModernProfile(version as never)).toThrow(/only supports/);
    }
    for (const version of [0, 1, 2, 4]) {
      expect(() =>
        DEEPSEEK_V015_PROFILE.parseHeader(
          { version, id: SESSION_ID, createdAt: 1, isSeeded: false },
          { sessionId: SESSION_ID },
        ),
      ).toThrow();
    }
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
    expect(() => projectModernHistory({ sessionId: SESSION_ID, events: history })).toThrow();
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
    expect(() =>
      projectModernHistory({ sessionId: SESSION_ID, events: [event(0, type, data)] }),
    ).toThrow();
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
    const journal = await openModernJournal(
      new FakeRemote(feed),
      { sessionId: SESSION_ID, cwd: CWD },
      { profile: DEEPSEEK_V015_PROFILE },
    );
    expect(journal.events).toEqual([opaque]);
    expect(project(journal.events).snapshot.turns).toEqual([]);
    await journal.close();
    expect(() => project([{ ...opaque, ignorable: undefined } as never])).toThrow();
    expect(() => project([event(0, "future/metadata", {})])).toThrow(/unknown required/);
    expect(() => project([{ ...opaque, type: "feedback/record" }])).toThrow(/surface metadata/);
    expect(() => projectModernHistory({ sessionId: SESSION_ID, events: [opaque] })).toThrow();
  });

  it("rejects V0 replacement coordinates at the V3 journal boundary", () => {
    const original = { ...system(3), sourceEventSeqs: [2] };
    expect(
      DEEPSEEK_V015_PROFILE.parseHistoryRecord(
        record({ ...original, surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 } }),
        1,
      )[0],
    ).toMatchObject({ surfaceOp: { startSeq: 2, endSeq: 2 } });
    expect(() =>
      DEEPSEEK_V015_PROFILE.parseHistoryRecord(
        record({ ...original, surfaceOp: { op: "replace", start: 2, end: 2 } }),
        1,
      ),
    ).toThrow();
    expect(() =>
      DEEPSEEK_V012_PROFILE.parseHistoryRecord(
        record({ ...original, surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 } }),
        1,
      ),
    ).toThrow();
  });

  it("validates nested file and tool-result blocks", () => {
    const block = {
      type: "tool-result",
      toolCallId: "t",
      content: [{ type: "file", attachment: { attachmentId: "file", name: "notes", bytes: 0 } }],
    };
    expect(() => DEEPSEEK_V015_PROFILE.validateContent([block])).not.toThrow();
    expect(() =>
      DEEPSEEK_V015_PROFILE.validateContent([{ ...block, toolCallId: undefined, id: "t" }]),
    ).toThrow();
    expect(() => DEEPSEEK_V015_PROFILE.validateContent([{ ...block, isError: "yes" }])).toThrow();
    expect(() =>
      DEEPSEEK_V015_PROFILE.validateContent([
        { type: "file", attachment: { attachmentId: "file", name: "notes", bytes: -1 } },
      ]),
    ).toThrow();
  });
});
