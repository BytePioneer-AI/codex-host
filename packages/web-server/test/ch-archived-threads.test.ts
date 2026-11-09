import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
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
