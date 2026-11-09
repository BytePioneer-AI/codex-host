import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { forkChThread } from "../src/ch-thread-fork.ts";
import type { WireEvent } from "../src/session-log.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { defined } from "./support/defined.ts";
import { nativeCodex } from "./support/native-codex.ts";

function fixture(t: TestContext, count = 12, native = false) {
  const root = mkdtempSync(join(tmpdir(), "ch-fork-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = native ? nativeCodex(new FakeChHost()) : new FakeChHost();
  host.inspection.capabilities.history.fork = true;
  const source = host.add(native ? "native-source" : "source", join(root, "not-created"));
  if (native) source.modelProvider = "custom-provider";
  const initial = defined(source.turns[0]);
  source.turns = Array.from({ length: count }, (_, i) => ({ ...initial, id: `native-${i}` }));
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const call = async <T>(method: string, request: object = {}): Promise<T> => {
    const result = await rpc.dispatch(method, { args: { request } });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  const fork = (request: object = { sessionId: source.id }) =>
    rpc.dispatch("session/fork", { args: { request } });
  return { root, host, source, call, fork };
}

it("forks the latest completed CH Turn in the same cwd and publishes the canonical child", async (t) => {
  const { root, host, source, call } = fixture(t);
  const original = structuredClone(source);
  const child = await call<{ sessionId: string }>("session/fork", { sessionId: "source" });
  assert.equal(child.sessionId, "fork-1");
  assert.deepEqual(host.requests.find((r) => r.method === "codexhost/thread/fork")?.params, {
    threadId: "source",
    lastTurnId: "native-11",
  });
  assert.deepEqual(source, original);
  assert.equal(host.threads.get(child.sessionId)?.cwd, source.cwd);
  const list = await call<{ items: Array<{ sessionId: string }> }>("session/list");
  assert.ok(list.items.some((row) => row.sessionId === child.sessionId));
  assert.equal(existsSync(defined(source.cwd)), false);
  assert.deepEqual(readdirSync(root), ["workspaces.json"]);
  assert.equal(
    host.requests.some((r) => r.method === "thread/start"),
    false,
  );
});

it("maps exact and prepended Web boundaries to native IDs without retargeting as the source grows", async (t) => {
  const { host, source, call } = fixture(t);
  const page = (beforeSeq?: number) =>
    call<{ records: Array<{ event: WireEvent }> }>("session/page", {
      address: { sessionId: "source" },
      throughSeq: Number.MAX_SAFE_INTEGER,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: 1000,
    });
  const tail = await page();
  const tailEnd = defined(tail.records.filter((r) => r.event.type === "turn/end")[1]).event.seq;
  const older = await page(defined(tail.records[0]).event.seq);
  const oldEnd = defined(older.records.find((r) => r.event.type === "turn/end")).event.seq;
  source.turns.push({ ...defined(source.turns[0]), id: "later-native" });
  source.updatedAt++;
  await call("session/fork", { sessionId: "source", atSeq: oldEnd });
  await call("session/fork", { sessionId: "source", atSeq: tailEnd });
  assert.deepEqual(
    host.requests.filter((r) => r.method === "codexhost/thread/fork").map((r) => r.params),
    [
      { threadId: "source", lastTurnId: "native-2" },
      { threadId: "source", lastTurnId: "native-8" },
    ],
  );
  assert.equal(host.threads.get("fork-1")?.turns.length, 3);
  assert.equal(host.threads.get("fork-2")?.turns.length, 9);
});

it("rejects stale, non-terminal, invalid and unsupported cuts without creating a child", async (t) => {
  const { host, call, fork } = fixture(t);
  assert.equal((await fork({ sessionId: "source", atSeq: 2 ** 40 })).ok, false);
  const page = await call<{ records: Array<{ event: WireEvent }> }>("session/page", {
    address: { sessionId: "source" },
    throughSeq: Number.MAX_SAFE_INTEGER,
  });
  const start = defined(page.records.find((r) => r.event.type === "turn/start")).event.seq;
  for (const atSeq of [start, -1, 0.5, Number.MAX_SAFE_INTEGER, "bad", null])
    assert.equal((await fork({ sessionId: "source", atSeq })).ok, false);
  host.inspection.capabilities.history.fork = false;
  const unsupported = await fork();
  assert.ok(!unsupported.ok);
  assert.equal(unsupported.error.code, "session/fork-unavailable");
  assert.equal(
    host.requests.some((r) => r.method === "codexhost/thread/fork"),
    false,
  );
});

it("rejects unsent drafts and empty or active-only histories", async (t) => {
  const { host, source, call, fork } = fixture(t, 0);
  const draft = await call<{ sessionId: string }>("session/create", { cwd: source.cwd });
  assert.equal((await fork({ sessionId: draft.sessionId })).ok, false);
  assert.equal((await fork()).ok, false);
  source.turns = [{ id: "active", status: "inProgress", items: [] }];
  source.status.type = "active";
  assert.equal((await fork()).ok, false);
  assert.equal(
    host.requests.some((r) => r.method === "codexhost/thread/fork"),
    false,
  );
});

it("does not retry a rejected/unknown native fork or hide its reason", async (t) => {
  const { host, fork } = fixture(t);
  host.forkError = "Connection lost; fork outcome unknown";
  const result = await fork();
  assert.ok(!result.ok);
  assert.match(result.error.message, /fork outcome unknown/);
  assert.equal(host.requests.filter((r) => r.method === "codexhost/thread/fork").length, 1);
});

it("returns a confirmed fork even when the subsequent catalog refresh fails", async (t) => {
  const { host, call } = fixture(t);
  await call("session/list");
  const request = host.request.bind(host);
  let created = false;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (created && method === "codexhost/thread/catalog/read")
      throw new Error("Catalog unavailable");
    const result = await request<T>(method, params);
    if (method === "codexhost/thread/fork") created = true;
    return result;
  };
  assert.deepEqual(await call("session/fork", { sessionId: "source" }), { sessionId: "fork-1" });
  assert.equal(host.requests.filter((r) => r.method === "codexhost/thread/fork").length, 1);
});

it("forks native Codex at the latest or paginated exact boundary and continues the child", async (t) => {
  const { root, host, source, call } = fixture(t, 12, true);
  const latest = await call<{ sessionId: string }>("session/fork", { sessionId: source.id });
  assert.equal(latest.sessionId, "native-fork-1");
  const page = (beforeSeq?: number) =>
    call<{ records: Array<{ event: WireEvent }> }>("session/page", {
      address: { sessionId: source.id },
      throughSeq: Number.MAX_SAFE_INTEGER,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: 1000,
    });
  const tail = await page();
  const tailEnd = defined(tail.records.filter((r) => r.event.type === "turn/end")[1]).event.seq;
  const older = await page(defined(tail.records[0]).event.seq);
  const oldEnd = defined(older.records.find((r) => r.event.type === "turn/end")).event.seq;
  source.turns.push({ id: "later-active-turn", status: "inProgress", items: [] });
  source.status.type = "active";
  source.updatedAt++;
  const original = structuredClone(source);
  const child = await call<{ sessionId: string }>("session/fork", {
    sessionId: source.id,
    atSeq: oldEnd,
  });
  await call("session/fork", { sessionId: source.id, atSeq: tailEnd });
  assert.deepEqual(
    host.requests.filter((r) => r.method === "thread/fork").map((r) => r.params),
    ["native-11", "native-2", "native-8"].map((lastTurnId) => ({
      threadId: source.id,
      lastTurnId,
      excludeTurns: true,
    })),
  );
  assert.equal(host.threads.get(child.sessionId)?.turns.length, 3);
  assert.equal(host.threads.get("native-fork-3")?.turns.length, 9);
  assert.equal(host.threads.get(child.sessionId)?.cwd, source.cwd);
  const list = await call<{ items: Array<{ sessionId: string }> }>("session/list");
  assert.ok(list.items.some((row) => row.sessionId === child.sessionId));
  await call("session/prompt", {
    sessionId: child.sessionId,
    content: [{ type: "text", text: "continue the fork" }],
  });
  assert.equal(
    host.requests.findLast((r) => r.method === "turn/start")?.params.threadId,
    child.sessionId,
  );
  assert.deepEqual(source, original);
  assert.equal(
    host.requests.some((r) => r.method === "codexhost/thread/fork" || r.method === "thread/start"),
    false,
  );
  assert.equal(existsSync(source.cwd), false);
  assert.deepEqual(readdirSync(root), ["workspaces.json"]);
});

it("supports read-only Desktop inspection but honors an explicit native fork capability refusal", async (t) => {
  const { host, source, call, fork } = fixture(t, 1, true);
  const request = host.request.bind(host);
  let supported = true;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/thread/inspect")
      return {
        owner: "codex",
        locked: true,
        ...(supported
          ? {}
          : { history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false } }),
      } as T;
    return request<T>(method, params);
  };
  assert.deepEqual(await call("session/fork", { sessionId: source.id }), {
    sessionId: "native-fork-1",
  });
  supported = false;
  const result = await fork();
  assert.ok(!result.ok);
  assert.equal(result.error.code, "session/fork-unavailable");
  assert.equal(host.requests.filter((r) => r.method === "thread/fork").length, 1);
});

it("does not retry an unknown native Codex fork outcome or fall back to an external fork", async (t) => {
  const { host, fork } = fixture(t, 1, true);
  host.forkError = "Connection lost; fork outcome unknown";
  const result = await fork();
  assert.ok(!result.ok);
  assert.match(result.error.message, /fork outcome unknown/);
  assert.equal(host.requests.filter((r) => r.method === "thread/fork").length, 1);
  assert.equal(
    host.requests.some((r) => r.method === "codexhost/thread/fork"),
    false,
  );
});

it("returns a confirmed native Codex fork even when catalog refresh fails", async (t) => {
  const { host, source, call } = fixture(t, 1, true);
  await call("session/list");
  const request = host.request.bind(host);
  let created = false;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (created && method === "codexhost/thread/catalog/read")
      throw new Error("Catalog unavailable");
    const result = await request<T>(method, params);
    if (method === "thread/fork") created = true;
    return result;
  };
  assert.deepEqual(await call("session/fork", { sessionId: source.id }), {
    sessionId: "native-fork-1",
  });
  assert.equal(host.requests.filter((r) => r.method === "thread/fork").length, 1);
});

it("does not report a native Codex fork as confirmed without a distinct child ID", async (t) => {
  const { host, source, fork } = fixture(t, 1, true);
  const request = host.request.bind(host);
  for (const id of [undefined, "", "  ", 7, source.id]) {
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "thread/fork") return { thread: { id } } as T;
      return request<T>(method, params);
    };
    const result = await fork();
    assert.ok(!result.ok);
    assert.equal(result.error.code, "session/fork-unconfirmed");
    assert.match(result.error.message, /Do not retry automatically/);
  }
  assert.equal(host.threads.size, 1);
});

it("rejects a retired rendering window rather than forking a stale coordinate", async () => {
  const host = new FakeChHost();
  host.inspection.capabilities.history.fork = true;
  const source = host.add("source", "/project");
  const view = new ChThreadHistory(host, source, "fake", () => {});
  await view.refresh();
  const seq = defined(view.log.events.find((e) => e.type === "turn/end")).seq;
  view.retire();
  await assert.rejects(forkChThread(host, view, seq), /superseded/);
  assert.equal(
    host.requests.some((r) => r.method === "codexhost/thread/fork"),
    false,
  );
});
