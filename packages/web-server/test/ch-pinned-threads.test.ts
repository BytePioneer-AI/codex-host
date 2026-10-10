import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DesktopChHostClient } from "../src/ch-host-client.ts";
import { ChPinnedThreads } from "../src/ch-pinned-threads.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry, type StreamHandler } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";

it("uses Desktop's local native pin service, preserves read source and does not repeat no-op writes", async (t) => {
  const host = new FakeChHost();
  const debuggerServer = await startFakeChDebugger(host);
  const client = new DesktopChHostClient(debuggerServer.endpoint);
  t.after(async () => {
    client.close();
    await debuggerServer.close();
  });
  // Also prove IDs are JSON data, not executable Renderer source.
  const id = 'canonical-";throw new Error("injected");';
  host.pinnedIds = ["other-host-pin"];
  assert.deepEqual(await client.pins(), ["other-host-pin"]);
  assert.deepEqual(await client.pins({ threadId: id, pinned: true }), ["other-host-pin", id]);
  await client.pins({ threadId: id, pinned: true });
  assert.equal(host.pinWrites.length, 1);
  assert.deepEqual(await client.pins({ threadId: id, pinned: false }), ["other-host-pin"]);
  for (const call of host.pinServiceCalls) {
    assert.equal(call.params.hostId, "local");
    assert.equal(call.params.useAppServerPins, true);
    if (call.method === "list") assert.equal(call.params.preservePinSource, true);
  }
  assert.deepEqual(host.requests, [], "pin service owns native section moves and GUI invalidation");
});

it("does not replay a write when the confirmation snapshot fails", async (t) => {
  const host = new FakeChHost();
  const original = host.pins.bind(host);
  host.pins = async (change) => {
    const ids = await original(change);
    if (change) host.pinError = "confirmation disconnected";
    return ids;
  };
  const debuggerServer = await startFakeChDebugger(host);
  const client = new DesktopChHostClient(debuggerServer.endpoint);
  t.after(async () => {
    client.close();
    await debuggerServer.close();
  });
  await assert.rejects(
    client.pins({ threadId: "canonical", pinned: true }),
    /confirmation disconnected/,
  );
  assert.equal(host.pinWrites.length, 1);
  assert.deepEqual(
    host.pinnedIds,
    ["canonical"],
    "unknown response is not an instruction to undo/retry",
  );
});

it("projects only shared external pins, synchronizes changes and never overwrites standalone records", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-pins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  data.writeJson("workspaces.json", {
    items: [],
    archivedSessionIds: [],
    pinnedSessionIds: ["legacy-web"],
  });
  const host = new FakeChHost();
  host.add("a", "/project");
  host.add("b", "/project");
  host.add("official", "/project").modelProvider = "openai";
  host.pinnedIds = ["official", "b", "a", "remote-only"];
  const workspaces = new Workspaces(data, root, true);
  const sessions = new ChSessions(host, workspaces, new EventHub(root));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry(),
    streams = new StreamRegistry();
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
    pinnedSessionIds?: string[];
    value?: { pinnedSessionIds: string[] };
  }> = [];
  const observe = async () => {
    assert.ok(follow);
    await follow(
      {},
      {
        id: "pins",
        closed: false,
        push: (frame) => frames.push(frame as (typeof frames)[number]),
        end() {},
        fail() {},
        onClose() {},
      },
    );
  };
  await observe();
  assert.deepEqual(
    frames.at(-1)?.value?.pinnedSessionIds,
    [],
    "old Web-only pins are not shown at startup",
  );
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  assert.deepEqual(frames.at(-1)?.pinnedSessionIds, ["b", "a"]);
  const before = frames.length;
  await rpc.dispatch("session/list", { args: {} });
  assert.equal(frames.length, before, "unchanged pins do not rebroadcast");
  host.pinnedIds = ["a", "official", "remote-only"];
  await rpc.dispatch("session/list", { args: {} });
  assert.deepEqual(frames.at(-1)?.pinnedSessionIds, ["a"]);
  const result = await rpc.dispatch("workspace/pinSession", {
    args: { request: { sessionId: "b" } },
  });
  assert.deepEqual(result, { ok: true, value: { pinnedSessionIds: ["a", "b"] } });
  assert.deepEqual(host.pinnedIds, ["a", "official", "remote-only", "b"]);
  assert.deepEqual(
    data.readJson<{ pinnedSessionIds: string[] }>("workspaces.json", { pinnedSessionIds: [] })
      .pinnedSessionIds,
    ["legacy-web"],
  );
  host.pinError = "Native pin service unavailable";
  const failed = await rpc.dispatch("workspace/unpinSession", {
    args: { request: { sessionId: "a" } },
  });
  assert.equal(failed.ok, false);
  await rpc.dispatch("session/list", { args: {} });
  await observe();
  assert.deepEqual(
    frames.at(-1)?.value?.pinnedSessionIds,
    ["a", "b"],
    "errors and reconnect retain confirmed pins",
  );
  host.pinError = undefined;
  const writes = host.pinWrites.length;
  assert.equal(
    (await rpc.dispatch("workspace/pinSession", { args: { request: { sessionId: "official" } } }))
      .ok,
    false,
  );
  assert.equal(host.pinWrites.length, writes);
  const draft = await rpc.dispatch("session/create", { args: { request: { cwd: root } } });
  assert.ok(draft.ok);
  const sessionId = (draft.value as { sessionId: string }).sessionId;
  assert.equal(
    (await rpc.dispatch("workspace/pinSession", { args: { request: { sessionId } } })).ok,
    false,
  );
  assert.equal(
    host.requests.some((r) => r.method === "thread/start"),
    false,
  );
});

it("serializes polling with pin changes so a slow old snapshot cannot undo a confirmed command", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-pins-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  const workspaces = new Workspaces(new DataDir(root), root);
  const observed: string[][] = [];
  workspaces.setReferencePins = (ids) => {
    observed.push([...ids]);
  };
  const pins = new ChPinnedThreads(host, workspaces, () => true);
  const read = Promise.withResolvers<string[]>();
  const original = host.pins.bind(host);
  host.pins = (change) => (change ? original(change) : read.promise);
  const poll = pins.sync();
  const write = pins.sync({ threadId: "new", pinned: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.pinWrites.length, 0);
  read.resolve(["old"]);
  await poll;
  await write;
  assert.deepEqual(observed, [[], ["old"], ["new"]]);
  host.pinError = "refused";
  await assert.rejects(pins.sync({ threadId: "new", pinned: false }), /refused/);
  assert.deepEqual(observed.at(-1), ["new"]);
  host.pinError = undefined;
  await pins.sync({ threadId: "new", pinned: false });
  assert.deepEqual(observed.at(-1), []);
});

it("standalone mode retains local pin persistence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "local-pins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root),
    rpc = new RpcRegistry();
  new Workspaces(data, root).register(rpc, new StreamRegistry());
  assert.deepEqual(
    await rpc.dispatch("workspace/pinSession", { args: { request: { sessionId: "local" } } }),
    { ok: true, value: { pinnedSessionIds: ["local"] } },
  );
  assert.deepEqual(
    data.readJson<{ pinnedSessionIds: string[] }>("workspaces.json", { pinnedSessionIds: [] })
      .pinnedSessionIds,
    ["local"],
  );
});
