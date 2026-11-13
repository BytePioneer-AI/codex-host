import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ChSessions } from "../src/ch-sessions.ts";
import { THREAD_TREE_ANCESTOR_LIMIT } from "../src/ch-thread-tree.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChChannel } from "./support/ch-channel.ts";
import type { CatalogPage } from "../src/ch-session-page.ts";

class TreeHost extends FakeChChannel {
  parents: Record<string, string> = {};
  pageIds: Set<string> | undefined;
  failures = new Set<string>();
  override async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "codexhost/thread/tree/read") {
      this.requests.push({ method, params: structuredClone(params) });
      return { parents: { ...this.parents } } as T;
    }
    if (
      (method === "thread/archive" || method === "thread/unarchive") &&
      this.failures.has(String(params.threadId))
    ) {
      this.requests.push({ method, params: structuredClone(params) });
      throw new Error("Archive rejected by Host.");
    }
    const result = await super.request<T>(method, params);
    if (method === "codexhost/thread/catalog/read" && this.pageIds) {
      const page = result as CatalogPage;
      const pageIds = this.pageIds;
      page.threads = page.threads.filter((row) => pageIds.has(row.id));
      page.ownership = page.ownership.filter((owner) => pageIds.has(owner.threadId));
      page.officialCursor = {
        live: "older",
        ...(params.includeArchived === true ? { archived: null } : {}),
      };
    }
    if (method === "thread/read") {
      const value = result as { thread: { archived?: boolean } };
      value.thread.archived = this.archivedIds.has(String(params.threadId));
    }
    return result;
  }
}
interface Summary {
  sessionId: string;
  parentSessionId?: string;
  origin?: string;
  projections: { values: { threadTreeParent?: string | null; nativeDiscovery?: boolean } };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "web-tree-"));
  const host = new TreeHost();
  const events = new EventHub(directory);
  const workspaces = new Workspaces(new DataDir(directory), directory);
  const sessions = new ChSessions(host, workspaces, events);
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  t.after(async () => {
    await sessions.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const dispatch = (method: string, request: object = {}) =>
    rpc.dispatch(method, { args: { request } });
  const call = async <T>(method: string, request: object = {}): Promise<T> => {
    const result = await dispatch(method, request);
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  const add = (id: string) => host.add(id, directory);
  const list = (request: object = {}) => call<{ items: Summary[] }>("session/list", request);
  const mutations = () =>
    host.requests.filter(
      (request) => request.method === "thread/archive" || request.method === "thread/unarchive",
    );
  return { host, events, workspaces, sessions, rpc, dispatch, call, list, add, mutations };
}
async function wait(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Catalog change was not published.");
    await delay(10);
  }
}

it("supplements a first-page child with deduplicated multilevel ancestors and keeps direct input", async (t) => {
  const { host, add, list, call } = fixture(t);
  for (const id of ["child", "sibling", "parent", "grandparent"]) add(id);
  host.parents = { child: "parent", sibling: "parent", parent: "grandparent" };
  host.pageIds = new Set(["child", "sibling"]);
  const page = await list();
  assert.deepEqual(
    new Set(page.items.map((row) => row.sessionId)),
    new Set(["child", "sibling", "parent", "grandparent"]),
  );
  const child = page.items.find((row) => row.sessionId === "child");
  assert.ok(child);
  assert.equal(child.projections.values.threadTreeParent, "parent");
  assert.equal(child.projections.values.nativeDiscovery, true);
  assert.equal(child.parentSessionId, undefined);
  assert.equal(child.origin, undefined);
  assert.deepEqual(
    host.requests
      .filter((request) => request.method === "thread/read")
      .map((request) => request.params),
    [
      { threadId: "parent", includeTurns: false },
      { threadId: "grandparent", includeTurns: false },
    ],
  );
  await call("session/prompt", {
    sessionId: "child",
    requestId: "send",
    content: [{ type: "text", text: "continue child" }],
    mode: "queue",
  });
  assert.ok(
    host.requests.some(
      (request) => request.method === "turn/start" && request.params.threadId === "child",
    ),
  );
  const direct = await list({ sessionId: "child" });
  assert.deepEqual(
    direct.items.map((row) => row.sessionId),
    ["child", "parent", "grandparent"],
  );
});

it("keeps display lineage in newly opened history projections before another catalog refresh", async (t) => {
  const { host, add, list, call } = fixture(t);
  add("parent");
  add("child");
  host.parents = { child: "parent" };
  await list();
  const projections = await call<{ values: { threadTreeParent?: string | null } }>(
    "session/projections",
    { sessionId: "child" },
  );
  assert.equal(projections.values.threadTreeParent, "parent");
});

for (const notification of ["thread/started", "codexhost/thread/tree/changed"]) {
  it(`pushes delegation relationship changes through the catalog on ${notification}`, async (t) => {
    const { host, add, list, events } = fixture(t);
    add("child");
    add("parent");
    const emitted = t.mock.method(events, "emit");
    await list();
    host.parents = { child: "parent" };
    host.changed("child", notification);
    await wait(() =>
      emitted.mock.calls.some(
        ({ arguments: [event, value] }) =>
          event === "api-session/added" &&
          (value as Summary).sessionId === "child" &&
          (value as Summary).projections.values.threadTreeParent === "parent",
      ),
    );
  });
}

it("bounds missing ancestor reads, deduplicates cycles, and tolerates deleted ancestors", async (t) => {
  const { host, add, list } = fixture(t);
  for (let n = 0; n <= THREAD_TREE_ANCESTOR_LIMIT + 2; n++) {
    add(`thread-${n}`);
    host.parents[`thread-${n}`] = `thread-${n + 1}`;
  }
  host.pageIds = new Set(["thread-0"]);
  const page = await list();
  assert.equal(page.items.length, THREAD_TREE_ANCESTOR_LIMIT + 1);
  assert.equal(
    host.requests.filter((request) => request.method === "thread/read").length,
    THREAD_TREE_ANCESTOR_LIMIT,
  );
});
it("stops ancestor cycles and leaves missing parents as visible orphans", async (t) => {
  const { host, add, list } = fixture(t);
  add("a");
  add("b");
  add("orphan");
  host.pageIds = new Set(["a", "orphan"]);
  host.parents = { a: "b", b: "a", orphan: "deleted" };
  const page = await list();
  assert.deepEqual(new Set(page.items.map((row) => row.sessionId)), new Set(["a", "b", "orphan"]));
  assert.equal(
    host.requests.filter(
      (request) => request.method === "thread/read" && request.params.threadId === "b",
    ).length,
    1,
  );
});

it("marks archived ancestors without showing them in the live page and preserves Subagent semantics", async (t) => {
  const { host, add, list, workspaces } = fixture(t);
  add("parent");
  add("child");
  const subagent = add("subagent");
  subagent.parentThreadId = "child";
  subagent.canAcceptDirectInput = false;
  host.parents = { child: "parent" };
  host.archivedIds.add("parent");
  host.pageIds = new Set(["child", "subagent"]);
  const page = await list();
  assert.ok(!page.items.some((row) => row.sessionId === "parent"));
  assert.ok(workspaces.archivedSessionIds().includes("parent"));
  assert.equal(page.items.find((row) => row.sessionId === "subagent")?.origin, "subagent");
  assert.equal(page.items.find((row) => row.sessionId === "subagent")?.parentSessionId, "child");
});

it("retains archive notifications received while ancestor project metadata is loading", async (t) => {
  const { host, add, list, workspaces } = fixture(t);
  add("child");
  add("parent");
  host.parents = { child: "parent" };
  host.pageIds = new Set(["child"]);
  host.archivedIds.add("parent");
  const waiting = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  let reads = 0;
  const projects = host.projects.bind(host);
  t.mock.method(host, "projects", async () => {
    if (++reads === 2) {
      waiting.resolve(undefined);
      await release.promise;
    }
    return projects();
  });
  const pending = list();
  await waiting.promise;
  host.archivedIds.delete("parent");
  host.changed("parent", "thread/unarchived");
  release.resolve(undefined);
  const page = await pending;
  assert.ok(page.items.some((row) => row.sessionId === "parent"));
  assert.ok(!workspaces.archivedSessionIds().includes("parent"));
});

it("archives and restores all unloaded descendants parent first, and limits child-only archive to its subtree", async (t) => {
  const { host, add, list, call, mutations } = fixture(t);
  for (const id of ["root", "child", "grandchild", "other"]) add(id);
  host.parents = { child: "root", grandchild: "child" };
  host.pageIds = new Set(["root"]);
  await list();
  await call("session/archive", { sessionId: "root" });
  assert.deepEqual(
    mutations().map((request) => request.params.threadId),
    ["root", "child", "grandchild"],
  );
  assert.deepEqual([...host.archivedIds], ["root", "child", "grandchild"]);
  host.requests.length = 0;
  await call("session/unarchive", { sessionId: "root" });
  assert.deepEqual(
    mutations().map((request) => [request.method, request.params.threadId]),
    [
      ["thread/unarchive", "root"],
      ["thread/unarchive", "child"],
      ["thread/unarchive", "grandchild"],
    ],
  );
  assert.equal(host.archivedIds.size, 0);
  host.requests.length = 0;
  await call("session/archive", { sessionId: "child" });
  assert.deepEqual(
    mutations().map((request) => request.params.threadId),
    ["child", "grandchild"],
  );
  assert.ok(!host.archivedIds.has("root"));
});

it("uses the same cascade for sidebar Workspace archive and restore commands", async (t) => {
  const { host, add, list, call, mutations } = fixture(t);
  for (const id of ["root", "child", "grandchild"]) add(id);
  host.parents = { child: "root", grandchild: "child" };
  await list();
  const archived = await call<{ archivedSessionIds: string[] }>("workspace/archiveSession", {
    sessionId: "root",
  });
  assert.deepEqual(archived.archivedSessionIds, ["child", "grandchild", "root"]);
  assert.deepEqual(
    mutations().map((request) => request.params.threadId),
    ["root", "child", "grandchild"],
  );
  const restored = await call<{ archivedSessionIds: string[] }>("workspace/unarchiveSession", {
    sessionId: "root",
  });
  assert.deepEqual(restored.archivedSessionIds, []);
  assert.equal(host.archivedIds.size, 0);
});

it("refreshes the catalog once per cascade rather than once per descendant", async (t) => {
  const { host, add, list, call, mutations } = fixture(t);
  add("root");
  for (let index = 0; index < 30; index++) {
    const id = `child-${index}`;
    add(id);
    host.parents[id] = "root";
  }
  host.pageIds = new Set(["root"]);
  await list();
  for (const method of ["session/archive", "session/unarchive"]) {
    host.requests.length = 0;
    await call(method, { sessionId: "root" });
    assert.equal(mutations().length, 31);
    assert.equal(
      host.requests.filter((request) => request.method === "codexhost/thread/catalog/read").length,
      1,
    );
  }
});

for (const archived of [true, false]) {
  it(`skips descendants already ${archived ? "archived" : "restored"} but still writes the selected Thread and traverses their children`, async (t) => {
    const { host, add, list, call, mutations } = fixture(t);
    for (const id of ["root", "child", "grandchild"]) add(id);
    host.parents = { child: "root", grandchild: "child" };
    host.pageIds = new Set(["root"]);
    if (archived) {
      host.archivedIds.add("root");
      host.archivedIds.add("child");
    } else host.archivedIds.add("grandchild");
    await list({ includeArchived: true });
    host.failures.add("child");
    host.requests.length = 0;
    await call(archived ? "session/archive" : "session/unarchive", { sessionId: "root" });
    assert.deepEqual(
      mutations().map((request) => request.params.threadId),
      ["root", "grandchild"],
    );
    for (const id of ["root", "child", "grandchild"])
      assert.equal(host.archivedIds.has(id), archived);
  });
}

for (const archived of [true, false]) {
  it(`preserves the selected Thread's ${archived ? "archive" : "restore"} error and leaves all descendants untouched`, async (t) => {
    const { host, add, list, dispatch, mutations } = fixture(t);
    const ids = ["root", "child", "grandchild"];
    for (const id of ids) {
      add(id);
      if (!archived) host.archivedIds.add(id);
    }
    host.parents = { child: "root", grandchild: "child" };
    await list({ includeArchived: true });
    host.failures.add("root");
    host.requests.length = 0;
    const result = await dispatch(archived ? "session/archive" : "session/unarchive", {
      sessionId: "root",
    });
    assert.ok(!result.ok);
    assert.equal(result.error.message, "Archive rejected by Host.");
    assert.notEqual(result.error.code, "session/archive-partial");
    assert.deepEqual(
      mutations().map((request) => request.params.threadId),
      ["root"],
    );
    for (const id of ids) assert.equal(host.archivedIds.has(id), !archived);
  });
}

it("refreshes once and preserves restore partial failures", async (t) => {
  const { host, add, list, dispatch, mutations } = fixture(t);
  for (const id of ["root", "child", "grandchild"]) {
    add(id);
    host.archivedIds.add(id);
  }
  host.parents = { child: "root", grandchild: "child" };
  host.pageIds = new Set(["root"]);
  await list({ includeArchived: true });
  host.failures.add("child");
  host.requests.length = 0;
  const result = await dispatch("session/unarchive", { sessionId: "root" });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "session/archive-partial");
  assert.deepEqual(result.error.details, { failedSessionIds: ["child"] });
  assert.deepEqual([...host.archivedIds], ["child"]);
  assert.deepEqual(
    mutations().map((request) => request.params.threadId),
    ["root", "child", "grandchild"],
  );
  assert.equal(
    host.requests.filter((request) => request.method === "codexhost/thread/catalog/read").length,
    1,
  );
});

it("reports partial failures without rollback or skipping later descendants", async (t) => {
  const { host, add, dispatch, mutations } = fixture(t);
  for (const id of ["root", "child", "grandchild"]) add(id);
  host.parents = { child: "root", grandchild: "child" };
  host.pageIds = new Set(["root"]);
  host.failures.add("child");
  const result = await dispatch("session/archive", { sessionId: "root" });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "session/archive-partial");
  assert.deepEqual(result.error.details, { failedSessionIds: ["child"] });
  assert.deepEqual([...host.archivedIds], ["root", "grandchild"]);
  assert.deepEqual(
    mutations().map((request) => request.params.threadId),
    ["root", "child", "grandchild"],
  );
  host.requests.length = 0;
  const restore = await dispatch("session/unarchive", { sessionId: "root" });
  assert.ok(restore.ok);
  assert.deepEqual(
    mutations().map((request) => request.params.threadId),
    ["root", "grandchild"],
  );
  assert.equal(host.archivedIds.size, 0);
});
