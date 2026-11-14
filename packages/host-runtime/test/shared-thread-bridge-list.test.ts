import { expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import type { SharedThreadPeer } from "../src/shared-thread-peer.js";

const PAGE = 200;

function fakePeer(total: number) {
  const rows = Array.from({ length: total }, (_, index) => ({ id: `shared-${index}` }));
  const listeners = new Set<(message: JsonObject) => void>();
  const listCalls: JsonObject[] = [];
  let fail = false;
  const peer: SharedThreadPeer = {
    request: async (method, params) => {
      if (method !== "thread/list") return { result: {} };
      listCalls.push(params);
      if (fail) return { error: { code: -1, message: "busy" } };
      const offset = typeof params.cursor === "string" ? Number(params.cursor) : 0;
      const next = offset + PAGE < rows.length ? String(offset + PAGE) : null;
      return { result: { data: rows.slice(offset, offset + PAGE), nextCursor: next } };
    },
    respond: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closed: new Promise(() => undefined),
    close: () => undefined,
  };
  return {
    peer,
    listCalls,
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
  // The first connection announces existing Threads with its own walk.
  expect(await bridge.list({ ...query, cursor: null, limit: 200 })).toHaveLength(1_000);
  shared.listCalls.length = 0;

  for (let page = 0; page < 5; page += 1) {
    const rows = await bridge.list({ ...query, cursor: `client-${page}`, limit: 200 });
    expect(rows).toHaveLength(1_000);
  }
  expect(shared.listCalls).toHaveLength(0);
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
