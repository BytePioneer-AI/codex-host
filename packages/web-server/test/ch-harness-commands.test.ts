import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { withDiscovery } from "./support/harness-commands.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ch-commands-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  const thread = host.add("existing", root);
  const state = withDiscovery(host);
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  sessions.registerCommands(rpc);
  const dispatch = (method: string, request: object) => rpc.dispatch(method, { args: { request } });
  const inspect = (sessionId = thread.id) => dispatch("codexhost/threadCommands", { sessionId });
  const execute = (commandId = "fake.compact", sessionId = thread.id) =>
    dispatch("codexhost/executeThreadCommand", { sessionId, commandId });
  return { host, thread, state, sessions, dispatch, inspect, execute };
}
it("preserves live/static/unspecified catalogs and native metadata without creating or resuming sessions", async (t) => {
  const { host, state, inspect } = fixture(t);
  for (const source of ["live", "static", undefined] as const) {
    if (source) state.catalog.source = source;
    else delete state.catalog.source;
    assert.deepEqual(await inspect(), { ok: true, value: state.catalog });
  }
  assert.ok(
    host.requests.every((r) =>
      ["codexhost/thread/inspect", "thread/read", "codexhost/thread/commands/inspect"].includes(
        r.method,
      ),
    ),
  );
  assert.equal(host.threads.size, 1);
});
it("rejects unbound drafts, official ownership, read-only children and missing Threads", async (t) => {
  const { host, thread, dispatch, inspect, execute } = fixture(t);
  const created = await dispatch("session/create", { cwd: thread.cwd });
  assert.ok(created.ok);
  const draft = (created.value as { sessionId: string }).sessionId;
  host.requests.length = 0;
  assert.equal((await inspect(draft)).ok, false);
  assert.equal((await execute("fake.compact", draft)).ok, false);
  assert.equal(host.requests.length, 0);
  thread.parentThreadId = "parent";
  assert.equal((await inspect()).ok, false);
  delete thread.parentThreadId;
  thread.canAcceptDirectInput = false;
  assert.equal((await inspect()).ok, false);
  thread.canAcceptDirectInput = true;
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    method === "codexhost/thread/inspect"
      ? ({ owner: "codex", locked: true } as T)
      : request<T>(method, params);
  assert.equal((await inspect()).ok, false);
  assert.equal((await inspect("missing")).ok, false);
  assert.equal(
    host.requests.some((r) => r.method.includes("commands/inspect")),
    false,
  );
});
it("executes by stable ID with no arguments, and rejects unknown/text commands and busy Threads", async (t) => {
  const { host, thread, execute } = fixture(t);
  assert.deepEqual(await execute(), {
    ok: true,
    value: { accepted: true, turnId: "native-command-turn" },
  });
  assert.deepEqual(
    host.requests.find((r) => r.method === "codexhost/thread/command/execute")?.params,
    { threadId: thread.id, commandId: "fake.compact" },
  );
  assert.equal((await execute("fake.skill")).ok, false);
  assert.equal((await execute("missing")).ok, false);
  thread.status.type = "active";
  assert.equal((await execute()).ok, false);
  assert.equal(
    host.requests.filter((r) => r.method === "codexhost/thread/command/execute").length,
    1,
  );
});
it("fences duplicate requests, preserves Host errors and never retries an unknown write", async (t) => {
  const { host, state, inspect, execute } = fixture(t);
  state.failure = "Old Host cannot inspect commands";
  assert.match(JSON.stringify(await inspect()), /Old Host/);
  state.failure = "";
  const gate = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  state.beforeExecute = async () => {
    started.resolve(undefined);
    await gate.promise;
  };
  const first = execute();
  await started.promise;
  assert.equal((await execute()).ok, false);
  state.executionFailure = "Connection lost; outcome unknown";
  gate.resolve(undefined);
  assert.match(JSON.stringify(await first), /outcome unknown/);
  assert.equal(
    host.requests.filter((r) => r.method === "codexhost/thread/command/execute").length,
    1,
  );
});
it("reuses the ready Web Harness catalog, filters usage/unavailable entries, and preserves identity/order", async (t) => {
  const { state, sessions, host } = fixture(t);
  state.extraHarnesses = true;
  const catalog = await sessions.catalog.models();
  assert.deepEqual(
    catalog.groups.map((g) => [g.id, g.name]),
    [
      ["codex-cli", "Codex"],
      ["fake", "Twin"],
      ["other", "Twin"],
    ],
  );
  assert.equal(
    host.requests.some((r) => ["thread/start", "turn/start", "thread/resume"].includes(r.method)),
    false,
  );
});
