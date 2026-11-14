import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import type { CatalogPage } from "../src/ch-session-page.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { nativeCodex } from "./support/native-codex.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ch-tree-restore-"));
  const host = nativeCodex(new FakeChHost());
  for (const id of ["native-parent", "native-unrelated", "native-child", "native-live"]) {
    host.add(id, directory).modelProvider = "openai";
    if (id !== "native-live") host.archivedIds.add(id);
  }
  const parents: Record<string, string> = { "native-child": "native-parent" };
  const archivePages = [["native-parent", "native-unrelated"], ["native-child"]];
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/thread/tree/read") {
      host.requests.push({ method, params: structuredClone(params) });
      return { parents: { ...parents } } as T;
    }
    if (method === "codexhost/thread/catalog/read") {
      host.requests.push({ method, params: structuredClone(params) });
      const cursor = params.officialCursor as CatalogPage["officialCursor"];
      const index = cursor?.archived === undefined ? 0 : Number(cursor.archived);
      const archived =
        params.includeArchived === true && cursor?.archived !== null
          ? (archivePages[index] ?? []).filter((id) => host.archivedIds.has(id))
          : [];
      const live =
        cursor?.live === null
          ? []
          : [...host.threads.keys()].filter((id) => !host.archivedIds.has(id));
      const ids = [...live, ...archived];
      const page: CatalogPage = {
        threads: ids.map((id) => {
          const thread = host.threads.get(id);
          assert.ok(thread);
          return { ...structuredClone(thread), turns: [] };
        }),
        ownership: ids.map((id) => ({ threadId: hostThreadIdSchema.parse(id), owner: "codex" })),
        archivedThreadIds: archived.map((id) => hostThreadIdSchema.parse(id)),
        officialCursor: {
          live: null,
          ...(params.includeArchived === true
            ? { archived: index + 1 < archivePages.length ? String(index + 1) : null }
            : {}),
        },
      };
      return page as T;
    }
    if (method === "thread/unarchive" && !host.archivedIds.has(String(params.threadId))) {
      host.requests.push({ method, params: structuredClone(params) });
      throw new RpcError("host/rejected", "no archived rollout found", { hostCode: -32600 });
    }
    return request<T>(method, params);
  };
  const workspaces = new Workspaces(new DataDir(directory), directory, true);
  const sessions = new ChSessions(host, workspaces, new EventHub(directory));
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  t.after(async () => {
    await sessions.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const dispatch = (method: string, request: object = {}) =>
    rpc.dispatch(method, { args: { request } });
  const load = async () => {
    const result = await dispatch("session/list", { includeArchived: true });
    assert.ok(result.ok);
    assert.deepEqual(workspaces.archivedSessionIds(), ["native-parent", "native-unrelated"]);
    assert.equal(sessions["rows"].has("native-child"), false);
    host.requests.length = 0;
  };
  const writes = () =>
    host.requests
      .filter((entry) => entry.method === "thread/unarchive")
      .map((entry) => entry.params.threadId);
  const confirmations = () =>
    host.requests.filter(
      (entry) =>
        entry.method === "codexhost/thread/catalog/read" && entry.params.includeArchived === true,
    );
  return { host, parents, dispatch, load, writes, confirmations, workspaces };
}

for (const method of ["workspace/unarchiveSession", "session/unarchive"]) {
  it(`${method} restores a native child on a later archive page in a fresh Web instance`, async (t) => {
    const f = fixture(t);
    await f.load();
    const result = await f.dispatch(method, { sessionId: "native-parent" });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(
      f.host.archivedIds.has("native-child"),
      false,
      "child must be restored with parent",
    );
    assert.deepEqual(f.writes(), ["native-parent", "native-child"]);
    assert.deepEqual([...f.host.archivedIds], ["native-unrelated"]);
    assert.deepEqual(f.workspaces.archivedSessionIds(), ["native-unrelated"]);
    assert.deepEqual(
      f.confirmations().map((entry) => entry.params),
      [
        { includeArchived: true, officialCursor: { live: null } },
        { includeArchived: true, officialCursor: { live: null, archived: "1" } },
      ],
    );
  });
}

it("confirms live descendants before skipping their native writes and shares the archive read", async (t) => {
  const f = fixture(t);
  f.parents["native-live"] = "native-parent";
  await f.load();
  const result = await f.dispatch("workspace/unarchiveSession", { sessionId: "native-parent" });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(f.writes(), ["native-parent", "native-child"]);
  assert.deepEqual([...f.host.archivedIds], ["native-unrelated"]);
  assert.equal(f.confirmations().length, 2, "one archive traversal serves both descendants");
});

for (const failure of ["offline", "repeated cursor"] as const) {
  it(`reports an unknown descendant when archive confirmation has a ${failure} failure and restores known archives`, async (t) => {
    const f = fixture(t);
    f.parents["native-unrelated"] = "native-parent";
    await f.load();
    const request = f.host.request.bind(f.host);
    t.mock.method(
      f.host,
      "request",
      async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        const secondPage =
          method === "codexhost/thread/catalog/read" &&
          (params.officialCursor as CatalogPage["officialCursor"])?.archived === "1";
        if (secondPage && failure === "offline") {
          f.host.requests.push({ method, params: structuredClone(params) });
          throw new RpcError("host/offline", "Archive catalog unavailable");
        }
        const result = await request<T>(method, params);
        if (secondPage && failure === "repeated cursor")
          (result as CatalogPage).officialCursor = { live: null, archived: "1" };
        return result;
      },
    );
    const result = await f.dispatch("workspace/unarchiveSession", { sessionId: "native-parent" });
    assert.ok(!result.ok);
    assert.equal(result.error.code, "session/archive-partial");
    assert.deepEqual(result.error.details, { failedSessionIds: ["native-child"] });
    assert.deepEqual(f.writes(), ["native-parent", "native-unrelated"]);
    assert.deepEqual([...f.host.archivedIds], ["native-child"]);
    assert.equal(f.confirmations().length, 2);
  });
}

it("preserves the selected Thread's native restore error without confirming or mutating descendants", async (t) => {
  const f = fixture(t);
  await f.load();
  f.host.archivedIds.delete("native-parent");
  const result = await f.dispatch("workspace/unarchiveSession", { sessionId: "native-parent" });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "host/rejected");
  assert.deepEqual(result.error.details, { hostCode: -32600 });
  assert.deepEqual(f.writes(), ["native-parent"]);
  assert.equal(f.confirmations().length, 0);
  assert.equal(f.host.archivedIds.has("native-child"), true);
});
