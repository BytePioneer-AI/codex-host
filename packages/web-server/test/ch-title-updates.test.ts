import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ChSessions } from "../src/ch-sessions.ts";
import { Workspaces } from "../src/workspaces.ts";
import { DataDir } from "../src/store.ts";
import {
  EventHub,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

class Streams extends StreamRegistry {
  readonly endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler): void {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}
function sink(push: StreamSink["push"]): StreamSink {
  let closed = false;
  const cleanup: Array<() => void> = [];
  return {
    id: "titles",
    get closed() {
      return closed;
    },
    push,
    onClose: (fn) => cleanup.push(fn),
    end: () => {
      closed = true;
      for (const fn of cleanup.splice(0)) fn();
    },
    fail: (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Title update timed out");
    await delay(10);
  }
}

it("updates sequenced titles after unfollow without reading history, including reconnect baselines", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-title-updates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("opened", root, "Old title");
  const cold = host.add("never-opened", root, "Cold title");
  // Previously opened rows require control frames: the browser intentionally
  // does not allow cached list hints to replace a sequenced projection.
  const openedValues = new Map<string, unknown>();
  const coldValues = new Map<string, unknown>();
  const events = new EventHub(root);
  events.emit = (event, ...args) => {
    if (event !== "api-session/added") return;
    const summary = args[0] as {
      sessionId: string;
      projections: { values: Record<string, unknown> };
    };
    if (summary.sessionId === cold.id)
      for (const [key, value] of Object.entries(summary.projections.values))
        coldValues.set(key, value);
  };
  const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new Streams();
  sessions.register(rpc, streams);
  let titleFrames = 0;
  const control = sink((frame) => {
    const value = frame as {
      type: string;
      sessionId: string;
      key: string;
      value: unknown;
      seq: number;
    };
    if (value.type === "projection" && value.sessionId === row.id) {
      openedValues.set(value.key, value.value);
      if (value.key === "title") titleFrames++;
    }
  });
  t.after(() => control.end());
  await streams.endpoints.get("session/control")?.({}, control);
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  const follow = sink(() => {});
  t.after(() => follow.end());
  await streams.endpoints.get("session/follow")?.(
    { request: { address: { sessionId: row.id } } },
    follow,
  );
  assert.equal(openedValues.get("title"), "Old title");
  follow.end();
  await delay(150); // settle the initial hello/catalog refresh
  const snapshots = host.snapshots;
  const historyReads = host.requests.filter((r) => r.method === "thread/turns/list").length;

  row.name = "Codex generated title";
  cold.name = "Cold renamed";
  host.changed(row.id, "thread/name/updated");
  await waitFor(
    () => openedValues.get("title") === row.name && coldValues.get("title") === cold.name,
  );
  assert.equal(host.snapshots, snapshots, "unfollowed titles must not hydrate native history");
  assert.equal(host.requests.filter((r) => r.method === "thread/turns/list").length, historyReads);

  row.name = "";
  row.preview = " First\n prompt ";
  host.changed(row.id, "thread/name/updated");
  await waitFor(() => openedValues.get("title") === "First prompt");
  const frames = titleFrames;
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  assert.equal(titleFrames, frames, "unchanged metadata does not rebroadcast title frames");

  let baseline: unknown;
  const reconnected = sink((frame) => {
    baseline = frame;
  });
  t.after(() => reconnected.end());
  await streams.endpoints.get("session/control")?.({}, reconnected);
  assert.equal(
    (baseline as { value: { projections: Record<string, { values: { title: string } }> } }).value
      .projections[row.id]?.values.title,
    "First prompt",
  );
});
