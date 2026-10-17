import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

for (const failure of ["wrong-harness", "inspection-unavailable"] as const) {
  it(`does not bind or send a draft after ${failure}, including repeated submissions`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ch-harness-routing-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const host = new FakeChHost();
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const result = await request<T>(method, params);
      if (method !== "codexhost/thread/inspect") return result;
      if (failure === "inspection-unavailable")
        throw new RpcError("host/offline", "Cannot confirm the created Thread's Harness.");
      return { ...result, harnessId: "claude-code" };
    };
    const events = new EventHub(root);
    const emitted = t.mock.method(events, "emit");
    const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events);
    t.after(() => sessions.close());
    const rpc = new RpcRegistry();
    sessions.register(rpc, new StreamRegistry());
    const created = await rpc.dispatch("session/create", { args: { request: { cwd: root } } });
    assert.ok(created.ok);
    const { sessionId } = created.value as { sessionId: string };
    const send = () =>
      rpc.dispatch("session/prompt", {
        args: { request: { sessionId, content: [{ type: "text", text: "Do not misroute" }] } },
      });
    const first = await send();
    assert.ok(!first.ok);
    assert.equal(
      first.error.code,
      failure === "wrong-harness" ? "session/harness-mismatch" : "host/offline",
    );
    if (failure === "wrong-harness") {
      assert.deepEqual(first.error.details, {
        threadId: "canonical-1",
        expectedHarnessId: "fake",
        actualHarnessId: "claude-code",
      });
    }
    assert.deepEqual(await send(), first, "The failed creation must remain fenced");
    assert.equal(host.requests.filter(({ method }) => method === "thread/start").length, 1);
    assert.equal(host.requests.filter(({ method }) => method === "turn/start").length, 0);
    assert.equal(host.threads.size, 1, "Do not delete or recreate a possibly allocated Session");
    assert.equal(
      emitted.mock.calls.some(({ arguments: args }) => args[0] === "codexhost/session-bound"),
      false,
      "Do not navigate the browser to an unconfirmed Harness",
    );
    const projections = await rpc.dispatch("session/projections", {
      args: { request: { sessionId } },
    });
    assert.ok(projections.ok);
    assert.equal(
      (projections.value as { values: { harnessIdentity: { id: string } } }).values.harnessIdentity
        .id,
      "fake",
      "Retain the selected Harness on the original draft",
    );
  });
}
