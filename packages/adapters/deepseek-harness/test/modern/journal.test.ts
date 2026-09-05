import { describe, expect, it, vi } from "vitest";

import {
  ModernJournalError,
  openModernJournal,
  type ModernJournalOptions,
  type ModernJournalRemote,
} from "../../src/modern/journal.js";
import { ModernRemoteConnectionError } from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

const SESSION_ID = "session-1";
const CWD = String.raw`E:\Coding\Project\fixture`;
const ADDRESS = { kind: "session", sessionId: SESSION_ID } as const;

class FollowFeed implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #items: IteratorResult<unknown>[] = [];
  #pending: ((item: IteratorResult<unknown>) => void) | undefined;
  #done = false;
  returnCalls = 0;

  push(value: unknown): void {
    this.#deliver({ done: false, value });
  }

  finish(): void {
    this.#done = true;
    this.#deliver({ done: true, value: undefined });
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
    this.returnCalls += 1;
    this.finish();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  #deliver(item: IteratorResult<unknown>): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) pending(item);
    else this.#items.push(item);
  }
}

type PageHandler = (
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
) => ModernRemoteResult<unknown> | Promise<ModernRemoteResult<unknown>>;

class FakeRemote implements ModernJournalRemote {
  readonly followCalls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal | undefined;
  }> = [];
  readonly pageCalls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal | undefined;
  }> = [];

  constructor(
    readonly feed: FollowFeed,
    readonly pages: PageHandler[] = [],
  ) {}

  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>> {
    this.pageCalls.push({ endpoint, args, signal });
    const page = this.pages.shift();
    if (!page) return Promise.reject(new Error("unexpected session/page call"));
    return Promise.resolve(page(args, signal)) as Promise<ModernRemoteResult<T>>;
  }

  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    this.followCalls.push({ endpoint, args, signal });
    return this.feed as AsyncIterable<T>;
  }
}

function header(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { version: 0, id: SESSION_ID, createdAt: 1, cwd: CWD, ...overrides };
}

function event(
  seq: number,
  type = "fixture/event",
  data: unknown = { seq },
): Record<string, unknown> {
  return { type, seq, time: 1_000 + seq, data };
}

function eventRecord(
  seq: number,
  type = "fixture/event",
  data: unknown = { seq },
): Record<string, unknown> {
  return { type: "event", event: event(seq, type, data) };
}

function records(from: number, through: number): Record<string, unknown>[] {
  return Array.from({ length: through - from + 1 }, (_, index) => eventRecord(from + index));
}

function snapshot(
  cursor: number,
  history: readonly unknown[],
  hasMore: boolean,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "snapshot",
    header: header(),
    cursor,
    records: history,
    hasMore,
    projections: { asOfSeq: cursor, values: {} },
    ...overrides,
  };
}

function page(history: readonly unknown[], hasMore: boolean): ModernRemoteResult<unknown> {
  return { ok: true, value: { records: history, hasMore } };
}

function wireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function openWith(
  opening: unknown,
  pages: PageHandler[] = [],
  options: ModernJournalOptions = {},
): Promise<{
  readonly feed: FollowFeed;
  readonly remote: FakeRemote;
  readonly journal: Awaited<ReturnType<typeof openModernJournal>>;
}> {
  const feed = new FollowFeed();
  feed.push(opening);
  const remote = new FakeRemote(feed, pages);
  const journal = await openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD }, options);
  return { feed, remote, journal };
}

describe("DeepSeek Harness Modern journal", () => {
  it("opens follow first and pages a fixed opening cut backwards to zero", async () => {
    const setup = await openWith(snapshot(5, records(4, 5), true), [
      () =>
        page(
          [
            {
              type: "chunks",
              event: {
                type: "chunkrow/text-chunks",
                seq: 1,
                time: 1_001,
                data: {
                  turn: 1,
                  step: 1,
                  index: 0,
                  dt: [1, 1],
                  texts: ["a", "b", "c"],
                },
              },
            },
          ],
          true,
        ),
      () => page(records(0, 0), false),
    ]);
    try {
      expect(setup.journal.events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(setup.remote.followCalls).toHaveLength(1);
      expect(setup.remote.followCalls[0]).toMatchObject({
        endpoint: "session/follow",
        args: { request: { address: ADDRESS, maxMessages: 200 } },
      });
      expect(setup.remote.pageCalls.map(({ endpoint, args }) => ({ endpoint, args }))).toEqual([
        {
          endpoint: "session/page",
          args: {
            request: { address: ADDRESS, throughSeq: 5, beforeSeq: 4, maxMessages: 200 },
          },
        },
        {
          endpoint: "session/page",
          args: {
            request: { address: ADDRESS, throughSeq: 5, beforeSeq: 1, maxMessages: 200 },
          },
        },
      ]);
    } finally {
      await setup.journal.close();
    }
  });

  it("reconstructs a long history across multiple fixed-cut pages", async () => {
    const setup = await openWith(snapshot(450, records(400, 450), true), [
      () => page(records(200, 399), true),
      () => page(records(0, 199), false),
    ]);
    try {
      expect(setup.journal.events).toHaveLength(451);
      expect(setup.journal.events[0]?.seq).toBe(0);
      expect(setup.journal.events.at(-1)?.seq).toBe(450);
      expect(setup.remote.pageCalls.map(({ args }) => args.request)).toEqual([
        expect.objectContaining({ throughSeq: 450, beforeSeq: 400 }),
        expect.objectContaining({ throughSeq: 450, beforeSeq: 200 }),
      ]);
    } finally {
      await setup.journal.close();
    }
  });

  it("drains and buffers live events while historical paging is still running", async () => {
    const feed = new FollowFeed();
    feed.push(snapshot(5, records(4, 5), true));
    const remote = new FakeRemote(feed, [
      () => {
        feed.push({ type: "event", event: event(6, "plugin/future", { kept: true }) });
        return page(records(0, 3), false);
      },
    ]);
    const journal = await openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD });
    try {
      const live = journal.live[Symbol.asyncIterator]();
      await expect(live.next()).resolves.toEqual({
        done: false,
        value: event(6, "plugin/future", { kept: true }),
      });
      expect(journal.events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      await journal.close();
    }
  });

  it("enforces one aggregate history byte budget across opening, live, and fixed-cut pages", async () => {
    const openingRecord = eventRecord(1);
    const olderRecord = eventRecord(0);
    const liveFrame = { type: "event", event: event(2) };
    const pageStarted = Promise.withResolvers<undefined>();
    const pageResult = Promise.withResolvers<ModernRemoteResult<unknown>>();
    const feed = new FollowFeed();
    feed.push(snapshot(1, [openingRecord], true));
    const remote = new FakeRemote(feed, [
      () => {
        pageStarted.resolve(undefined);
        return pageResult.promise;
      },
    ]);
    const opening = openModernJournal(
      remote,
      { sessionId: SESSION_ID, cwd: CWD },
      {
        maxHistoryBytes:
          wireBytes(openingRecord.event) + wireBytes(liveFrame) + wireBytes(olderRecord.event) - 1,
      },
    );

    await pageStarted.promise;
    feed.push(liveFrame);
    await Promise.resolve();
    pageResult.resolve(page([olderRecord], false));
    await expect(opening).rejects.toMatchObject({ code: "limitExceeded" });
    expect(feed.returnCalls).toBe(1);
  });

  it("keeps consumed live frames in the generation history byte budget", async () => {
    const openingRecord = eventRecord(0);
    const firstFrame = { type: "event", event: event(1) };
    const secondFrame = { type: "event", event: event(2) };
    const setup = await openWith(snapshot(0, [openingRecord], false), [], {
      maxHistoryBytes: wireBytes(openingRecord.event) + wireBytes(firstFrame),
    });
    const live = setup.journal.live[Symbol.asyncIterator]();
    setup.feed.push(firstFrame);
    await expect(live.next()).resolves.toMatchObject({ done: false, value: { seq: 1 } });
    setup.feed.push(secondFrame);
    await expect(live.next()).rejects.toMatchObject({ code: "limitExceeded" });
    await setup.journal.close();
  });

  it("enforces the aggregate queued-live byte budget at its exact boundary", async () => {
    const firstFrame = { type: "event", event: event(0) };
    const secondFrame = { type: "event", event: event(1) };
    const success = await openWith(snapshot(-1, [], false), [], {
      maxBufferedLiveBytes: wireBytes(firstFrame) + wireBytes(secondFrame),
    });
    success.feed.push(firstFrame);
    success.feed.push(secondFrame);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const live = success.journal.live[Symbol.asyncIterator]();
    await expect(live.next()).resolves.toMatchObject({ value: { seq: 0 } });
    await expect(live.next()).resolves.toMatchObject({ value: { seq: 1 } });
    await success.journal.close();

    const failure = await openWith(snapshot(-1, [], false), [], {
      maxBufferedLiveBytes: wireBytes(firstFrame) + wireBytes(secondFrame) - 1,
    });
    failure.feed.push(firstFrame);
    failure.feed.push(secondFrame);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(failure.journal.live[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "limitExceeded",
    });
    await failure.journal.close();
  });

  it("losslessly expands text, reasoning, and tool-call chunk rows", async () => {
    const packed = [
      {
        type: "chunks",
        event: {
          type: "chunkrow/text-chunks",
          seq: 0,
          time: 100,
          data: { turn: 1, step: 2, index: 0, dt: [2, -1], texts: ["a", "", "c"] },
        },
      },
      {
        type: "chunks",
        event: {
          type: "chunkrow/reasoning-chunks",
          seq: 3,
          time: 200,
          data: { turn: 1, step: 2, index: 1, dt: [3], texts: ["r1", "r2"] },
        },
      },
      {
        type: "chunks",
        event: {
          type: "chunkrow/tool-call-chunks",
          seq: 5,
          time: 300,
          data: {
            turn: 1,
            step: 2,
            index: 2,
            id: "call-1",
            name: "write",
            dt: [0, 4],
            args: ["{", '"x":1', "}"],
          },
        },
      },
    ];
    const setup = await openWith(snapshot(7, packed, false));
    try {
      expect(setup.journal.events.map(({ seq, time }) => [seq, time])).toEqual([
        [0, 100],
        [1, 102],
        [2, 101],
        [3, 200],
        [4, 203],
        [5, 300],
        [6, 300],
        [7, 304],
      ]);
      expect(setup.journal.events.map(({ data }) => data)).toMatchObject([
        { chunk: { type: "text-delta", text: "a" } },
        { chunk: { type: "text-delta", text: "" } },
        { chunk: { type: "text-delta", text: "c" } },
        { chunk: { type: "reasoning-delta", text: "r1" } },
        { chunk: { type: "reasoning-delta", text: "r2" } },
        {
          chunk: {
            type: "tool-call-delta",
            id: "call-1",
            name: "write",
            argumentsDelta: "{",
          },
        },
        { chunk: { argumentsDelta: '"x":1' } },
        { chunk: { argumentsDelta: "}" } },
      ]);
    } finally {
      await setup.journal.close();
    }
  });

  it("supports a blank opening cut and starts live delivery at sequence zero", async () => {
    const setup = await openWith(snapshot(-1, [], false));
    try {
      expect(setup.journal.events).toEqual([]);
      expect(setup.journal.cursor).toBe(-1);
      setup.feed.push({ type: "event", event: event(0, "plugin/unknown", { raw: [1] }) });
      await expect(setup.journal.live[Symbol.asyncIterator]().next()).resolves.toEqual({
        done: false,
        value: event(0, "plugin/unknown", { raw: [1] }),
      });
    } finally {
      await setup.journal.close();
    }
  });

  it("applies the default opening deadline to every journal", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const feed = new FollowFeed();
    const remote = new FakeRemote(feed);
    try {
      const opening = openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD });
      timeout.abort();
      await expect(opening).rejects.toMatchObject({ code: "unavailable" });
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
      expect(feed.returnCalls).toBe(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("uses the opening deadline only for the first snapshot and keeps the adopted follow live", async () => {
    const setup = await openWith(snapshot(-1, [], false), [], { openingTimeoutMs: 10 });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    setup.feed.push({ type: "event", event: event(0) });
    await expect(setup.journal.live[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: { seq: 0 },
    });
    await setup.journal.close();
  });

  it.each([
    ["header id", { header: header({ id: "other" }) }],
    ["header cwd", { header: header({ cwd: String.raw`E:\other` }) }],
    ["projection cut", { projections: { asOfSeq: 0, values: {} } }],
  ])("rejects a mismatched %s and returns the follow iterator", async (_label, overrides) => {
    const feed = new FollowFeed();
    feed.push(snapshot(1, records(0, 1), false, overrides));
    const remote = new FakeRemote(feed);
    await expect(
      openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD }),
    ).rejects.toMatchObject({ code: "protocolError" });
    expect(feed.returnCalls).toBe(1);
  });

  it.each([
    [
      "malformed event envelope",
      snapshot(0, [{ ...eventRecord(0), extra: true }], false),
      {},
      "protocolError",
    ],
    [
      "malformed packed row",
      snapshot(
        1,
        [
          {
            type: "chunks",
            event: {
              type: "chunkrow/text-chunks",
              seq: 0,
              time: 1,
              data: { turn: 1, step: 1, index: 0, dt: [], texts: ["a", "b"] },
            },
          },
        ],
        false,
      ),
      {},
      "protocolError",
    ],
    [
      "oversized record",
      snapshot(0, [eventRecord(0, "fixture/event", { value: "x".repeat(1_000) })], false),
      { maxRecordBytes: 300 },
      "limitExceeded",
    ],
    [
      "per-page record bound",
      snapshot(1, records(0, 1), false),
      { maxRecordsPerPage: 1 },
      "limitExceeded",
    ],
    ["total event bound", snapshot(2, records(0, 2), false), { maxEvents: 2 }, "limitExceeded"],
  ] as const)(
    "rejects %s and returns the follow iterator",
    async (_label, opening, options, code) => {
      const feed = new FollowFeed();
      feed.push(opening);
      const remote = new FakeRemote(feed);
      await expect(
        openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD }, options),
      ).rejects.toMatchObject({ code });
      expect(feed.returnCalls).toBe(1);
    },
  );

  it.each([
    ["gap", () => page(records(0, 2), false), {}],
    ["overlap", () => page(records(3, 4), true), {}],
    [
      "packed partial overlap",
      () =>
        page(
          [
            {
              type: "chunks",
              event: {
                type: "chunkrow/text-chunks",
                seq: 2,
                time: 1,
                data: {
                  turn: 1,
                  step: 1,
                  index: 0,
                  dt: [1, 1],
                  texts: ["a", "b", "c"],
                },
              },
            },
          ],
          true,
        ),
      {},
    ],
    ["no progress", () => page([], true), {}],
    ["page limit", () => page(records(2, 3), true), { maxPageRequests: 1 }],
  ] as const)("rejects paging %s without leaking follow", async (_label, handler, options) => {
    const feed = new FollowFeed();
    feed.push(snapshot(5, records(4, 5), true));
    const remote = new FakeRemote(feed, [handler]);
    await expect(
      openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD }, options),
    ).rejects.toBeInstanceOf(ModernJournalError);
    expect(feed.returnCalls).toBe(1);
  });

  it("surfaces a sanitized session/page Remote failure and closes follow", async () => {
    const canary = "SUPER_SECRET_CANARY";
    const feed = new FollowFeed();
    feed.push(snapshot(1, records(1, 1), true));
    const remote = new FakeRemote(feed, [
      () => ({
        ok: false,
        error: {
          code: `api_key=${canary}`,
          message: `secret=${canary}`,
          details: { secret: canary },
        },
      }),
    ]);
    const failure = await openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "remoteError", nativeCode: "api_key=[redacted]" });
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(feed.returnCalls).toBe(1);
  });

  it("never retains raw transport credentials in an exception cause", async () => {
    const canary = "RAW_CAUSE_CANARY";
    const token = "A".repeat(43);
    const cookieValue = "v1.body.signature";
    const raw = new Error(
      `failed ?token=${token} api_key=${canary} Bearer ${canary} dsh-auth-${"B".repeat(43)}=${cookieValue}`,
      { cause: new Error(canary) },
    );
    async function* failedFollow(): AsyncGenerator<unknown> {
      throw raw;
    }
    const remote = {
      call: () => Promise.reject(new Error("unexpected call")),
      openStream: () => failedFollow(),
    } as unknown as ModernJournalRemote;

    const failure = await openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ModernJournalError);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect((failure as Error).cause).toBeUndefined();
    expect((failure as ModernJournalError).nativeCode).toBeUndefined();
    for (const secret of [canary, token, cookieValue]) {
      expect((failure as Error).message).not.toContain(secret);
      expect(String((failure as Error).cause ?? "")).not.toContain(secret);
    }
  });

  it.each(["authenticationRequired", "processExited"] as const)(
    "preserves a typed %s failure from follow opening",
    async (code) => {
      async function* failedFollow(): AsyncGenerator<unknown> {
        throw new ModernRemoteConnectionError(code, `typed ${code}`);
      }
      const remote = {
        call: () => Promise.reject(new Error("unexpected call")),
        openStream: () => failedFollow(),
      } as unknown as ModernJournalRemote;

      await expect(
        openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("sanitizes iterator.return rejection during close", async () => {
    const canary = "RETURN_CAUSE_CANARY";
    const token = "C".repeat(43);
    const cookieValue = "v1.return.signature";
    const raw = new Error(
      `close ?token=${token} api_key=${canary} Bearer ${canary} dsh-auth-${"D".repeat(43)}=${cookieValue}`,
      { cause: new Error(canary) },
    );
    let calls = 0;
    let finishPending: ((item: IteratorResult<unknown>) => void) | undefined;
    const iterator: AsyncIterator<unknown> = {
      next: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ done: false, value: snapshot(0, [eventRecord(0)], false) });
        }
        return new Promise((resolve) => {
          finishPending = resolve;
        });
      },
      return: () => {
        finishPending?.({ done: true, value: undefined });
        return Promise.reject(raw);
      },
    };
    const remote = {
      call: () => Promise.reject(new Error("unexpected call")),
      openStream: () => ({ [Symbol.asyncIterator]: () => iterator }),
    } as unknown as ModernJournalRemote;
    const journal = await openModernJournal(remote, { sessionId: SESSION_ID, cwd: CWD });

    const failure = await journal.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModernJournalError);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect((failure as Error).cause).toBeUndefined();
    expect((failure as ModernJournalError).nativeCode).toBeUndefined();
    for (const secret of [canary, token, cookieValue]) {
      expect((failure as Error).message).not.toContain(secret);
      expect(String((failure as Error).cause ?? "")).not.toContain(secret);
    }
  });

  it.each([
    ["second snapshot", snapshot(0, [eventRecord(0)], false)],
    [
      "packed live frame",
      {
        type: "chunks",
        event: {
          type: "chunkrow/text-chunks",
          seq: 1,
          time: 1,
          data: { turn: 1, step: 1, index: 0, dt: [], texts: ["x"] },
        },
      },
    ],
    ["sequence gap", { type: "event", event: event(2) }],
  ])("rejects live %s and returns follow", async (_label, frame) => {
    const setup = await openWith(snapshot(0, [eventRecord(0)], false));
    setup.feed.push(frame);
    await expect(setup.journal.live[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "protocolError",
    });
    expect(setup.feed.returnCalls).toBe(1);
  });

  it("closes an unused live iterator early and makes close idempotent", async () => {
    const setup = await openWith(snapshot(0, [eventRecord(0)], false));
    const live = setup.journal.live[Symbol.asyncIterator]();
    const waiting = live.next();
    await setup.journal.close();
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
    await setup.journal.close();
    expect(setup.feed.returnCalls).toBe(1);
  });
});
