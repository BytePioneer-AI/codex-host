import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createChHostClient } from "../src/ch-host-client.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChChannel, startFakeChChannel } from "./support/ch-channel.ts";
import { defined } from "./support/defined.ts";

const busyMessage =
  "External Native Session is busy. Close it in the other client or wait for its active operation to finish, then retry.";

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ch-host-errors-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  host.add("imported", directory);
  const control = await startFakeChChannel(host, directory, "service");
  t.after(() => control.close());
  const client = await createChHostClient({ directory });
  t.after(() => client.close());
  const sessions = new ChSessions(
    client,
    new Workspaces(new DataDir(directory), directory),
    new EventHub(directory),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  assert.equal((await rpc.dispatch("session/list", { args: {} })).ok, true);
  return { host, client, rpc };
}

it("uses only the running Host's projects even when Web has a different CODEX_HOME", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-host-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const webProject = { id: "web-only", name: "Web only", rootPaths: [root] };
  writeFileSync(
    join(root, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": { "web-only": webProject },
      "app-server-project-id-by-legacy-project-id-by-host": {
        [`local:${root}`]: { "web-only": "native-web-only" },
      },
    }),
  );
  const host = new FakeChChannel();
  host.add("imported", join(root, "host-project"));
  const dataDirectory = join(root, "host-data");
  const directory = join(dataDirectory, "client-hosts");
  const control = await startFakeChChannel(host, directory, "service");
  t.after(() => control.close());
  const client = await createChHostClient({
    directory,
    launch: { launcher: "/unused", runtime: "/unused", dataDirectory, codexHome: root },
  });
  t.after(() => client.close());
  assert.deepEqual(await client.projects(["imported"]), { ...host.projectSnapshot, pinned: [] });
});

it("preserves a busy Host snapshot error in Web history and allows an explicit retry", async (t) => {
  const { host, rpc } = await fixture(t);
  const snapshot = host.snapshot.bind(host);
  let busy = true;
  let reads = 0;
  t.mock.method(host, "snapshot", async (...args: Parameters<typeof snapshot>) => {
    reads++;
    if (busy) throw Object.assign(new Error(busyMessage), { code: -32072 });
    return snapshot(...args);
  });
  const read = () =>
    rpc.dispatch("session/projections", { args: { request: { sessionId: "imported" } } });
  assert.deepEqual(await read(), {
    ok: false,
    error: { code: "host/rejected", message: busyMessage, details: { hostCode: -32072 } },
  });
  assert.equal(reads, 1, "a busy session is not retried automatically");
  busy = false;
  const retried = await read();
  assert.ok(retried.ok);
  const page = await rpc.dispatch("session/page", {
    args: {
      request: {
        address: { sessionId: "imported" },
        throughSeq: (retried.value as { asOfSeq: number }).asOfSeq,
      },
    },
  });
  assert.ok(page.ok);
  assert.match(JSON.stringify(page.value), /existing CH answer/u);
  assert.equal(reads, 2);
  assert.equal(
    host.requests.some(({ method }) => method === "turn/start"),
    false,
  );
});

it("preserves Host error details for ordinary, realtime, and interaction requests", async (t) => {
  const { host, client, rpc } = await fixture(t);
  const realtime = defined(client.realtime);
  t.mock.method(host, "request", async () => {
    throw Object.assign(new Error(busyMessage), { code: -32072 });
  });
  t.mock.method(host, "respond", async () => {
    throw Object.assign(new Error(busyMessage), { code: -32072 });
  });
  const operations = {
    ordinary: () => client.request("turn/start", { threadId: "imported" }),
    realtime: () => realtime.request("turn/start", { threadId: "imported" }),
    response: () =>
      realtime.respond({ epoch: host.epoch, threadId: "imported", requestId: 1, result: {} }),
  };
  for (const [name, operation] of Object.entries(operations)) {
    rpc.register(name, operation);
    assert.deepEqual(await rpc.dispatch(name, {}), {
      ok: false,
      error: { code: "host/rejected", message: busyMessage, details: { hostCode: -32072 } },
    });
  }
});

it("resynchronizes an obsolete Host snapshot before returning Web history", async (t) => {
  const { host, rpc } = await fixture(t);
  const snapshot = host.snapshot.bind(host);
  let reads = 0;
  t.mock.method(host, "snapshot", async (...args: Parameters<typeof snapshot>) => {
    if (++reads === 1)
      throw Object.assign(new Error("Obsolete Host snapshot; resynchronize after reconnecting"), {
        code: -32094,
      });
    return snapshot(...args);
  });
  const result = await rpc.dispatch("session/projections", {
    args: { request: { sessionId: "imported" } },
  });
  assert.ok(result.ok);
  assert.equal((result.value as { values: { title: string } }).values.title, "imported");
  assert.equal(reads, 2);
});
