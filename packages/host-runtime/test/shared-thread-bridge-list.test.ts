import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { SHARED_THREAD_LIST_METHOD, type SharedThreadPeer } from "../src/shared-thread-peer.js";
import {
  SHARED_SECTIONS_CHANGED_METHOD,
  SHARED_SECTIONS_WATCH_METHOD,
} from "../src/external-thread-sections.js";

const PAGE = 200;

function fakePeer(total: number) {
  const rows = Array.from({ length: total }, (_, index) => ({ id: `shared-${index}` }));
  const listeners = new Set<(message: JsonObject) => void>();
  const listCalls: JsonObject[] = [];
  const strictListCalls: JsonObject[] = [];
  const ended = Promise.withResolvers<undefined>();
  let fail = false;
  let acknowledgeComplete = true;
  const peer: SharedThreadPeer = {
    request: async (method, params) => {
      if (method !== "thread/list" && method !== SHARED_THREAD_LIST_METHOD) return { result: {} };
      const strict = method === SHARED_THREAD_LIST_METHOD;
      (strict ? strictListCalls : listCalls).push(params);
      if (fail) return { error: { code: -1, message: "busy" } };
      const offset = typeof params.cursor === "string" ? Number(params.cursor) : 0;
      const next = offset + PAGE < rows.length ? String(offset + PAGE) : null;
      return {
        result: {
          data: rows.slice(offset, offset + PAGE),
          nextCursor: next,
          ...(strict && acknowledgeComplete ? { complete: true } : {}),
        },
      };
    },
    respond: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closed: ended.promise,
    close: () => {
      listeners.clear();
      ended.resolve(undefined);
    },
  };
  return {
    peer,
    listCalls,
    strictListCalls,
    acknowledgeComplete: (value: boolean) => {
      acknowledgeComplete = value;
    },
    notify: (message: JsonObject) => {
      for (const listener of listeners) listener(message);
    },
    failNext: (value: boolean) => {
      fail = value;
    },
  };
}

function bridgeFor(peer: SharedThreadPeer, now: () => number = () => 0) {
  return new SharedThreadBridge({
    connect: async () => peer,
    delegateCreates: true,
    diagnose: () => undefined,
    now,
  });
}

const query = { archived: false, useStateDbOnly: true };

it("serves every page of a client catalog from one shared walk", async () => {
  const shared = fakePeer(1_000);
  const bridge = bridgeFor(shared.peer);
  expect(await bridge.list({ ...query, cursor: null, limit: 200 })).toHaveLength(1_000);
  expect(shared.listCalls).toHaveLength(5);
  shared.listCalls.length = 0;

  for (let page = 0; page < 5; page += 1) {
    const rows = await bridge.list({ ...query, cursor: `client-${page}`, limit: 200 });
    expect(rows).toHaveLength(1_000);
  }
  expect(shared.listCalls).toHaveLength(0);
});

it("reads a large history without publishing it as newly started Threads", async () => {
  const shared = fakePeer(3_000);
  const bridge = bridgeFor(shared.peer);
  const publish = vi.fn();
  bridge.start(publish);
  try {
    expect(await bridge.list(query)).toHaveLength(3_000);
    expect(shared.listCalls).toHaveLength(15);
    expect(publish).not.toHaveBeenCalled();

    const created = {
      method: "thread/started",
      params: { thread: { id: "new-thread", modelProvider: "codexhost" } },
    };
    shared.notify(created);
    expect(publish).toHaveBeenCalledExactlyOnceWith(created);
  } finally {
    bridge.close();
  }
});

it("reads history after late discovery without synthesizing creation events", async () => {
  const shared = fakePeer(1_000);
  let available: SharedThreadPeer | null = null;
  const bridge = new SharedThreadBridge({
    connect: async () => available,
    delegateCreates: true,
    diagnose: () => undefined,
  });
  const publish = vi.fn();
  bridge.start(publish);
  try {
    expect(await bridge.list(query)).toEqual([]);
    available = shared.peer;
    expect(await bridge.list(query)).toHaveLength(1_000);
    expect(publish).not.toHaveBeenCalled();
  } finally {
    bridge.close();
  }
});

it("refreshes history on reconnection and forwards new events once", async () => {
  const first = fakePeer(1_000);
  const second = fakePeer(1_001);
  let available = first.peer;
  const bridge = new SharedThreadBridge({
    connect: async () => available,
    delegateCreates: true,
    diagnose: () => undefined,
  });
  const publish = vi.fn();
  bridge.start(publish);
  try {
    expect(await bridge.list(query)).toHaveLength(1_000);
    first.peer.close();
    await first.peer.closed;
    available = second.peer;
    expect(await bridge.list(query)).toHaveLength(1_001);
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      method: SHARED_SECTIONS_CHANGED_METHOD,
      params: {},
    });
    publish.mockClear();

    const renamed = { method: "thread/name/updated", params: { threadId: "shared-0" } };
    first.notify(renamed);
    second.notify(renamed);
    expect(publish).toHaveBeenCalledExactlyOnceWith(renamed);
  } finally {
    bridge.close();
  }
});

it.each(["transport", "RPC"] as const)(
  "recovers section updates after a %s watch failure without overlapping requests",
  async (failure) => {
    const shared = fakePeer(1);
    const request = shared.peer.request;
    const retry = Promise.withResolvers<JsonObject>();
    let attempts = 0;
    let section = "Research";
    let watching = false;
    shared.peer.request = async (method, params) => {
      if (method === "thread/list")
        return { result: { data: [{ id: "shared-0", section }], nextCursor: null } };
      if (method !== SHARED_SECTIONS_WATCH_METHOD) return request(method, params);
      if (++attempts === 1) {
        if (failure === "transport") throw new Error("Watch timed out");
        return { error: { code: -32000, message: "Owner is busy" } };
      }
      const reply = await retry.promise;
      watching = true;
      return reply;
    };
    const bridge = bridgeFor(shared.peer);
    const publish = vi.fn();
    const changed = { method: SHARED_SECTIONS_CHANGED_METHOD, params: {} };
    vi.useFakeTimers();
    bridge.start(publish);
    try {
      expect(await bridge.list(query)).toEqual([{ id: "shared-0", section: "Research" }]);
      section = "Review";
      expect(await bridge.list(query)).toEqual([{ id: "shared-0", section: "Research" }]);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(attempts).toBe(2);
      retry.resolve({ result: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).toHaveBeenCalledExactlyOnceWith(changed);
      expect(await bridge.list(query)).toEqual([{ id: "shared-0", section: "Review" }]);
      section = "Done";
      if (watching) shared.notify(changed);
      expect(await bridge.list(query)).toEqual([{ id: "shared-0", section: "Done" }]);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(attempts).toBe(2);
    } finally {
      bridge.close();
      vi.useRealTimers();
    }
  },
);

it("does not retry an unsupported section watch on the same peer", async () => {
  const shared = fakePeer(1);
  const request = shared.peer.request;
  const requests = vi.spyOn(shared.peer, "request").mockImplementation(async (method, params) => {
    if (method === SHARED_SECTIONS_WATCH_METHOD)
      return { error: { code: -32601, message: "Method not found" } };
    return request(method, params);
  });
  const bridge = bridgeFor(shared.peer);
  vi.useFakeTimers();
  bridge.start(() => undefined);
  try {
    expect(await bridge.list(query)).toEqual([{ id: "shared-0" }]);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(
      requests.mock.calls.filter(([method]) => method === SHARED_SECTIONS_WATCH_METHOD),
    ).toHaveLength(1);
  } finally {
    bridge.close();
    vi.useRealTimers();
  }
});

it("shares one in-flight walk between concurrent pages", async () => {
  const shared = fakePeer(450);
  const bridge = bridgeFor(shared.peer);
  await bridge.list(query);
  shared.notify({ method: "thread/started", params: {} });
  shared.listCalls.length = 0;

  await Promise.all([bridge.list(query), bridge.list({ ...query, cursor: "x" })]);
  expect(shared.listCalls).toHaveLength(3);
});

it("walks again after a Thread notification, a different query, or the reuse window", async () => {
  let now = 0;
  const shared = fakePeer(250);
  const bridge = bridgeFor(shared.peer, () => now);
  await bridge.list(query);
  shared.listCalls.length = 0;

  shared.notify({ method: "turn/started", params: {} });
  await bridge.list(query);
  expect(shared.listCalls).toHaveLength(0);

  shared.notify({ method: "thread/name/updated", params: {} });
  await bridge.list(query);
  expect(shared.listCalls).toHaveLength(2);

  await bridge.list({ ...query, archived: true });
  expect(shared.listCalls).toHaveLength(4);

  now = 5_000;
  await bridge.list(query);
  expect(shared.listCalls).toHaveLength(6);
});

it("does not keep a failed walk", async () => {
  const shared = fakePeer(10);
  const bridge = bridgeFor(shared.peer);
  await bridge.list(query);
  shared.notify({ method: "thread/started", params: {} });
  shared.failNext(true);
  expect(await bridge.list(query)).toEqual([]);
  shared.failNext(false);
  expect(await bridge.list(query)).toHaveLength(10);
});

it("never uses a best-effort walk as proof of completeness", async () => {
  const shared = fakePeer(250);
  const bridge = bridgeFor(shared.peer);
  const strict = { requireComplete: true };
  expect(await bridge.list(query)).toHaveLength(250);

  shared.acknowledgeComplete(false);
  await expect(bridge.list(query, strict)).rejects.toThrow("did not confirm complete Thread list");
  expect(shared.listCalls).toHaveLength(2);
  expect(shared.strictListCalls).toHaveLength(1);
  expect(await bridge.list(query)).toHaveLength(250);

  shared.acknowledgeComplete(true);
  expect(await bridge.list(query, strict)).toHaveLength(250);
  expect(shared.strictListCalls.map(({ cursor }) => cursor)).toEqual([null, null, "200"]);
  expect(await bridge.list({ ...query, cursor: "upstream-next" }, strict)).toHaveLength(250);
  expect(shared.strictListCalls).toHaveLength(3);

  shared.failNext(true);
  await expect(bridge.list(query, strict)).rejects.toThrow("Shared Thread list failed");
  expect(await bridge.list(query)).toHaveLength(250);
});

it("walks again after a routed section move, which has no Thread notification", async () => {
  const threadId = "01984de2-8f74-7c91-a3b2-5c5e937cf319";
  const pinned = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
  let section: string | null = null;
  const ended = Promise.withResolvers<undefined>();
  const peer: SharedThreadPeer = {
    request: async (method, params) => {
      if (method === "codexhost/thread/ownership/list")
        return {
          result: { threads: [{ threadId, owner: "external", harnessId: "pi" }] },
        };
      if (method === "thread/section/move") {
        section = typeof params.sectionId === "string" ? params.sectionId : null;
        return { result: {} };
      }
      if (method === "thread/list") {
        const listed = params.sectionId === undefined || params.sectionId === section;
        return { result: { data: listed ? [{ id: threadId }] : [], nextCursor: null } };
      }
      return { result: {} };
    },
    respond: async () => undefined,
    subscribe: () => () => undefined,
    closed: ended.promise,
    close: () => ended.resolve(undefined),
  };
  const bridge = bridgeFor(peer);
  const pinnedList = { sectionId: pinned, sortKey: "section_position" };
  expect(await bridge.list(pinnedList)).toEqual([]);
  expect(
    await bridge.route({
      id: 1,
      method: "thread/section/move",
      params: { threadId, sectionId: pinned, beforeThreadId: null },
    }),
  ).toEqual({ id: 1, result: {} });
  expect(await bridge.list(pinnedList)).toEqual([{ id: threadId }]);
});
