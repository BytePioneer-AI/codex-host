import { describe, expect, it, vi } from "vitest";

import {
  ModernControlStore,
  ModernControlStoreError,
  type ModernControlStreamSource,
} from "../../src/modern/control-store.js";
import { ModernRemoteConnectionError } from "../../src/modern/remote-connection.js";

class ControlFeed implements ModernControlStreamSource {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
  }> = [];
  signal: AbortSignal | undefined;
  returned = false;
  readonly #items: unknown[] = [];
  #ended = false;
  #wake: (() => void) | undefined;

  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    this.calls.push({ endpoint, args });
    this.signal = signal;
    return this.#read(signal) as AsyncIterable<T>;
  }

  push(value: unknown): void {
    this.#items.push(value);
    this.#wake?.();
    this.#wake = undefined;
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
    this.#wake = undefined;
  }

  async *#read(signal?: AbortSignal): AsyncGenerator<unknown> {
    const wake = (): void => {
      this.#wake?.();
      this.#wake = undefined;
    };
    signal?.addEventListener("abort", wake, { once: true });
    try {
      for (;;) {
        const item = this.#items.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        if (this.#ended || signal?.aborted) return;
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", wake);
      this.returned = true;
    }
  }
}

class ControlGenerations implements ModernControlStreamSource {
  readonly calls: Array<{
    readonly endpoint: string;
    readonly args: Readonly<Record<string, unknown>>;
  }> = [];
  #index = 0;

  constructor(readonly feeds: readonly ControlFeed[]) {}

  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    this.calls.push({ endpoint, args });
    const feed = this.feeds[this.#index++];
    if (!feed) throw new ModernRemoteConnectionError("unavailable", "missing control generation");
    return feed.openStream<T>(endpoint, args, signal);
  }
}

function projectionBlock(asOfSeq: number, values: Record<string, unknown>) {
  return { asOfSeq, values };
}

function baseline(
  projections: Record<string, ReturnType<typeof projectionBlock>> = {},
  input: { queues?: Record<string, unknown[]>; jobs?: Record<string, unknown[]> } = {},
) {
  const sessionIds = new Set([
    ...Object.keys(projections),
    ...Object.keys(input.queues ?? {}),
    ...Object.keys(input.jobs ?? {}),
  ]);
  return {
    type: "baseline",
    value: {
      queues:
        input.queues ?? Object.fromEntries([...sessionIds].map((sessionId) => [sessionId, []])),
      jobs: input.jobs ?? Object.fromEntries([...sessionIds].map((sessionId) => [sessionId, []])),
      projections,
    },
  };
}

function projection(sessionId: string, key: string, value: unknown, seq: number) {
  return { type: "projection", sessionId, key, value, seq };
}

async function openedStore(
  feed = new ControlFeed(),
  opening: unknown = baseline(),
  options: ConstructorParameters<typeof ModernControlStore>[1] = {},
): Promise<{ feed: ControlFeed; store: ModernControlStore }> {
  const store = new ModernControlStore(feed, options);
  const ready = store.start();
  feed.push(opening);
  await ready;
  return { feed, store };
}

async function expectFault(store: ModernControlStore, code: string): Promise<void> {
  await vi.waitFor(() => {
    expect(store.fault).toMatchObject({ code });
  });
}

function captureThrow(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}

function expectCredentialSafe(error: unknown, secret: string): void {
  expect(error).toBeInstanceOf(Error);
  const failure = error as Error;
  expect(failure.name).not.toContain(secret);
  expect(failure.message).not.toContain(secret);
  expect(failure.cause).toBeUndefined();
}

describe("Modern control opening and projection updates", () => {
  it("accepts one exact opening baseline, validates queue/jobs, and publishes higher updates", async () => {
    const feed = new ControlFeed();
    const store = new ModernControlStore(feed);
    store.attach("s1");
    const listener = vi.fn();
    store.subscribe("s1", "modelSelection", listener);
    const ready = store.start();
    feed.push(
      baseline(
        { s1: projectionBlock(2, { modelSelection: { model: "v4" } }) },
        {
          queues: {
            s1: [
              {
                id: "message-1",
                placement: "queued",
                rpcId: "rpc-1",
                message: { id: "message-1", content: [{ type: "text", text: "hello" }] },
              },
            ],
          },
          jobs: {
            s1: [
              {
                id: "job-1",
                kind: "shell",
                label: "Build",
                status: "running",
                startedAt: 1,
              },
            ],
          },
        },
      ),
    );
    await ready;
    expect(feed.calls).toEqual([{ endpoint: "session/control", args: {} }]);
    expect(store.snapshot("s1")).toEqual({
      modelSelection: { value: { model: "v4" }, seq: 2 },
    });

    feed.push(projection("s1", "modelSelection", { model: "v4-pro" }, 3));
    await vi.waitFor(() => {
      expect(store.snapshot("s1")?.modelSelection).toEqual({
        value: { model: "v4-pro" },
        seq: 3,
      });
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(store.snapshot("s1")?.modelSelection)).toBe(true);
    expect(Object.isFrozen(store.snapshot("s1")?.modelSelection?.value)).toBe(true);
    await store.close();
  });

  it("merges a follow opening seed and never caches unloaded Sessions", async () => {
    const { feed, store } = await openedStore(
      new ControlFeed(),
      baseline({
        loadedLater: projectionBlock(2, { permission: "from-control" }),
        neverLoaded: projectionBlock(3, { hidden: true }),
      }),
    );
    feed.push(projection("neverLoaded", "hidden", false, 4));
    store.attach("loadedLater", {
      asOfSeq: 5,
      values: { permission: "from-follow", plan: { enabled: true } },
    });
    expect(store.snapshot("loadedLater")).toEqual({
      permission: { value: "from-follow", seq: 5 },
      plan: { value: { enabled: true }, seq: 5 },
    });
    store.attach("neverLoaded");
    expect(store.snapshot("neverLoaded")).toEqual({});

    feed.push(projection("loadedLater", "permission", "stale", 4));
    await Promise.resolve();
    expect(store.snapshot("loadedLater")?.permission).toEqual({ value: "from-follow", seq: 5 });
    await store.close();
  });

  it("drops stale updates, accepts same-sequence identity, and faults on conflict", async () => {
    const { feed, store } = await openedStore();
    store.attach("s1", { asOfSeq: 5, values: { permission: { mode: "write" } } });
    const listener = vi.fn();
    store.subscribe("s1", "permission", listener);
    feed.push(projection("s1", "permission", { mode: "stale" }, 4));
    feed.push(projection("s1", "permission", { mode: "write" }, 5));
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot("s1")?.permission).toEqual({
      value: { mode: "write" },
      seq: 5,
    });

    const pending = store.waitFor("s1", "other", 5, () => true, { timeoutMs: 1_000 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "protocolError" });
    feed.push(projection("s1", "permission", { mode: "full" }, 5));
    await expectFault(store, "protocolError");
    await rejected;
    await store.close();
  });

  it("rejects a second baseline on the same physical stream", async () => {
    const { feed, store } = await openedStore();
    feed.push(baseline());
    await expectFault(store, "protocolError");
    await store.close();
  });

  it("allows the physical opening baseline to omit an already attached Session", async () => {
    const feed = new ControlFeed();
    const store = new ModernControlStore(feed);
    store.attach("not-yet-visible");
    const ready = store.start();
    feed.push(baseline());
    await ready;
    expect(store.snapshot("not-yet-visible")).toEqual({});
    await store.close();
  });
});

describe("Modern projection confirmation waiters", () => {
  it("handles both update-before-response and response-before-update orderings", async () => {
    const { feed, store } = await openedStore();
    store.attach("s1");

    feed.push(projection("s1", "model", { id: "early" }, 6));
    await vi.waitFor(() => {
      expect(store.snapshot("s1")?.model?.seq).toBe(6);
    });
    await expect(
      store.waitFor(
        "s1",
        "model",
        5,
        (value) =>
          typeof value === "object" && value !== null && "id" in value && value.id === "early",
      ),
    ).resolves.toMatchObject({ seq: 6 });

    const later = store.waitFor("s1", "permission", 6, (value) => value === "danger-full-access");
    feed.push(projection("s1", "permission", "workspace-write", 7));
    feed.push(projection("s1", "permission", "danger-full-access", 8));
    await expect(later).resolves.toEqual({ value: "danger-full-access", seq: 8 });
    await store.close();
  });

  it("settles timeout, abort, detach, and close exactly once", async () => {
    const { store } = await openedStore(new ControlFeed(), baseline(), { waitTimeoutMs: 10 });
    store.attach("timeout");
    await expect(store.waitFor("timeout", "key", -1, () => true)).rejects.toMatchObject({
      code: "timeout",
    });

    store.attach("abort");
    const controller = new AbortController();
    const aborted = store.waitFor("abort", "key", -1, () => true, {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    const abortedRejection = expect(aborted).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await abortedRejection;

    store.attach("detach");
    const detached = store.waitFor("detach", "key", -1, () => true, { timeoutMs: 1_000 });
    const detachedRejection = expect(detached).rejects.toMatchObject({ code: "detached" });
    store.detach("detach");
    await detachedRejection;

    store.attach("close");
    const closed = store.waitFor("close", "key", -1, () => true, { timeoutMs: 1_000 });
    const closedRejection = expect(closed).rejects.toMatchObject({ code: "closed" });
    await store.close();
    await closedRejection;
  });

  it("enforces waiter and timer limits before allocating work", async () => {
    const { store } = await openedStore(new ControlFeed(), baseline(), { maxWaiters: 1 });
    store.attach("s1");
    const controller = new AbortController();
    const first = store.waitFor("s1", "one", -1, () => true, {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    await expect(
      store.waitFor("s1", "two", -1, () => true, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "resourceLimit" });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    const maxTimerController = new AbortController();
    const maxTimer = store.waitFor("s1", "timer-limit", -1, () => true, {
      signal: maxTimerController.signal,
      timeoutMs: 2_147_483_647,
    });
    maxTimerController.abort();
    await expect(maxTimer).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      store.waitFor("s1", "timer", -1, () => true, { timeoutMs: 2_147_483_648 }),
    ).rejects.toThrow("timeoutMs must be an integer");
    await store.close();
  });

  it("does not leak a waiter when abort fires during listener registration", async () => {
    const { store } = await openedStore(new ControlFeed(), baseline(), { maxWaiters: 1 });
    store.attach("s1");
    const controller = new AbortController();
    const raceSignal = {
      get aborted() {
        return controller.signal.aborted;
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        controller.signal.addEventListener(type, listener, options);
        controller.abort();
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        controller.signal.removeEventListener(type, listener);
      },
    } as AbortSignal;
    const rejection = vi.fn();
    const raced = store
      .waitFor("s1", "raced", -1, () => true, { signal: raceSignal, timeoutMs: 1_000 })
      .catch((error: unknown) => {
        rejection(error);
        throw error;
      });
    await expect(raced).rejects.toMatchObject({ code: "cancelled" });
    expect(rejection).toHaveBeenCalledOnce();

    const nextController = new AbortController();
    const next = store.waitFor("s1", "next", -1, () => true, {
      signal: nextController.signal,
      timeoutMs: 1_000,
    });
    nextController.abort();
    await expect(next).rejects.toMatchObject({ code: "cancelled" });
    await store.close();
  });
});

describe("Modern replacement baselines", () => {
  it("reopens one ended physical generation and replaces only journal-seeded Sessions", async () => {
    const first = new ControlFeed();
    const second = new ControlFeed();
    const source = new ControlGenerations([first, second]);
    const store = new ModernControlStore(source);
    const ready = store.start();
    first.push(baseline());
    await ready;
    store.attach("loaded", { asOfSeq: 1, values: { key: "seeded" } });
    store.attach("reserved");
    first.push(projection("loaded", "key", "live", 2));
    await vi.waitFor(() =>
      expect(store.snapshot("loaded")?.key).toEqual({ value: "live", seq: 2 }),
    );

    first.end();
    await vi.waitFor(() => expect(source.calls).toHaveLength(2));
    second.push(baseline({ loaded: projectionBlock(3, { key: "replacement" }) }));
    await vi.waitFor(() =>
      expect(store.snapshot("loaded")?.key).toEqual({ value: "replacement", seq: 3 }),
    );
    expect(store.snapshot("reserved")).toEqual({});
    expect(store.fault).toBeUndefined();

    second.push(projection("loaded", "key", "after-replacement", 4));
    await vi.waitFor(() =>
      expect(store.snapshot("loaded")?.key).toEqual({ value: "after-replacement", seq: 4 }),
    );
    second.end();
    await expectFault(store, "unavailable");
    expect(source.calls).toHaveLength(2);
    await store.close();
  });

  it("faults atomically when a physical replacement omits a journal-seeded Session", async () => {
    const first = new ControlFeed();
    const second = new ControlFeed();
    const source = new ControlGenerations([first, second]);
    const store = new ModernControlStore(source);
    const ready = store.start();
    first.push(baseline());
    await ready;
    store.attach("first", { asOfSeq: 1, values: { key: "first-1" } });
    store.attach("second", { asOfSeq: 1, values: { key: "second-1" } });

    first.end();
    await vi.waitFor(() => expect(source.calls).toHaveLength(2));
    second.push(
      baseline({
        first: projectionBlock(2, { key: "first-2" }),
      }),
    );
    await expectFault(store, "protocolError");
    expect(store.snapshot("first")?.key).toEqual({ value: "first-1", seq: 1 });
    expect(store.snapshot("second")?.key).toEqual({ value: "second-1", seq: 1 });
    await store.close();
  });

  it("faults when a replacement generation never emits its opening baseline", async () => {
    const first = new ControlFeed();
    const second = new ControlFeed();
    const source = new ControlGenerations([first, second]);
    const store = new ModernControlStore(source, { recoveryOpenTimeoutMs: 10 });
    const ready = store.start();
    first.push(baseline());
    await ready;
    store.attach("loaded", { asOfSeq: 1, values: { key: "seeded" } });
    first.end();
    await vi.waitFor(() => expect(source.calls).toHaveLength(2));

    await expectFault(store, "unavailable");
    expect(store.snapshot("loaded")?.key).toEqual({ value: "seeded", seq: 1 });
    await store.close();
  });

  it("merges higher watermarks without regressing newer rows or caching unloaded Sessions", async () => {
    const { store } = await openedStore();
    store.attach("s1", {
      asOfSeq: 5,
      values: { durable: "old", newer: "keep", omittedNewer: "keep-too" },
    });
    store.replaceBaseline(
      baseline({
        s1: projectionBlock(10, { durable: "replacement", newer: "baseline-stale" }),
        unloaded: projectionBlock(50, { hidden: true }),
      }),
    );
    expect(store.snapshot("s1")).toEqual({
      durable: { value: "replacement", seq: 10 },
      newer: { value: "baseline-stale", seq: 10 },
    });

    // A replacement at the latest committed cut retains the complete same-sequence projection.
    store.attach("s1", {
      asOfSeq: 20,
      values: { durable: "live-20", newer: "live-20", omittedNewer: "live-20" },
    });
    store.replaceBaseline(
      baseline({
        s1: projectionBlock(20, {
          durable: "live-20",
          newer: "live-20",
          omittedNewer: "live-20",
        }),
      }),
    );
    expect(store.snapshot("s1")).toEqual({
      durable: { value: "live-20", seq: 20 },
      newer: { value: "live-20", seq: 20 },
      omittedNewer: { value: "live-20", seq: 20 },
    });
    store.attach("unloaded");
    expect(store.snapshot("unloaded")).toEqual({});
    await store.close();
  });

  it("faults a physical replacement behind a journal-seeded Session watermark", async () => {
    const first = new ControlFeed();
    const second = new ControlFeed();
    const source = new ControlGenerations([first, second]);
    const store = new ModernControlStore(source);
    const ready = store.start();
    first.push(baseline());
    await ready;
    store.attach("s1", { asOfSeq: 10, values: { key: "seeded" } });
    first.push(projection("s1", "key", "live", 20));
    await vi.waitFor(() => expect(store.snapshot("s1")?.key).toEqual({ value: "live", seq: 20 }));

    first.end();
    await vi.waitFor(() => expect(source.calls).toHaveLength(2));
    second.push(baseline({ s1: projectionBlock(15, { key: "stale" }) }));
    await expectFault(store, "protocolError");
    expect(store.snapshot("s1")?.key).toEqual({ value: "live", seq: 20 });
    await store.close();
  });

  it("faults on same-sequence replacement conflicts", async () => {
    const { store } = await openedStore();
    store.attach("s1", { asOfSeq: 5, values: { key: "first" } });
    expect(() =>
      store.replaceBaseline(baseline({ s1: projectionBlock(5, { key: "different" }) })),
    ).toThrow();
    expect(store.fault).toMatchObject({ code: "protocolError" });
    await store.close();
  });

  it("validates a replacement for every loaded Session before committing any row", async () => {
    const { store } = await openedStore();
    store.attach("first", { asOfSeq: 1, values: { key: "first-1" } });
    store.attach("second", { asOfSeq: 2, values: { key: "second-2" } });
    expect(() =>
      store.replaceBaseline(
        baseline({
          first: projectionBlock(3, { key: "first-3" }),
          second: projectionBlock(2, { key: "conflict" }),
        }),
      ),
    ).toThrow();
    expect(store.snapshot("first")?.key).toEqual({ value: "first-1", seq: 1 });
    expect(store.snapshot("second")?.key).toEqual({ value: "second-2", seq: 2 });
    await store.close();
  });

  it("requires every journal-seeded Session in an explicit replacement", async () => {
    const { store } = await openedStore();
    store.attach("first", { asOfSeq: 1, values: { key: "first-1" } });
    store.attach("second", { asOfSeq: 1, values: { key: "second-1" } });
    expect(() =>
      store.replaceBaseline(baseline({ first: projectionBlock(2, { key: "first-2" }) })),
    ).toThrowError(expect.objectContaining({ code: "protocolError" }));
    expect(store.snapshot("first")?.key).toEqual({ value: "first-1", seq: 1 });
    expect(store.snapshot("second")?.key).toEqual({ value: "second-1", seq: 1 });
    await store.close();
  });

  it("commits every Session before publishing replacement notifications", async () => {
    const { store } = await openedStore();
    store.attach("first", { asOfSeq: 1, values: { key: "first-1" } });
    store.attach("second", { asOfSeq: 1, values: { key: "second-1" } });
    const observedSecond = vi.fn(() => store.snapshot("second")?.key);
    store.subscribe("first", "key", observedSecond);

    store.replaceBaseline(
      baseline({
        first: projectionBlock(2, { key: "first-2" }),
        second: projectionBlock(2, { key: "second-2" }),
      }),
    );

    expect(observedSecond).toHaveReturnedWith({ value: "second-2", seq: 2 });
    await store.close();
  });
});

describe("Modern control validation and lifecycle", () => {
  it("preserves typed transport failures from the control stream", async () => {
    for (const code of ["protocolError", "authenticationRequired", "processExited"] as const) {
      const store = new ModernControlStore({
        openStream<T>(): AsyncIterable<T> {
          throw new ModernRemoteConnectionError(code, `typed ${code}`);
        },
      });
      await expect(store.start()).rejects.toMatchObject({ code });
      expect(store.fault).toMatchObject({ code });
      await store.close();
    }
  });

  it("redacts credentials and never retains raw error causes", async () => {
    const secret = "control-store-secret-canary";
    const diagnostic = `Bearer ${secret} ?token=${secret}`;
    expectCredentialSafe(
      new ModernControlStoreError("unavailable", diagnostic, {
        cause: new Error(diagnostic),
      }),
      secret,
    );

    const transportStore = new ModernControlStore({
      openStream<T>(): AsyncIterable<T> {
        throw new Error(diagnostic);
      },
    });
    expectCredentialSafe(await transportStore.start().catch((error: unknown) => error), secret);
    await transportStore.close();

    const { store: parseStore } = await openedStore();
    const values: Record<string, unknown> = {};
    Object.defineProperty(values, "key", {
      enumerable: true,
      get() {
        throw new Error(diagnostic);
      },
    });
    expectCredentialSafe(
      captureThrow(() => parseStore.attach("parse", { asOfSeq: 1, values })),
      secret,
    );
    await parseStore.close();

    const { store: seedStore } = await openedStore();
    const uncloneable = new Proxy<Record<string, unknown>>({}, {});
    expectCredentialSafe(
      captureThrow(() => seedStore.attach("seed", { asOfSeq: 1, values: { key: uncloneable } })),
      secret,
    );
    await seedStore.close();

    const { store: replacementStore } = await openedStore();
    const invalidFrame = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        throw new Error(diagnostic);
      },
    });
    expectCredentialSafe(
      captureThrow(() => replacementStore.replaceBaseline(invalidFrame)),
      secret,
    );
    await replacementStore.close();

    const { feed, store: predicateStore } = await openedStore();
    predicateStore.attach("predicate");
    const waiting = predicateStore.waitFor("predicate", "key", -1, () => {
      throw new Error(diagnostic);
    });
    feed.push(projection("predicate", "key", true, 1));
    expectCredentialSafe(await waiting.catch((error: unknown) => error), secret);
    expectCredentialSafe(
      await predicateStore
        .waitFor("predicate", "key", -1, () => {
          throw new Error(diagnostic);
        })
        .catch((error: unknown) => error),
      secret,
    );
    await predicateStore.close();
  });

  it.each([
    { type: "baseline", value: { queues: {}, jobs: {}, projections: {}, extra: true } },
    baseline({}, { queues: { s1: [{ id: "bad" }] } }),
    baseline({}, { jobs: { s1: [{ id: "bad" }] } }),
    baseline({ s1: projectionBlock(-2, {}) }),
    baseline({ s1: projectionBlock(1, { key: undefined }) }),
  ])("faults on malformed opening frame %#", async (frame) => {
    const feed = new ControlFeed();
    const store = new ModernControlStore(feed);
    const ready = store.start();
    feed.push(frame);
    await expect(ready).rejects.toMatchObject({ code: "protocolError" });
    expect(feed.signal?.aborted).toBe(true);
    await store.close();
  });

  it.each([
    { type: "projection", sessionId: "s1", key: "key", value: Number.NaN, seq: 1 },
    { type: "queue", sessionId: "s1", items: [{ id: "bad" }] },
    { type: "jobs", sessionId: "s1", jobs: [{ id: "bad" }] },
    { type: "unknown" },
  ])("faults on malformed update %#", async (frame) => {
    const { feed, store } = await openedStore();
    feed.push(frame);
    await expectFault(store, "protocolError");
    await store.close();
  });

  it("notifies one isolated fault observer without replacing the authoritative fault", async () => {
    const observed: ModernControlStoreError[] = [];
    const { feed, store } = await openedStore(new ControlFeed(), baseline(), {
      onFault: (error) => {
        observed.push(error);
        throw new Error("observer failure");
      },
    });
    feed.push({ type: "unknown" });
    await expectFault(store, "protocolError");
    feed.end();
    await Promise.resolve();
    expect(observed).toEqual([store.fault]);
    expect(store.fault).toBeInstanceOf(ModernControlStoreError);
    await store.close();
  });

  it("reconciles a journal seed without lowering a live projection watermark", async () => {
    const { feed, store } = await openedStore(new ControlFeed(), baseline());
    const detach = store.attach("session-a");
    feed.push({
      type: "projection",
      sessionId: "session-a",
      key: "model",
      value: "live",
      seq: 5,
    });
    await vi.waitFor(() => {
      expect(store.snapshot("session-a")?.model).toEqual({ value: "live", seq: 5 });
    });
    store.seed("session-a", { asOfSeq: 3, values: { model: "journal" } });
    expect(store.snapshot("session-a")?.model).toEqual({ value: "live", seq: 5 });

    feed.push({
      type: "projection",
      sessionId: "session-a",
      key: "model",
      value: "conflict",
      seq: 5,
    });
    await expectFault(store, "protocolError");
    detach();
    feed.end();
    await store.close();
  });

  it("faults before aggregate Session projections exceed their byte limit", async () => {
    const { feed, store } = await openedStore();
    store.attach("s1");
    feed.push(projection("s1", "first", "x".repeat(3 * 1024 * 1024), 1));
    await vi.waitFor(() => {
      expect(store.snapshot("s1")?.first?.seq).toBe(1);
    });
    feed.push(projection("s1", "second", "y".repeat(2 * 1024 * 1024), 2));
    await expectFault(store, "resourceLimit");
    expect(Object.keys(store.snapshot("s1") ?? {})).toEqual(["first"]);
    expect(store.snapshot("s1")?.first?.value).toHaveLength(3 * 1024 * 1024);
    await store.close();
  });

  it("bounds valid surrogate-pair strings by their JSON byte cost", async () => {
    const { store } = await openedStore();
    expect(
      captureThrow(() =>
        store.attach("emoji", { asOfSeq: 1, values: { text: "😀".repeat(1_100_000) } }),
      ),
    ).toMatchObject({ code: "resourceLimit" });
    await store.close();
  });

  it("faults when the stream ends before or after opening", async () => {
    const before = new ControlFeed();
    const unopened = new ModernControlStore(before);
    const ready = unopened.start();
    before.end();
    await expect(ready).rejects.toMatchObject({ code: "protocolError" });
    await unopened.close();

    const after = new ControlFeed();
    const { store } = await openedStore(after);
    after.end();
    await expectFault(store, "unavailable");
    await store.close();
  });

  it("cancels the physical stream and rejects waiters on close", async () => {
    const feed = new ControlFeed();
    const { store } = await openedStore(feed);
    store.attach("s1");
    const waiting = store.waitFor("s1", "key", -1, () => true, { timeoutMs: 1_000 });
    const rejected = expect(waiting).rejects.toMatchObject({ code: "closed" });
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await closing;
    expect(feed.signal?.aborted).toBe(true);
    expect(feed.returned).toBe(true);
    await rejected;
  });

  it("enforces loaded Session and projection-key limits", async () => {
    const { store } = await openedStore(new ControlFeed(), baseline(), {
      maxSessions: 1,
      maxKeysPerSession: 1,
    });
    store.attach("s1", { asOfSeq: 1, values: { first: true } });
    expect(() => store.attach("s2")).toThrowError(
      expect.objectContaining({ code: "resourceLimit" }),
    );
    expect(() =>
      store.attach("s1", { asOfSeq: 2, values: { first: true, second: true } }),
    ).toThrowError(expect.objectContaining({ code: "resourceLimit" }));
    await store.close();
  });
});
