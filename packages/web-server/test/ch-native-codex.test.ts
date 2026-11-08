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
  }>("session/list");
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
      .filter((r) => r.method === "thread/list")
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
});
