import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { nativeCodex } from "./support/native-codex.ts";

it("lists native and external Threads and continues native history with its original identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-native-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = nativeCodex(new FakeChHost());
  host.add("native-existing", root).modelProvider = "openai";
  host.add("native-other-provider", root).modelProvider = "custom-provider";
  host.add("external-existing", root);
  host.add("native-archived", root).modelProvider = "openai";
  host.archivedIds.add("native-archived");
  const workspaces = new Workspaces(new DataDir(root), root);
  const sessions = new ChSessions(host, workspaces, new EventHub(root));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  async function call<T>(method: string, request = {}) {
    const result = await rpc.dispatch(method, { args: { request } });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  }
  const list = await call<{
    items: Array<{ sessionId: string; projections: { values: Record<string, unknown> } }>;
  }>("session/list", { includeArchived: true });
  assert.deepEqual(list.items.map((r) => r.sessionId).sort(), [
    "external-existing",
    "native-archived",
    "native-existing",
    "native-other-provider",
  ]);
  assert.deepEqual(
    list.items.find((r) => r.sessionId === "native-existing")?.projections.values.harnessIdentity,
    { id: "codex", name: "Codex" },
  );
  assert.ok(workspaces.archivedSessionIds().includes("native-archived"));
  assert.ok(
    host.requests
      .filter((r) => r.method === "codexhost/thread/catalog/read")
      .every((r) => r.params.modelProviders === undefined),
  );
  const projections = await call<{ values: Record<string, unknown> }>("session/projections", {
    sessionId: "native-existing",
  });
  assert.deepEqual(projections.values.threadReference, { hostId: "local" });
  await call("session/prompt", {
    sessionId: "native-existing",
    requestId: "native-followup",
    content: [{ type: "text", text: "continue here" }],
  });
  const starts = host.requests.filter((r) => r.method === "turn/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.params.threadId, "native-existing");
  assert.equal(starts[0]?.params.model, undefined);
  assert.equal(starts[0]?.params.approvalPolicy, undefined);
  assert.equal(host.threads.get("native-existing")?.turns.length, 2);
  assert.equal(
    host.requests.some(
      (r) => r.method === "thread/start" || r.method.includes("session-import/import"),
    ),
    false,
  );
  await call("session/rename", { sessionId: "native-existing", title: "same native chat" });
  assert.equal(host.threads.get("native-existing")?.name, "same native chat");

  const catalog = await call<{ groups: Array<{ id: string; name: string }> }>(
    "session/modelCatalog",
  );
  assert.deepEqual(
    catalog.groups.map((group) => group.id),
    ["codex", "fake"],
  );
  assert.equal(catalog.groups[0]?.name, "Codex");
  for (const cwd of [root, undefined]) {
    const draft = await call<{ sessionId: string }>("session/create", cwd ? { cwd } : {});
    const draftProjections = await call<{
      values: { permissions: { currentValue: string } };
    }>("session/projections", { sessionId: draft.sessionId });
    assert.deepEqual(draftProjections.values.permissions, { currentValue: "" });
    await call("session/prompt", {
      sessionId: draft.sessionId,
      content: [{ type: "text", text: "First official message" }],
    });
    const start = host.requests.filter((entry) => entry.method === "thread/start").at(-1);
    assert.deepEqual(start?.params.model, { id: "gpt-5.4" });
    assert.equal(start?.params.permissions, undefined);
    assert.equal(start?.params.cwd, cwd);
    assert.deepEqual(
      start?.params.projectlessWorkspace,
      cwd ? undefined : { prompt: "First official message" },
    );
    const created = [...host.threads.values()].at(-1);
    assert.ok(created);
    assert.ok(created.id.startsWith("native-created-"));
    assert.equal(created.modelProvider, "openai");
    assert.equal(
      host.requests.filter((entry) => entry.method === "turn/start").at(-1)?.params.threadId,
      created.id,
    );
  }
});

it("omits unavailable Codex, exposes inspection errors and restores its entry after recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "web-native-unavailable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  assert.deepEqual(
    (await sessions.catalog.models()).groups.map((group) => group.id),
    ["fake"],
  );
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/harness/inspect" && params.harnessId === "codex")
      return {
        status: "error",
        error: { code: "unavailable", message: "official catalog failed", retryable: false },
      } as T;
    return request<T>(method, params);
  };
  const failed = await sessions.catalog.models();
  assert.deepEqual(failed.failures, [
    { id: "codex", name: "Codex", message: "official catalog failed" },
  ]);
  nativeCodex(host);
  assert.deepEqual(
    (await sessions.catalog.models()).groups.map((group) => group.id),
    ["codex", "fake"],
  );
});
