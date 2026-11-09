import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
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

for (const active of [false, true]) {
  it(`reconciles running=${active} from a fresh read after a missed status notification`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-running-recovery-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("running-recovery", directory);
    row.status = { type: active ? "idle" : "active" };
    const events = new EventHub(directory);
    const sessions = new ChSessions(
      host,
      new Workspaces(new DataDir(directory), directory),
      events,
    );
    t.after(() => sessions.close());
    const rpc = new RpcRegistry();
    const streams = new Streams();
    sessions.register(rpc, streams);
    const notifications: unknown[] = [];
    const history: unknown[] = [];
    const sink = (id: string, frames: unknown[]): StreamSink => {
      let closed = false;
      const cleanups: Array<() => void> = [];
      const result: StreamSink = {
        id,
        get closed() {
          return closed;
        },
        push: (frame) => frames.push(frame),
        onClose: (cleanup) => cleanups.push(cleanup),
        end: () => {
          closed = true;
          for (const cleanup of cleanups.splice(0)) cleanup();
        },
        fail: (code, message) => {
          throw new Error(`${code}: ${message}`);
        },
      };
      t.after(() => result.end());
      return result;
    };
    events.handler({}, sink("events", notifications));
    assert.ok((await rpc.dispatch("session/list", { args: { request: {} } })).ok);
    // Seed an existing view, then miss the Host notification while not following.
    assert.ok(
      (
        await rpc.dispatch("session/projections", {
          args: { request: { sessionId: row.id } },
        })
      ).ok,
    );
    notifications.length = 0;
    row.status = { type: active ? "active" : "idle" };
    // History deliberately remains completed even when the Host is active:
    // running may reflect other native work and must not be inferred from Turn ends.
    const follow = streams.endpoints.get("session/follow");
    assert.ok(follow);
    await follow(
      { request: { address: { sessionId: row.id }, minTurns: 1, minMessages: 1 } },
      sink("follow", history),
    );
    assert.ok(history.some((frame) => (frame as { type: string }).type === "snapshot"));
    assert.deepEqual(
      notifications.filter((frame) => (frame as { event?: string }).event === "api-session/status"),
      [{ type: "emit", event: "api-session/status", args: [row.id, active] }],
    );
  });
}
