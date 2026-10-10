import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { Workspaces } from "../src/workspaces.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { FakeChHost } from "./support/ch-host.ts";

it("broadcasts catalog deltas, not every unchanged Thread on every polling tick", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "ch-catalog-deltas-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  for (let i = 0; i < 100; i++) host.add(`thread-${i}`, "/project");
  const events = new EventHub(root);
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  events.emit = (event, ...args) => {
    emitted.push({ event, args });
  };
  const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const list = () => rpc.dispatch("session/list", { args: {} });
  assert.ok((await list()).ok);
  assert.equal(emitted.length, 0, "initial catalog is delivered once by the list response");
  t.mock.timers.tick(10_000);
  await list();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(emitted.length, 0, "an unchanged catalog must not flood the browser with upserts");

  const changed = host.threads.get("thread-2");
  assert.ok(changed);
  changed.name = "Renamed outside Web"; // same-second metadata change must be noticed
  host.add("added", "/project");
  host.threads.delete("thread-5");
  t.mock.timers.tick(10_000);
  await list();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    emitted
      .filter((e) => e.event === "api-session/added")
      .map((e) => (e.args[0] as { sessionId: string }).sessionId)
      .sort(),
    ["added", "thread-2"],
  );
  assert.deepEqual(
    emitted.filter((e) => e.event === "api-session/removed").map((e) => e.args[0]),
    ["thread-5"],
  );
  emitted.length = 0;
  await list();
  t.mock.timers.tick(10_000);
  await list();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(emitted.length, 0, "ordinary list calls must not cause duplicate rebroadcasts");

  changed.status = { type: "active" };
  const projects = host.projects.bind(host);
  host.projects = async () => {
    throw new Error("metadata temporarily unavailable");
  };
  assert.equal((await list()).ok, false);
  assert.equal(emitted.length, 0, "failed refresh does not advance the published catalog");
  host.projects = projects;
  assert.ok((await list()).ok);
  assert.equal(emitted.length, 1);
  assert.equal((emitted[0]?.args[0] as { running: boolean }).running, true);
});
