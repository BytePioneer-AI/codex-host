import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { THREAD_ARCHIVE_CONFIRM_METHOD } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import {
  EventHub,
  RpcError,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
} from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { FakeChChannel } from "./support/ch-channel.ts";
import { nativeCodex } from "./support/native-codex.ts";

function setup(t: TestContext, host = new FakeChHost()) {
  const root = mkdtempSync(join(tmpdir(), "ch-archives-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  data.writeJson("workspaces.json", {
    items: [],
    archivedSessionIds: ["legacy", "active"],
    pinnedSessionIds: [],
  });
  host.add("active", root);
  host.add("archived", root);
  host.add("official", root).modelProvider = "openai";
  host.archivedIds.add("archived");
  host.archivedIds.add("official");
  const workspaces = new Workspaces(data, root, true);
  const events = new EventHub(root);
  const sessions = new ChSessions(host, workspaces, events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  let follow: StreamHandler | undefined;
  const register = streams.register.bind(streams);
  streams.register = (name, handler) => {
    if (name === "workspace/follow") follow = handler;
    register(name, handler);
  };
  workspaces.register(rpc, streams);
  sessions.register(rpc, streams);
  const frames: Array<{
    type: string;
    archivedSessionIds?: string[];
    value?: { archivedSessionIds: string[] };
  }> = [];
  const observe = async () => {
    assert.ok(follow);
    await follow(
      {},
      {
        id: "archives",
        closed: false,
        push: (frame) => frames.push(frame as (typeof frames)[number]),
        end() {},
        fail() {},
        onClose() {},
      },
    );
  };
  const call = async (method: string, request?: Record<string, unknown>) => {
    const result = await rpc.dispatch(method, { args: request ? { request } : {} });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value;
  };
  return { root, data, host, rpc, workspaces, frames, observe, call, sessions, events };
}

function archiveError(id: string): RpcError {
  return new RpcError("host/rejected", `no rollout found for thread id ${id}`, {
    hostCode: -32600,
  });
}

function assertArchiveError(result: unknown, id: string): void {
  const error = archiveError(id);
  assert.deepEqual(result, {
    ok: false,
    error: { code: error.code, message: error.message, details: error.details },
  });
}

function assertNoArchiveBroadcast(
  frames: ReadonlyArray<{ archivedSessionIds?: string[] }>,
  id: string,
): void {
  assert.ok(
    frames.every((frame) => !frame.archivedSessionIds?.includes(id)),
    "a stale completion must never broadcast archived membership",
  );
}

async function pendingArchive(t: TestContext) {
  const host = nativeCodex(new FakeChChannel());
  const bench = setup(t, host);
  const id = "native-race";
  host.add(id, bench.root).modelProvider = "openai";
  await bench.call("session/list");
  await bench.observe();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<{ confirmed: boolean }>();
  t.after(() => release.resolve({ confirmed: false }));
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/archive" && params.threadId === id) throw archiveError(id);
    if (method === THREAD_ARCHIVE_CONFIRM_METHOD) {
      entered.resolve(undefined);
      return (await release.promise) as T;
    }
    return request<T>(method, params);
  };
  const write = bench.rpc.dispatch("workspace/archiveSession", {
    args: { request: { sessionId: id } },
  });
  await entered.promise;
  return { ...bench, host, id, write, release };
}

it("projects Host archive membership, ignores legacy shared flags and broadcasts GUI changes", async (t) => {
  const bench = setup(t);
  await bench.observe();
  assert.deepEqual(bench.frames.at(-1)?.value?.archivedSessionIds, []);
  const list = (await bench.call("session/list")) as { items: Array<{ sessionId: string }> };
  assert.deepEqual(
    list.items.map((row) => row.sessionId),
    ["active"],
  );
  assert.deepEqual(bench.workspaces.archivedSessionIds(), ["archived"]);
  assert.equal(bench.workspaces.isArchived("active"), false);
  assert.deepEqual(bench.frames.at(-1), { type: "archived", archivedSessionIds: ["archived"] });
  const count = bench.frames.length;
  await bench.call("session/list");
  assert.equal(bench.frames.length, count, "unchanged archives do not rebroadcast");

  bench.host.archivedIds.delete("archived");
  bench.host.archivedIds.add("active");
  await bench.call("session/list");
  assert.deepEqual(bench.frames.at(-1), { type: "archived", archivedSessionIds: ["active"] });
  await bench.observe();
  assert.deepEqual(bench.frames.at(-1)?.value?.archivedSessionIds, ["active"]);
  assert.deepEqual(
    bench.data.readJson<{ archivedSessionIds: string[] }>("workspaces.json", {
      archivedSessionIds: [],
    }).archivedSessionIds,
    ["legacy", "active"],
    "shared archive projection does not overwrite the legacy file",
  );
});

it("loads archives only on explicit requests and preserves their rows when another browser hides them", async (t) => {
  const bench = setup(t);
  const removed: unknown[] = [];
  bench.events.emit = (event, id) => {
    if (event === "api-session/removed") removed.push(id);
  };
  const list = async (includeArchived = false) =>
    (await bench.call("session/list", { includeArchived })) as {
      items: Array<{ sessionId: string }>;
    };
  assert.deepEqual(
    (await list()).items.map((row) => row.sessionId),
    ["active"],
  );
  assert.deepEqual((await list(true)).items.map((row) => row.sessionId).sort(), [
    "active",
    "archived",
  ]);
  assert.deepEqual(
    (await list()).items.map((row) => row.sessionId),
    ["active"],
  );
  assert.deepEqual(removed, []);
  assert.equal(bench.sessions["rows"].has("archived"), true);
  assert.deepEqual(
    bench.host.requests
      .filter((r) => r.method === "codexhost/thread/catalog/read")
      .map((r) => r.params.includeArchived),
    [false, true, false],
  );
  assert.ok(
    !bench.host.requests.some(
      (r) => r.method === "thread/list" || r.method === "codexhost/thread/ownership/list",
    ),
  );
});

it("routes Web workspace and session archive actions to the same Host without stopping work", async (t) => {
  const bench = setup(t);
  await bench.call("session/list");
  const active = bench.host.threads.get("active");
  assert.ok(active);
  active.status = { type: "active" };
  const before = readFileSync(bench.data.path("workspaces.json"));
  assert.deepEqual(
    await bench.call("workspace/archiveSession", { sessionId: "active", stopActivity: true }),
    { archivedSessionIds: ["active", "archived"] },
  );
  assert.equal(bench.host.archivedIds.has("active"), true);
  assert.equal(bench.host.threads.get("active")?.status.type, "active");
  assert.equal(
    bench.host.requests.some((r) => r.method === "turn/interrupt"),
    false,
  );
  assert.deepEqual(await bench.call("workspace/unarchiveSession", { sessionId: "active" }), {
    archivedSessionIds: ["archived"],
  });
  await bench.call("session/archive", { sessionId: "active" });
  assert.equal(bench.workspaces.isArchived("active"), true);
  await bench.call("session/unarchive", { sessionId: "active" });
  assert.equal(bench.workspaces.isArchived("active"), false);
  assert.deepEqual(readFileSync(bench.data.path("workspaces.json")), before);

  const writes = () =>
    bench.host.requests.filter(
      (r) => r.method === "thread/archive" || r.method === "thread/unarchive",
    ).length;
  const count = writes();
  const draft = (await bench.call("session/create", { cwd: bench.root })) as { sessionId: string };
  for (const sessionId of ["official", "missing", draft.sessionId])
    assert.equal(
      (
        await bench.rpc.dispatch("workspace/archiveSession", {
          args: { request: { sessionId } },
        })
      ).ok,
      false,
    );
  assert.equal(writes(), count);
  assert.equal(
    bench.host.requests.some((r) => r.method === "thread/start"),
    false,
  );
});

it("retains the confirmed archive set on failed reads/writes and never replays an acknowledged mutation", async (t) => {
  const bench = setup(t);
  await bench.call("session/list");
  const original = bench.host.request.bind(bench.host);
  let failRead = false;
  let failWrite = true;
  let writes = 0;
  bench.host.request = async (method, params) => {
    if (method === "codexhost/thread/catalog/read" && failRead)
      throw new RpcError("host/offline", "offline read");
    if (method === "thread/archive") {
      writes++;
      if (failWrite) throw new RpcError("host/offline", "offline write");
      failRead = true;
    }
    return original(method, params);
  };
  assert.equal(
    (
      await bench.rpc.dispatch("workspace/archiveSession", {
        args: { request: { sessionId: "active" } },
      })
    ).ok,
    false,
  );
  assert.deepEqual(bench.workspaces.archivedSessionIds(), ["archived"]);
  failWrite = false;
  const before = writes;
  await bench.call("workspace/archiveSession", { sessionId: "active" });
  assert.equal(writes, before + 1);
  assert.equal(bench.host.archivedIds.has("active"), true);
  assert.deepEqual(bench.workspaces.archivedSessionIds(), ["active", "archived"]);
  assert.equal((await bench.rpc.dispatch("session/list", { args: {} })).ok, false);
  assert.deepEqual(bench.workspaces.archivedSessionIds(), ["active", "archived"]);
  failRead = false;
  await bench.call("session/list");
  assert.deepEqual(bench.workspaces.archivedSessionIds(), ["active", "archived"]);
  assert.equal(writes, before + 1);
});

it("converges Web archive state when native archive rejects an already-archived Thread", async (t) => {
  const host = nativeCodex(new FakeChHost());
  const bench = setup(t, host);
  const id = "native-already-archived";
  host.add(id, bench.root).modelProvider = "openai";
  host.archivedIds.add(id);
  await bench.call("session/list");
  assert.equal(bench.workspaces.isArchived(id), false);
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/archive" && params.threadId === id) {
      host.requests.push({ method, params: structuredClone(params) });
      throw new RpcError("host/rejected", `no rollout found for thread id ${id}`, {
        hostCode: -32600,
      });
    }
    return request<T>(method, params);
  };
  assert.deepEqual(await bench.call("workspace/archiveSession", { sessionId: id }), {
    archivedSessionIds: ["archived", id],
  });
  assert.equal(bench.workspaces.isArchived(id), true);
  assert.equal(host.requests.filter((r) => r.method === "thread/archive").length, 1);
  assert.deepEqual(
    host.requests.filter((r) => r.method === THREAD_ARCHIVE_CONFIRM_METHOD),
    [{ method: THREAD_ARCHIVE_CONFIRM_METHOD, params: { threadId: id } }],
  );
  assert.ok(
    host.requests
      .filter((r) => r.method === "codexhost/thread/catalog/read")
      .every((r) => r.params.includeArchived === false),
  );
});

it("confirms archive membership without consulting mixed catalog pages", async (t) => {
  const host = nativeCodex(new FakeChHost());
  const bench = setup(t, host);
  const id = "native-confirmed";
  host.add(id, bench.root).modelProvider = "openai";
  await bench.call("session/list");
  await bench.observe();
  host.archivedIds.add(id);
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/archive" && params.threadId === id)
      throw new RpcError("host/rejected", `no rollout found for thread id ${id}`, {
        hostCode: -32600,
      });
    if (method === THREAD_ARCHIVE_CONFIRM_METHOD) {
      host.requests.push({ method, params: structuredClone(params) });
      return { confirmed: true } as T;
    }
    return request<T>(method, params);
  };
  assert.deepEqual(await bench.call("workspace/archiveSession", { sessionId: id }), {
    archivedSessionIds: ["archived", id],
  });
  assert.equal(bench.workspaces.isArchived(id), true);
  assert.deepEqual(bench.frames.at(-1), {
    type: "archived",
    archivedSessionIds: ["archived", id],
  });
  assert.deepEqual(
    host.requests.filter((r) => r.method === THREAD_ARCHIVE_CONFIRM_METHOD),
    [{ method: THREAD_ARCHIVE_CONFIRM_METHOD, params: { threadId: id } }],
  );
  assert.ok(
    host.requests
      .filter((r) => r.method === "codexhost/thread/catalog/read")
      .every((r) => r.params.includeArchived === false),
  );
});

for (const reply of ["false", "malformed", "extra-field", "failed"] as const) {
  it(`preserves the native archive error when confirmation is ${reply}`, async (t) => {
    const host = nativeCodex(new FakeChHost());
    const bench = setup(t, host);
    const id = "native-unconfirmed";
    host.add(id, bench.root).modelProvider = "openai";
    await bench.call("session/list");
    await bench.observe();
    const request = host.request.bind(host);
    let confirmations = 0;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "thread/archive" && params.threadId === id) throw archiveError(id);
      if (method === THREAD_ARCHIVE_CONFIRM_METHOD) {
        confirmations++;
        if (reply === "failed") throw new RpcError("host/offline", "confirmation unavailable");
        return (
          reply === "false"
            ? { confirmed: false }
            : reply === "malformed"
              ? { confirmed: "true" }
              : { confirmed: true, unexpected: true }
        ) as T;
      }
      return request<T>(method, params);
    };
    assertArchiveError(
      await bench.rpc.dispatch("workspace/archiveSession", {
        args: { request: { sessionId: id } },
      }),
      id,
    );
    assert.equal(confirmations, 1);
    assert.equal(bench.workspaces.isArchived(id), false);
    assertNoArchiveBroadcast(bench.frames, id);
    assert.equal(bench.sessions["archiveOperations"].size, 0);
  });
}

for (const gate of [
  "external",
  "host-code",
  "rpc-code",
  "other-thread",
  "prefix",
  "suffix",
  "plain-error",
  "unarchive",
] as const) {
  it(`does not confirm an archive rejection outside the native gate: ${gate}`, async (t) => {
    const host = nativeCodex(new FakeChHost());
    const bench = setup(t, host);
    const id = gate === "external" ? "active" : "native-gated";
    if (id !== "active") host.add(id, bench.root).modelProvider = "openai";
    await bench.call("session/list");
    await bench.observe();
    const message = `no rollout found for thread id ${id}`;
    const error =
      gate === "plain-error"
        ? new Error(message)
        : new RpcError(
            gate === "rpc-code" ? "host/offline" : "host/rejected",
            gate === "other-thread"
              ? `${message}-other`
              : gate === "prefix"
                ? `unrelated: ${message}`
                : gate === "suffix"
                  ? `${message}; unrelated error`
                  : message,
            { hostCode: gate === "host-code" ? -32000 : -32600 },
          );
    const request = host.request.bind(host);
    let confirmations = 0;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === (gate === "unarchive" ? "thread/unarchive" : "thread/archive")) throw error;
      if (method === THREAD_ARCHIVE_CONFIRM_METHOD) {
        confirmations++;
        return { confirmed: true } as T;
      }
      return request<T>(method, params);
    };
    const result = await bench.rpc.dispatch(
      gate === "unarchive" ? "workspace/unarchiveSession" : "workspace/archiveSession",
      { args: { request: { sessionId: id } } },
    );
    assert.equal(result.ok, false);
    if (error instanceof RpcError)
      assert.deepEqual(result, {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
    assert.equal(confirmations, 0);
    assert.equal(bench.workspaces.isArchived(id), false);
    assertNoArchiveBroadcast(bench.frames, id);
    assert.equal(bench.sessions["archiveOperations"].size, 0);
  });
}

it("does not treat an unconfirmed read as affirmative unarchived membership", async (t) => {
  const host = nativeCodex(new FakeChHost());
  const bench = setup(t, host);
  const id = "native-known-archive";
  host.add(id, bench.root).modelProvider = "openai";
  host.archivedIds.add(id);
  await bench.call("session/list", { includeArchived: true });
  await bench.observe();
  assert.equal(bench.workspaces.isArchived(id), true);
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/archive") throw archiveError(id);
    if (method === THREAD_ARCHIVE_CONFIRM_METHOD) return { confirmed: false } as T;
    return request<T>(method, params);
  };
  assertArchiveError(
    await bench.rpc.dispatch("workspace/archiveSession", {
      args: { request: { sessionId: id } },
    }),
    id,
  );
  assert.equal(bench.workspaces.isArchived(id), true);
  assert.deepEqual(bench.frames.at(-1)?.value?.archivedSessionIds, ["archived", id]);
});

it("rejects a delayed confirmation after a newer unarchive notification", async (t) => {
  const bench = await pendingArchive(t);
  bench.host.changed(bench.id, "thread/unarchived");
  bench.release.resolve({ confirmed: true });
  assertArchiveError(await bench.write, bench.id);
  const list = (await bench.call("session/list")) as { items: Array<{ sessionId: string }> };
  assert.ok(list.items.some((row) => row.sessionId === bench.id));
  assert.equal(bench.workspaces.isArchived(bench.id), false);
  assertNoArchiveBroadcast(bench.frames, bench.id);
  assert.equal(bench.sessions["archiveOperations"].size, 0);
});

it("keeps an unarchive notification through an in-flight refresh archiveChanges merge", async (t) => {
  const bench = await pendingArchive(t);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  const projects = bench.host.projects.bind(bench.host);
  let held = false;
  bench.host.projects = async () => {
    if (!held) {
      held = true;
      entered.resolve(undefined);
      await release.promise;
    }
    return projects();
  };
  const poll = bench.call("session/list");
  await entered.promise;
  bench.host.changed(bench.id, "thread/unarchived");
  assert.equal(bench.sessions["refreshingArchiveChanges"]?.get(bench.id), false);
  bench.release.resolve({ confirmed: true });
  release.resolve(undefined);
  await poll;
  assertArchiveError(await bench.write, bench.id);
  assert.equal(bench.workspaces.isArchived(bench.id), false);
  assertNoArchiveBroadcast(bench.frames, bench.id);
});

it("invalidates confirmation at public unarchive entry before its tree read completes", async (t) => {
  const bench = await pendingArchive(t);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  const request = bench.host.request.bind(bench.host);
  let held = false;
  bench.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/thread/tree/read" && !held) {
      held = true;
      entered.resolve(undefined);
      await release.promise;
    }
    return request<T>(method, params);
  };
  const unarchive = bench.call("workspace/unarchiveSession", { sessionId: bench.id });
  await entered.promise;
  bench.release.resolve({ confirmed: true });
  assertArchiveError(await bench.write, bench.id);
  assert.equal(bench.workspaces.isArchived(bench.id), false);
  assertNoArchiveBroadcast(bench.frames, bench.id);
  release.resolve(undefined);
  await unarchive;
  assert.equal(bench.workspaces.isArchived(bench.id), false);
  assertNoArchiveBroadcast(bench.frames, bench.id);
});

for (const invalidation of ["offline", "reset", "epoch"] as const) {
  it(`preserves the archive failure after connection ${invalidation}`, async (t) => {
    const bench = await pendingArchive(t);
    if (invalidation === "offline") bench.host.connection(false);
    else
      for (const listener of bench.host.listeners)
        listener({
          type: "hello",
          version: 1,
          cursor: {
            epoch: invalidation === "epoch" ? `${bench.host.epoch}-new` : bench.host.epoch,
            sequence: bench.host.sequence,
          },
          reset: invalidation === "reset",
        });
    bench.release.resolve({ confirmed: true });
    assertArchiveError(await bench.write, bench.id);
    assert.equal(bench.workspaces.isArchived(bench.id), false);
    assertNoArchiveBroadcast(bench.frames, bench.id);
    assert.equal(bench.sessions["archiveOperations"].size, 0);
  });
}

for (const archived of [true, false]) {
  it(`does not project an older acknowledged ${archived ? "archive" : "unarchive"} over a newer opposite operation`, async (t) => {
    const host = nativeCodex(new FakeChHost());
    const bench = setup(t, host);
    const id = "native-success-race";
    host.add(id, bench.root).modelProvider = "openai";
    if (!archived) host.archivedIds.add(id);
    await bench.call("session/list", { includeArchived: true });
    await bench.observe();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    t.after(() => release.resolve(undefined));
    const request = host.request.bind(host);
    const oldMethod = archived ? "thread/archive" : "thread/unarchive";
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const result = await request<T>(method, params);
      if (method === oldMethod) {
        entered.resolve(undefined);
        await release.promise;
      }
      return result;
    };
    const oldWrite = bench.call(archived ? "session/archive" : "session/unarchive", {
      sessionId: id,
    });
    await entered.promise;
    await bench.call(archived ? "session/unarchive" : "session/archive", { sessionId: id });
    const count = bench.frames.length;
    assert.equal(bench.workspaces.isArchived(id), !archived);
    release.resolve(undefined);
    await oldWrite;
    assert.equal(bench.workspaces.isArchived(id), !archived);
    assert.equal(bench.frames.length, count, "an older acknowledgement must not rebroadcast");
    assert.equal(bench.sessions["archiveOperations"].size, 0);
  });

  it(`does not send an obsolete ${archived ? "archive" : "unarchive"} after a delayed owner response`, async (t) => {
    const host = nativeCodex(new FakeChHost());
    const bench = setup(t, host);
    const id = "native-owner-race";
    host.add(id, bench.root).modelProvider = "openai";
    if (archived) host.archivedIds.add(id);
    await bench.call("session/list", { includeArchived: true });
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    t.after(() => release.resolve(undefined));
    const request = host.request.bind(host);
    let held = false;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const result = await request<T>(method, params);
      if (method === "codexhost/thread/inspect" && params.threadId === id && !held) {
        held = true;
        entered.resolve(undefined);
        await release.promise;
      }
      return result;
    };
    const oldWrite = bench.call(archived ? "session/archive" : "session/unarchive", {
      sessionId: id,
    });
    await entered.promise;
    await bench.call(archived ? "session/unarchive" : "session/archive", { sessionId: id });
    assert.equal(host.archivedIds.has(id), !archived);
    assert.equal(bench.workspaces.isArchived(id), !archived);
    release.resolve(undefined);
    await oldWrite;
    assert.equal(host.archivedIds.has(id), !archived);
    assert.equal(bench.workspaces.isArchived(id), !archived);
    assert.deepEqual(
      host.requests
        .filter(
          (r) =>
            r.params.threadId === id &&
            (r.method === "thread/archive" || r.method === "thread/unarchive"),
        )
        .map((r) => r.method),
      [archived ? "thread/unarchive" : "thread/archive"],
    );
  });
}

it("drains an existing refresh before requesting native archive confirmation", async (t) => {
  const host = nativeCodex(new FakeChHost());
  const bench = setup(t, host);
  const id = "native-refresh-before-confirm";
  host.add(id, bench.root).modelProvider = "openai";
  await bench.call("session/list");
  host.archivedIds.add(id);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const rejected = Promise.withResolvers<undefined>();
  const confirming = Promise.withResolvers<undefined>();
  const confirmation = Promise.withResolvers<{ confirmed: boolean }>();
  t.after(() => {
    release.resolve(undefined);
    confirmation.resolve({ confirmed: false });
  });
  const projects = host.projects.bind(host);
  let held = false;
  host.projects = async () => {
    if (!held) {
      held = true;
      entered.resolve(undefined);
      await release.promise;
    }
    return projects();
  };
  const request = host.request.bind(host);
  let confirmations = 0;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/archive") {
      rejected.resolve(undefined);
      throw archiveError(id);
    }
    if (method === THREAD_ARCHIVE_CONFIRM_METHOD) {
      confirmations++;
      confirming.resolve(undefined);
      return (await confirmation.promise) as T;
    }
    return request<T>(method, params);
  };
  const poll = bench.call("session/list");
  await entered.promise;
  const write = bench.call("workspace/archiveSession", { sessionId: id });
  await rejected.promise;
  const turn = Promise.withResolvers<undefined>();
  setImmediate(turn.resolve, undefined);
  await turn.promise;
  assert.equal(confirmations, 0, "the old refresh must finish before confirmation starts");
  release.resolve(undefined);
  await poll;
  await confirming.promise;
  confirmation.resolve({ confirmed: true });
  await write;
  assert.equal(confirmations, 1);
  assert.equal(bench.workspaces.isArchived(id), true);
});

it("does not clean up a newer same-id operation when stale confirmation finishes", async (t) => {
  const bench = await pendingArchive(t);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  const request = bench.host.request.bind(bench.host);
  bench.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const result = await request<T>(method, params);
    if (method === "thread/unarchive") {
      entered.resolve(undefined);
      await release.promise;
    }
    return result;
  };
  const unarchive = bench.call("workspace/unarchiveSession", { sessionId: bench.id });
  await entered.promise;
  bench.release.resolve({ confirmed: true });
  assertArchiveError(await bench.write, bench.id);
  assert.equal(bench.sessions["archiveOperations"].size, 1);
  release.resolve(undefined);
  await unarchive;
  assert.equal(bench.sessions["archiveOperations"].size, 0);
  assert.equal(bench.workspaces.isArchived(bench.id), false);
  assertNoArchiveBroadcast(bench.frames, bench.id);
});

it("keeps an acknowledged archive successful without overwriting a newer unarchive notification", async (t) => {
  const host = nativeCodex(new FakeChChannel());
  const bench = setup(t, host);
  const id = "native-notification-after-success";
  host.add(id, bench.root).modelProvider = "openai";
  await bench.call("session/list");
  await bench.observe();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const result = await request<T>(method, params);
    if (method === "thread/archive") {
      entered.resolve(undefined);
      await release.promise;
    }
    return result;
  };
  const write = bench.call("workspace/archiveSession", { sessionId: id });
  await entered.promise;
  host.archivedIds.delete(id);
  host.changed(id, "thread/unarchived");
  release.resolve(undefined);
  await write;
  assert.equal(bench.workspaces.isArchived(id), false);
  assertNoArchiveBroadcast(bench.frames, id);
  assert.equal(
    host.requests.some((r) => r.method === THREAD_ARCHIVE_CONFIRM_METHOD),
    false,
  );
});

it("reconciles GUI archive/unarchive notifications and reconnect without opening history", async (t) => {
  const host = new FakeChChannel();
  const bench = setup(t, host);
  await bench.observe();
  await bench.call("session/list");
  const wait = async (check: () => boolean) => {
    const until = Date.now() + 3000;
    while (!check()) {
      assert.ok(Date.now() < until, "archive projection timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  host.archivedIds.add("active");
  host.changed("active", "thread/archived");
  await wait(() => bench.workspaces.isArchived("active"));
  host.archivedIds.delete("active");
  host.changed("active", "thread/unarchived");
  await wait(() => !bench.workspaces.isArchived("active"));
  host.connection(false);
  host.archivedIds.add("active");
  host.connection(true);
  await wait(() => bench.workspaces.isArchived("active"));
  assert.equal(host.snapshots, 0);
  assert.equal(
    host.requests.some((r) => r.method === "thread/turns/list"),
    false,
  );
});

it("does not confirm an archive from a catalog read started before the mutation", async (t) => {
  const bench = setup(t);
  await bench.call("session/list");
  const read = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const original = bench.host.projects.bind(bench.host);
  let reads = 0;
  bench.host.projects = async () => {
    if (++reads === 1) {
      started.resolve(undefined);
      await read.promise;
    }
    return original();
  };
  const poll = bench.call("session/list");
  await started.promise;
  const write = bench.call("workspace/archiveSession", { sessionId: "active" });
  while (!bench.host.archivedIds.has("active"))
    await new Promise<void>((resolve) => setImmediate(resolve));
  read.resolve(undefined);
  await poll;
  assert.deepEqual(await write, { archivedSessionIds: ["active", "archived"] });
});

it("follows an in-flight unarchived refresh with an archive-inclusive read when requested", async (t) => {
  const bench = setup(t);
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  const request = bench.host.request.bind(bench.host);
  let blocked = false;
  bench.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/thread/catalog/read" && !blocked) {
      blocked = true;
      entered.resolve(undefined);
      await release.promise;
    }
    return request<T>(method, params);
  };
  const ordinary = bench.call("session/list");
  await entered.promise;
  const archive = bench.call("session/list", { includeArchived: true });
  release.resolve(undefined);
  const [hidden, shown] = (await Promise.all([ordinary, archive])) as Array<{
    items: Array<{ sessionId: string }>;
  }>;
  assert.deepEqual(
    hidden?.items.map((row) => row.sessionId),
    ["active"],
  );
  assert.deepEqual(shown?.items.map((row) => row.sessionId).sort(), ["active", "archived"]);
  assert.deepEqual(
    bench.host.requests
      .filter((r) => r.method === "codexhost/thread/catalog/read")
      .map((r) => r.params.includeArchived),
    [false, true],
  );
});

it("opens an archived Thread by ID without enumerating archives or adding it to the ordinary list", async (t) => {
  const host = nativeCodex(new FakeChHost());
  const bench = setup(t, host);
  host.add("native-archived", bench.root).modelProvider = "openai";
  host.archivedIds.add("native-archived");
  await bench.call("session/list");
  await bench.call("session/projections", { sessionId: "native-archived" });
  const ordinary = (await bench.call("session/list")) as { items: Array<{ sessionId: string }> };
  assert.ok(!ordinary.items.some((row) => row.sessionId === "native-archived"));
  assert.ok(
    host.requests.some(
      (r) =>
        r.method === "thread/read" &&
        r.params.threadId === "native-archived" &&
        r.params.includeTurns === false,
    ),
  );
  assert.ok(
    host.requests
      .filter((r) => r.method === "codexhost/thread/catalog/read")
      .every((r) => r.params.includeArchived === false),
  );
});

it("preserves a native row archived through Desktop without listing native archives", async (t) => {
  const host = nativeCodex(new FakeChChannel());
  const bench = setup(t, host);
  host.add("native-row", bench.root).modelProvider = "openai";
  await bench.call("session/list");
  const removed: unknown[] = [];
  bench.events.emit = (event, id) => {
    if (event === "api-session/removed") removed.push(id);
  };
  host.archivedIds.add("native-row");
  host.changed("native-row", "thread/archived");
  await bench.call("session/list");
  assert.ok(bench.workspaces.isArchived("native-row"));
  assert.ok(bench.sessions["rows"].has("native-row"));
  assert.deepEqual(removed, []);
});

it("keeps a native archive notification newer than an in-flight catalog snapshot", async (t) => {
  const host = nativeCodex(new FakeChChannel());
  const bench = setup(t, host);
  host.add("native-row", bench.root).modelProvider = "openai";
  await bench.call("session/list");
  const removed: unknown[] = [];
  bench.events.emit = (event, id) => {
    if (event === "api-session/removed") removed.push(id);
  };
  const projects = host.projects.bind(host);
  let notified = false;
  host.projects = async () => {
    if (!notified) {
      notified = true;
      host.archivedIds.add("native-row");
      host.changed("native-row", "thread/archived");
    }
    return projects();
  };
  await bench.call("session/list");
  assert.ok(bench.workspaces.isArchived("native-row"));
  await bench.call("session/list");
  assert.ok(bench.sessions["rows"].has("native-row"));
  assert.deepEqual(removed, []);
});

it("retains persisted local archive records", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "local-archives-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  const rpc = new RpcRegistry();
  const workspaces = new Workspaces(data, root);
  workspaces.register(rpc, new StreamRegistry());
  assert.deepEqual(
    await rpc.dispatch("workspace/archiveSession", {
      args: { request: { sessionId: "local" } },
    }),
    { ok: true, value: { archivedSessionIds: ["local"] } },
  );
  assert.equal(new Workspaces(data, root).isArchived("local"), true);
});
