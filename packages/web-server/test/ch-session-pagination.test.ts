import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { nativeCodex } from "./support/native-codex.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

interface List {
  items: Array<{ sessionId: string; updatedAt: number }>;
  archivedSessionIds: string[];
  nextCursor: string | null;
}

function fixture(t: TestContext, host: FakeChHost = nativeCodex(new FakeChHost())) {
  const root = mkdtempSync(join(tmpdir(), "web-catalog-pages-"));
  for (let i = 0; i < 47; i++) {
    const row = host.add(`native-${i}`, root, `Native ${i}`, false);
    row.modelProvider = "openai";
    row.updatedAt = 100 - i;
  }
  for (let i = 0; i < 25; i++) host.add(`external-${i}`, root, `External ${i}`, false);
  host.projectSnapshot.projects.push({
    id: "empty",
    name: "Unloaded project",
    rootPaths: [join(root, "empty")],
  });
  const request = host.request.bind(host);
  const cursors: Array<Record<string, unknown>> = [];
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method !== "codexhost/thread/catalog/read") return request<T>(method, params);
    cursors.push(structuredClone(params));
    const continuation = params.officialCursor as
      { live: string | null; archived?: string | null } | undefined;
    const offset = continuation?.live === null ? Infinity : Number(continuation?.live ?? 0);
    const native = [...host.threads.values()]
      .filter((row) => row.modelProvider !== "codexhost" && !host.archivedIds.has(row.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const official = native.slice(offset, offset + 20);
    const external = [...host.threads.values()].filter((row) => row.modelProvider === "codexhost");
    const threads = [...official, ...external].map((row) => ({
      ...structuredClone(row),
      turns: [],
    }));
    return {
      threads,
      ownership: threads.map((row) => host.threadOwnership(row.id)),
      archivedThreadIds: [],
      officialCursor: {
        live: offset + 20 < native.length ? String(offset + 20) : null,
        ...(params.includeArchived ? { archived: null } : {}),
      },
    } as T;
  };
  const events = new EventHub(root);
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  events.emit = (event, ...args) => emitted.push({ event, args });
  const workspaces = new Workspaces(new DataDir(root), root, true);
  const sessions = new ChSessions(host, workspaces, events);
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  t.after(async () => {
    await sessions.close();
    rmSync(root, { recursive: true, force: true });
  });
  const list = async (request: Record<string, unknown> = {}) => {
    const result = await rpc.dispatch("session/list", { args: { request } });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as List;
  };
  return { host, root, list, cursors, workspaces, emitted, rpc };
}

it("returns 20 latest official rows, all external rows and old native pins in canonical pin order", async (t) => {
  const f = fixture(t);
  f.host.pinnedIds = ["native-45", "external-24", "native-3", "native-46"];
  const result = await f.list();
  assert.equal(result.items.length, 47); // 20 official + 25 external + two old official pins
  assert.equal(new Set(result.items.map((row) => row.sessionId)).size, 47);
  assert.deepEqual(f.workspaces.pinnedSessionIds(), f.host.pinnedIds);
  assert.deepEqual(f.cursors, [{ includeArchived: false }]);
  assert.ok(result.nextCursor);
  assert.equal(JSON.parse(result.nextCursor).officialCursor.live, "20");
  assert.deepEqual(
    f.host.requests
      .filter((r) => r.method === "thread/read")
      .map((r) => r.params.threadId)
      .sort(),
    ["native-45", "native-46"],
  );
  assert.ok(
    f.host.requests
      .filter((r) => r.method === "thread/read")
      .every((r) => r.params.includeTurns === false),
  );
  assert.ok(
    f.workspaces.list().some((w) => w.title === "Unloaded project" && w.sessionIds.length === 0),
  );
  assert.ok(!f.host.requests.some((r) => r.method === "thread/turns/list"));
});

it("bounds missing-pin summary reads instead of issuing an unbounded request fan-out", async (t) => {
  const f = fixture(t);
  f.host.pinnedIds = Array.from({ length: 12 }, (_, i) => `native-${30 + i}`);
  const request = f.host.request.bind(f.host);
  let active = 0,
    maximum = 0;
  f.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method !== "thread/read") return request<T>(method, params);
    maximum = Math.max(maximum, ++active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await request<T>(method, params);
    } finally {
      active--;
    }
  };
  const result = await f.list();
  assert.equal(maximum, 4);
  assert.equal(result.items.length, 57);
  assert.deepEqual(f.workspaces.pinnedSessionIds(), f.host.pinnedIds);
  assert.equal(f.host.requests.filter((r) => r.method === "thread/read").length, 12);
});

it("keeps explicit pages browser-local, never probes omissions, refreshes only the head and stops at the native end", async (t) => {
  const f = fixture(t);
  const a = await f.list();
  const second = await f.list({ cursor: a.nextCursor });
  assert.ok(second.items.some((row) => row.sessionId === "native-39"));
  assert.ok(!second.items.some((row) => row.sessionId === "native-0"));
  assert.ok(
    !f.emitted.some((e) => e.event === "api-session/added"),
    "paging must not load another browser's history",
  );
  const b = await f.list();
  assert.ok(!b.items.some((row) => row.sessionId === "native-39"));
  assert.ok(b.nextCursor);
  assert.equal(JSON.parse(b.nextCursor).officialCursor.live, "20");
  assert.equal(f.host.requests.filter((r) => r.method === "thread/read").length, 0);
  assert.ok(!f.emitted.some((e) => e.event === "api-session/removed"));
  const last = await f.list({ cursor: second.nextCursor });
  assert.equal(last.items.length, 32);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(
    f.cursors.map((p) => (p.officialCursor as { live: string } | undefined)?.live),
    [undefined, "20", undefined, "40"],
  );
  const updated = f.host.threads.get("native-39");
  assert.ok(updated);
  updated.updatedAt = 300;
  const head = await f.list();
  assert.equal(head.items.filter((row) => row.sessionId === "native-39").length, 1);
  const old = await f.list({ sessionId: "native-44" });
  assert.deepEqual(
    old.items.map((row) => row.sessionId),
    ["native-44"],
  );
  assert.equal(f.cursors.length, 5, "direct links do not enumerate any catalog page");
});

for (const state of ["pending", "failed"] as const) {
  it(
    `returns a direct-link summary without waiting for ${state} project metadata`,
    { timeout: 1_000 },
    async (t) => {
      const f = fixture(t);
      const pending = Promise.withResolvers<Awaited<ReturnType<FakeChHost["projects"]>>>();
      t.after(() => pending.resolve(f.host.projectSnapshot));
      const projects = t.mock.method(f.host, "projects", async () => {
        if (state === "failed") throw new Error("Project metadata unavailable");
        return pending.promise;
      });
      f.host.projectSnapshot.assignments["native-44"] = "empty";
      const direct = await f.list({ sessionId: "native-44" });
      assert.deepEqual(
        direct.items.map((row) => row.sessionId),
        ["native-44"],
      );
      assert.equal(direct.items[0]?.updatedAt, 56_000);
      assert.equal(
        projects.mock.callCount(),
        0,
        "direct reads neither await nor launch project synchronization",
      );
      assert.equal(f.cursors.length, 0, "direct reads never enumerate the catalog");
      assert.ok(!f.host.requests.some((r) => r.method === "thread/list"));
      assert.deepEqual(
        f.host.requests.filter((r) => r.method === "thread/read").map((r) => r.params),
        [{ threadId: "native-44", includeTurns: false }],
      );
      assert.equal(f.workspaces.ownerOf("native-44"), undefined);

      projects.mock.restore();
      await f.list();
      assert.equal(
        f.workspaces.ownerOf("native-44")?.path,
        join(f.root, "empty"),
        "the existing catalog refresh groups retained direct-link rows, even outside the latest page",
      );
      assert.equal(f.cursors.length, 1);
    },
  );
}

it("background refresh reads only the latest page and concurrent browser pages are not coalesced", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(t);
  const first = await f.list();
  t.mock.timers.tick(10_000);
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.cursors, [{ includeArchived: false }, { includeArchived: false }]);
  const before = f.cursors.length;
  const [a, b] = await Promise.all([
    f.list({ cursor: first.nextCursor }),
    f.list({ cursor: first.nextCursor }),
  ]);
  assert.equal(f.cursors.length, before + 2);
  assert.equal(a.nextCursor, b.nextCursor);
  assert.equal(f.host.requests.filter((r) => r.method === "thread/read").length, 0);
});

it("keeps confirmed archive membership through stale live pages and incomplete inclusive scopes", async (t) => {
  const host = nativeCodex(new FakeChChannel());
  const f = fixture(t, host);
  await f.list();
  const request = host.request.bind(host);
  const ready = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  let hold = true;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const result = await request<T>(method, params);
    if (method === "codexhost/thread/catalog/read" && hold) {
      ready.resolve(undefined);
      await gate.promise;
    }
    return result;
  };
  const stale = f.list();
  await ready.promise;
  host.archivedIds.add("native-0");
  host.changed("native-0", "thread/archived");
  gate.resolve(undefined);
  hold = false;
  const result = await stale;
  assert.ok(result.archivedSessionIds.includes("native-0"));
  assert.ok(!result.items.some((row) => row.sessionId === "native-0"));
  const inclusive = await f.list({ includeArchived: true });
  assert.ok(
    inclusive.archivedSessionIds.includes("native-0"),
    "one incomplete archive page cannot clear known membership",
  );
  assert.ok(!f.emitted.some((event) => event.event === "api-session/removed"));
});

it("rejects cross-scope continuations and reports pin failures without hiding the catalog", async (t) => {
  const f = fixture(t);
  const head = await f.list();
  const count = f.cursors.length;
  const invalid = await f.rpc.dispatch("session/list", {
    args: { request: { cursor: head.nextCursor, includeArchived: true } },
  });
  assert.equal(invalid.ok, false);
  assert.equal(f.cursors.length, count);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  f.host.pinError = "Native pins unavailable";
  assert.ok((await f.list()).items.length > 0);
  assert.ok(errors.some((args) => String(args[0]).includes("native pins unavailable")));
});
