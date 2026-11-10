import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createChHostClient, DesktopChHostClient } from "../src/ch-host-client.ts";
import { ChPinnedThreads } from "../src/ch-pinned-threads.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry, type StreamHandler } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { FakeChChannel, startFakeChChannel } from "./support/ch-channel.ts";
import { nativeCodex } from "./support/native-codex.ts";

it("routes pins through the shared Host protocol and does not repeat no-op writes", async (t) => {
  const host = new FakeChHost();
  const debuggerServer = await startFakeChDebugger(host);
  const client = new DesktopChHostClient(debuggerServer.endpoint);
  t.after(async () => {
    client.close();
    await debuggerServer.close();
  });
  // Also prove IDs are JSON data, not executable Renderer source.
  const id = 'canonical-";throw new Error("injected");';
  host.add("other-host-pin", "/project");
  host.add(id, "/project");
  host.pinnedIds = ["other-host-pin"];
  assert.deepEqual(await client.pins(), ["other-host-pin"]);
  assert.deepEqual(await client.pins({ threadId: id, pinned: true }), ["other-host-pin", id]);
  await client.pins({ threadId: id, pinned: true });
  assert.equal(host.pinWrites.length, 1);
  assert.deepEqual(await client.pins({ threadId: id, pinned: false }), ["other-host-pin"]);
  assert.deepEqual(host.pinServiceCalls, [], "never invokes the Renderer pin service");
  assert.ok(host.requests.every((call) => call.method.startsWith("codexhost/thread/pins/")));
});

it("uses Host pin RPC with a main-process request manager that has no runtime", async (t) => {
  const host = new FakeChHost();
  const debuggerServer = await startFakeChDebugger(host, { rpc: true });
  const client = new DesktopChHostClient(debuggerServer.endpoint);
  t.after(async () => {
    client.close();
    await debuggerServer.close();
  });
  host.pinnedIds = ["official"];
  const id = 'external-";throw new Error("injected");';
  host.add("official", "/project");
  host.add(id, "/project");
  assert.deepEqual(await client.pins(), ["official"]);
  assert.deepEqual(await client.pins({ threadId: id, pinned: true }), ["official", id]);
  await client.pins({ threadId: id, pinned: true });
  assert.equal(host.pinWrites.length, 1, "already pinned must not repeat the write");
  assert.deepEqual(await client.pins({ threadId: id, pinned: false }), ["official"]);
  assert.deepEqual(host.pinServiceCalls, []);
  assert.ok(host.requests.every((call) => call.method.startsWith("codexhost/thread/pins/")));
});

it("preserves RPC service refusals and never replays a write after confirmation fails", async (t) => {
  const host = new FakeChHost();
  const debuggerServer = await startFakeChDebugger(host, { rpc: true });
  const client = new DesktopChHostClient(debuggerServer.endpoint);
  t.after(async () => {
    client.close();
    await debuggerServer.close();
  });
  host.pinError = "Native pin refusal";
  await assert.rejects(client.pins({ threadId: "external", pinned: true }), /Native pin refusal/);
  assert.equal(host.pinWrites.length, 0);
  host.pinError = undefined;
  const original = host.pins.bind(host);
  host.pins = async (change) => {
    const ids = await original(change);
    if (change) host.pinError = "confirmation disconnected";
    return ids;
  };
  await assert.rejects(
    client.pins({ threadId: "external", pinned: true }),
    /confirmation disconnected/,
  );
  assert.equal(host.pinWrites.length, 1);
  assert.deepEqual(host.pinnedIds, ["external"]);
});

it("does not require a Renderer pin service", async (t) => {
  const host = new FakeChHost();
  host.add("external", "/project");
  const debuggerServer = await startFakeChDebugger(host, {
    rpc: true,
    pinServiceAvailable: false,
  });
  const client = new DesktopChHostClient(debuggerServer.endpoint);
  t.after(async () => {
    client.close();
    await debuggerServer.close();
  });
  assert.deepEqual(await client.pins({ threadId: "external", pinned: true }), ["external"]);
  assert.deepEqual(host.pinWrites, [{ threadId: "external", pinned: true }]);
  assert.deepEqual(host.pinServiceCalls, []);
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

it("projects only shared external pins, synchronizes changes and never overwrites legacy local records", async (t) => {
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
  assert.deepEqual(frames.findLast((frame) => frame.type === "pinned")?.pinnedSessionIds, [
    "b",
    "a",
  ]);
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

it("projects official and External pins on Web refresh and confirms both pin directions without a Web copy", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-native-pins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  data.writeJson("workspaces.json", {
    items: [],
    archivedSessionIds: [],
    pinnedSessionIds: ["legacy"],
  });
  const host = nativeCodex(new FakeChHost());
  // Reload closes a gateway connection, not the shared Host's durable state.
  host.close = () => {};
  host.add("native-existing", root).modelProvider = "openai";
  host.add("external", root);
  host.pinnedIds = ["native-existing", "external", "remote-only"];
  const open = () => {
    const workspaces = new Workspaces(data, root, true);
    const sessions = new ChSessions(host, workspaces, new EventHub(root));
    const rpc = new RpcRegistry(),
      streams = new StreamRegistry();
    workspaces.register(rpc, streams);
    sessions.register(rpc, streams);
    t.after(() => sessions.close());
    return { workspaces, sessions, rpc };
  };
  const refresh = async (web: ReturnType<typeof open>, expected: string[]) => {
    assert.ok((await web.rpc.dispatch("session/list", { args: {} })).ok);
    // Pin snapshots are published independently of the catalog response.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (JSON.stringify(web.workspaces.pinnedSessionIds()) === JSON.stringify(expected)) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(web.workspaces.pinnedSessionIds(), expected);
  };
  const change = async (web: ReturnType<typeof open>, pinned: boolean) => {
    const result = await web.rpc.dispatch(
      pinned ? "workspace/pinSession" : "workspace/unpinSession",
      {
        args: { request: { sessionId: "native-existing" } },
      },
    );
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value;
  };
  const first = open();
  await refresh(first, ["native-existing", "external"]);
  assert.deepEqual(await change(first, false), { pinnedSessionIds: ["external"] });
  assert.deepEqual(host.pinnedIds, ["external", "remote-only"]);
  assert.deepEqual(await change(first, true), {
    pinnedSessionIds: ["external", "native-existing"],
  });
  assert.deepEqual(host.pinnedIds, ["external", "remote-only", "native-existing"]);
  first.sessions.close();
  const reloaded = open();
  await refresh(reloaded, ["external", "native-existing"]);
  host.pinnedIds = ["external"]; // Desktop unpin.
  await refresh(reloaded, ["external"]);
  host.pinnedIds = ["native-existing", "external"]; // Desktop pin.
  await refresh(reloaded, ["native-existing", "external"]);
  assert.deepEqual(
    data.readJson<{ pinnedSessionIds: string[] }>("workspaces.json", { pinnedSessionIds: [] })
      .pinnedSessionIds,
    ["legacy"],
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
  host.add("new", root);
  const pins = new ChPinnedThreads(host, workspaces);
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

it("pins and unpins through the realtime Host with no Desktop connection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-channel-pins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  host.add("shared", root);
  const channel = await startFakeChChannel(host, root);
  const client = await createChHostClient({ directory: root, cdp: "http://127.0.0.1:1" });
  t.after(async () => {
    client.close();
    await channel.close();
  });
  assert.ok(client.realtime, "Thread traffic must retain the realtime owner");
  assert.deepEqual(await client.pins({ threadId: "shared", pinned: true }), ["shared"]);
  assert.deepEqual(await client.pins(), ["shared"]);
  assert.equal((await client.realtime.snapshot("shared")).thread.id, "shared");
  assert.equal(host.pinWrites.length, 1);
  assert.deepEqual(await client.pins({ threadId: "shared", pinned: false }), []);
});

it("retains persisted local pin records", async (t) => {
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
