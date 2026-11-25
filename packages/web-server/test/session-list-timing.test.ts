import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { compressResponse } from "../src/compression.ts";
import { SessionListTiming } from "../src/session-list-timing.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

interface Diagnostic {
  rpcId: string;
  ok: boolean;
  totalMs: number;
  responseBytes: number;
  encodedBytes?: number;
  stages: Record<string, { ms: number; calls: number; maxMs: number }>;
  counts: Record<string, number>;
  catalog?: {
    mode: "started" | "joined";
    stages: Diagnostic["stages"];
    counts: Diagnostic["counts"];
  };
}

function fixture(t: TestContext, trace = true) {
  const previous = process.env.CODEXHOST_TRACE_SESSION_LIST;
  if (trace) process.env.CODEXHOST_TRACE_SESSION_LIST = "1";
  else delete process.env.CODEXHOST_TRACE_SESSION_LIST;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEXHOST_TRACE_SESSION_LIST;
    else process.env.CODEXHOST_TRACE_SESSION_LIST = previous;
  });
  const root = mkdtempSync(join(tmpdir(), "ch-list-timing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  const diagnostics = () =>
    lines.map((line) => {
      assert.ok(line.startsWith("[session/list] "));
      return JSON.parse(line.slice("[session/list] ".length)) as Diagnostic;
    });
  const list = (rpcId: string, onTiming?: (timing: SessionListTiming, ok: boolean) => void) =>
    rpc.handleHttp(
      JSON.stringify({
        type: "client-request",
        rpcId,
        method: "session/list",
        payload: { args: { _request: {} } },
      }),
      undefined,
      undefined,
      false,
      onTiming,
    );
  return { host, sessions, rpc, root, lines, diagnostics, list };
}

it("keeps Server-Timing without opt-in JSON logs and still reports failed requests", async (t) => {
  const f = fixture(t, false);
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  f.host.add("private", f.root);
  await f.list("default", (timing, ok) => {
    assert.equal(ok, true);
    assert.match(timing.serverTiming(), /catalog_host_catalog;dur=/);
    assert.match(timing.serverTiming(), /serialize;dur=/);
    timing.report(ok);
  });
  assert.deepEqual(f.lines, []);
  assert.deepEqual(errors, []);
  f.host.request = async () => {
    throw new RpcError("host/offline", "Sensitive upstream error");
  };
  const reply = JSON.parse(await f.list("failed-default"));
  assert.equal(reply.result.error.code, "host/offline");
  assert.deepEqual(f.lines, []);
  assert.deepEqual(errors, ["[session/list] request failed"]);
});

it("accumulates monotonic durations and slowest calls, including failures", async () => {
  let now = 10;
  const timing = new SessionListTiming("clock", () => now);
  await timing.measure("host_catalog", async () => {
    now += 25;
  });
  await assert.rejects(
    timing.measure("host_catalog", async () => {
      now += 15;
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.throws(() =>
    timing.measureSync("workspace_sync", () => {
      now += 5;
      throw new Error("failed");
    }),
  );
  timing.count("ownershipIds", 100);
  timing.count("ownershipIds", 20);
  const snapshot = timing.snapshot();
  assert.equal(snapshot.totalMs, 45);
  assert.deepEqual(snapshot.stages.host_catalog, { ms: 40, calls: 2, maxMs: 25 });
  assert.deepEqual(snapshot.stages.workspace_sync, { ms: 5, calls: 1, maxMs: 5 });
  assert.equal(snapshot.counts.ownershipIds, 120);
  assert.match(timing.serverTiming(), /host_catalog;dur=40/);
});

it("reports the aggregate Host request, UTF-8 bytes and HTTP compression without logging metadata", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 206; i++) f.host.add(`private-id-${i}`, f.root, "私密标题", false);
  f.host.archivedIds.add("private-id-205");
  let timing: SessionListTiming | undefined;
  const reply = await f.list("list-pages", (value, ok) => {
    timing = value;
    assert.equal(ok, true);
  });
  assert.ok(timing);
  assert.equal(f.lines.length, 0, "HTTP completion owns the single diagnostic log");
  const compressed = await timing.measure("compress", () =>
    compressResponse(Buffer.from(reply), "application/json", "gzip"),
  );
  assert.match(timing.serverTiming(), /catalog_host_catalog;dur=/);
  assert.match(timing.serverTiming(), /serialize;dur=/);
  assert.match(timing.serverTiming(), /compress;dur=/);
  timing.report(true, compressed.body.length);
  const [log] = f.diagnostics();
  assert.equal(f.lines.length, 1);
  assert.ok(log?.catalog);
  assert.equal(log.rpcId, "list-pages");
  assert.equal(log.catalog.mode, "started");
  assert.equal(log.catalog.stages.host_catalog?.calls, 1);
  assert.equal(log.catalog.stages.projects?.calls, 1);
  assert.equal(log.catalog.stages.workspace_sync?.calls, 1);
  assert.equal(log.catalog.stages.archive_sync?.calls, 1);
  assert.equal(log.catalog.stages.catalog_publish?.calls, 1);
  assert.equal(log.catalog.counts.unarchivedRows, 205);
  assert.equal(log.catalog.counts.archivedRows, 0);
  assert.equal(log.catalog.counts.ownershipIds, 205);
  assert.equal(log.counts.resultRows, 205);
  assert.equal(log.responseBytes, Buffer.byteLength(reply));
  assert.equal(log.encodedBytes, compressed.body.length);
  assert.ok(log.responseBytes > reply.length, "UTF-8 bytes are not character counts");
  assert.ok(log.encodedBytes < log.responseBytes);
  assert.equal(JSON.parse(reply).result.value.items.length, 205);
  assert.ok(f.lines.every((line) => !/private-id|私密标题/.test(line) && !line.includes(f.root)));
});

for (const background of [false, true]) {
  it(`preserves shared catalog timings when joining a ${background ? "background" : "browser"} refresh`, async (t) => {
    const f = fixture(t);
    f.host.add("private", f.root);
    const entered = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    const request = f.host.request.bind(f.host);
    let blocked = false;
    f.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "codexhost/thread/catalog/read" && !blocked) {
        blocked = true;
        entered.resolve(undefined);
        await gate.promise;
      }
      return request<T>(method, params);
    };
    const first = background ? f.sessions["refresh"]() : f.list("first");
    await entered.promise;
    const second = f.list("second");
    gate.resolve(undefined);
    await Promise.all([first, second]);
    const logs = f.diagnostics();
    assert.equal(logs.length, background ? 1 : 2);
    const joined = logs.find((log) => log.rpcId === "second");
    assert.equal(joined?.catalog?.mode, "joined");
    assert.equal(joined.catalog.stages.host_catalog?.calls, 1);
    assert.equal(joined.stages.catalog_wait?.calls, 1);
    assert.equal(
      f.host.requests.filter(({ method }) => method === "codexhost/thread/catalog/read").length,
      1,
    );
    if (!background) {
      const started = logs.find((log) => log.rpcId === "first");
      assert.equal(started?.catalog?.mode, "started");
      assert.deepEqual(joined.catalog.stages, started.catalog.stages);
    }
  });
}

it("separates workspace-only waiting from catalog work", async (t) => {
  const f = fixture(t);
  f.host.add("thread", f.root);
  const gate = Promise.withResolvers<undefined>();
  f.sessions["refreshing"] = gate.promise.finally(() => {
    f.sessions["refreshing"] = undefined;
  });
  const pending = f.list("workspace-wait");
  assert.equal(f.host.requests.length, 0);
  gate.resolve(undefined);
  await pending;
  const [log] = f.diagnostics();
  assert.equal(log?.stages.workspace_wait?.calls, 1);
  assert.equal(log.catalog?.mode, "started");
  assert.equal(log.stages.catalog_wait?.calls, 1);
});

it("logs a failed phase once, preserves the RPC error, and leaves unrelated RPCs uninstrumented", async (t) => {
  const f = fixture(t);
  f.host.add("thread", f.root);
  const request = f.host.request.bind(f.host);
  f.host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/thread/catalog/read")
      throw new RpcError("host/offline", "Sensitive error text");
    return request<T>(method, params);
  };
  const reply = JSON.parse(await f.list("failed"));
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, "host/offline");
  const [log] = f.diagnostics();
  assert.equal(log?.ok, false);
  assert.equal(log.catalog?.stages.host_catalog?.calls, 1);
  assert.equal(log.stages.summaries, undefined);
  assert.equal(log.stages.serialize?.calls, 1);
  assert.equal(f.lines.length, 1);
  assert.ok(!f.lines[0]?.includes("Sensitive error text"));
  f.host.request = request;
  assert.equal(JSON.parse(await f.list("recovered")).result.ok, true);
  assert.equal(f.diagnostics()[1]?.catalog?.mode, "started");
  f.rpc.register("other", (_args, context) => {
    assert.equal(context.sessionListTiming, undefined);
    return 123;
  });
  const other = JSON.parse(
    await f.rpc.handleHttp(JSON.stringify({ rpcId: "other", method: "other" })),
  );
  assert.equal(other.result.value, 123);
  assert.equal(f.lines.length, 2);
});
