import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function setup(t: TestContext, host: FakeChHost = new FakeChChannel()) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const tick = async (ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
    await settle();
  };
  const root = mkdtempSync(join(tmpdir(), "ch-refresh-"));
  const row = host.add("thread", join(root, "a"));
  const workspaces = new Workspaces(new DataDir(root), root);
  const events = new EventHub(root);
  const sessions = new ChSessions(host, workspaces, events);
  t.after(async () => {
    await sessions.close();
    rmSync(root, { recursive: true, force: true });
  });
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const list = () => rpc.dispatch("session/list", { args: {} });
  assert.ok((await list()).ok);
  await tick(100);
  host.requests.length = 0;
  const directoryReads = () => host.requests.filter((r) => r.method === "thread/list");
  return { host, row, workspaces, sessions, rpc, events, tick, list, directoryReads, root };
}

it("keeps project and pin synchronization without rescanning the event catalog every ten seconds", async (t) => {
  const b = await setup(t);
  b.host.projectSnapshot.projects.push({ id: "b", name: "B", rootPaths: [join(b.root, "b")] });
  b.host.projectSnapshot.assignments.thread = "b";
  b.host.pinnedIds = ["thread"];
  await b.tick(10_000);
  assert.equal(b.directoryReads().length, 0);
  assert.equal(
    b.host.requests.some((r) => r.method === "codexhost/thread/ownership/list"),
    false,
  );
  assert.equal(b.workspaces.ownerOf("thread")?.path, join(b.root, "b"));
  assert.equal(b.row.cwd, join(b.root, "a"));
  assert.deepEqual(b.workspaces.pinnedSessionIds(), ["thread"]);

  b.host.add("missed-notification", join(b.root, "c"));
  for (let i = 0; i < 4; i++) await b.tick(10_000);
  assert.equal(b.directoryReads().length, 0);
  await b.tick(10_000);
  assert.equal(
    b.directoryReads().length,
    2,
    "a complete active/archive check remains every minute",
  );
  assert.ok(b.workspaces.ownerOf("missed-notification"));
});

it("refreshes on lifecycle notifications and reconnect instead of waiting for the fallback", async (t) => {
  const host = new FakeChChannel();
  const b = await setup(t, host);
  for (const method of [
    "turn/started",
    "turn/completed",
    "thread/started",
    "thread/name/updated",
    "thread/archived",
    "thread/unarchived",
  ]) {
    host.requests.length = 0;
    host.changed("thread", method);
    await b.tick(100);
    assert.equal(b.directoryReads().length, 2, method);
  }
  host.connection(false);
  await b.tick(60_000);
  host.requests.length = 0;
  host.add("while-offline", b.root);
  host.connection(true);
  await b.tick(100);
  assert.equal(b.directoryReads().length, 2);
  assert.ok(b.workspaces.ownerOf("while-offline"));
});

it("waits for an organization read before satisfying a concurrent full refresh", async (t) => {
  const b = await setup(t);
  const projects = b.host.projects.bind(b.host);
  let release = () => {};
  let reads = 0;
  b.host.projects = async () => {
    reads++;
    if (reads === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return projects();
  };
  await b.tick(10_000);
  const full = b.list();
  await settle();
  assert.equal(b.directoryReads().length, 0);
  await b.tick(10_000);
  assert.equal(reads, 1, "a pending organization read does not overlap another poll");
  release();
  assert.ok((await full).ok);
  assert.equal(b.directoryReads().length, 2);
  assert.equal(reads, 2, "the requested full refresh still reads its own current snapshot");
});

it("retains confirmed organization on failure and ignores a read after close", async (t) => {
  const b = await setup(t);
  const original = b.host.projects.bind(b.host);
  b.host.projects = async () => {
    throw new Error("project metadata unavailable");
  };
  const owner = b.workspaces.ownerOf("thread");
  await b.tick(10_000);
  assert.deepEqual(b.workspaces.ownerOf("thread"), owner);
  assert.equal(b.directoryReads().length, 0);
  b.host.projects = original;
  b.host.pinnedIds = ["thread"];
  await b.tick(10_000);
  assert.deepEqual(b.workspaces.pinnedSessionIds(), ["thread"]);

  let release = () => {};
  b.host.projects = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { projects: [], assignments: {}, projectless: ["thread"] };
  };
  await b.tick(10_000);
  await b.sessions.close();
  release();
  await settle();
  assert.deepEqual(b.workspaces.ownerOf("thread"), owner);
  b.host.requests.length = 0;
  await b.tick(60_000);
  assert.equal(b.host.requests.length, 0);
});

it("keeps the ten-second full catalog check for legacy CDP", async (t) => {
  const b = await setup(t, new FakeChHost());
  await b.tick(10_000);
  assert.equal(b.directoryReads().length, 2);
  assert.ok(b.host.requests.some((r) => r.method === "codexhost/thread/ownership/list"));
});

it("publishes confirmed catalog changes before an optional pin service answers", async (t) => {
  const b = await setup(t);
  const emitted: unknown[] = [];
  b.events.emit = (event, ...args) => {
    if (event === "api-session/added") emitted.push(args[0]);
  };
  let release = () => {};
  b.host.pins = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return [];
  };
  b.row.name = "Updated";
  const full = b.list();
  await settle();
  assert.equal(emitted.length, 1);
  release();
  assert.ok((await full).ok);
});
