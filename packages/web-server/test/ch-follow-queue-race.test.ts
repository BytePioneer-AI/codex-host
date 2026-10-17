import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
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

for (const removal of [false, true])
  it(`reconciles queue changes before subscription (removal: ${removal})`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-follow-queue-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("queue-thread", directory);
    const item: NonNullable<ClientThreadSnapshot["queue"]>["items"][number] = {
      id: "queued",
      clientUserMessageId: "input",
      input: [{ type: "text", text: "queued message" }],
      presentationInput: null,
    };
    let queue: NonNullable<ClientThreadSnapshot["queue"]> = {
      pausedReason: null,
      items: removal ? [item] : [],
    };
    const snapshot = host.snapshot.bind(host);
    host.snapshot = async (id) => {
      const captured = structuredClone(queue);
      return { ...(await snapshot(id)), queue: captured };
    };
    const sessions = new ChSessions(
      host,
      new Workspaces(new DataDir(directory), directory),
      new EventHub(directory),
    );
    t.after(() => sessions.close());
    const rpc = new RpcRegistry();
    const streams = new Streams();
    sessions.register(rpc, streams);
    const read = () =>
      rpc.dispatch("session/projections", { args: { request: { sessionId: row.id } } });
    assert.ok((await read()).ok);

    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    host.delaySnapshot = async () => {
      requested.resolve();
      await release.promise;
    };
    // A projection lookup is already reading while this Thread has no follower.
    const reading = read();
    await requested.promise;
    queue = { items: removal ? [] : [item], pausedReason: null };
    host.changed(row.id, "codexhost/thread/queue/updated");

    const frames: Array<{
      type?: string;
      projections?: { values: { inbox: { "next-turn": Array<{ id: string }> } } };
    }> = [];
    const cleanups: Array<() => void> = [];
    let closed = false;
    const sink: StreamSink = {
      id: "follow",
      get closed() {
        return closed;
      },
      push: (frame) => frames.push(frame as (typeof frames)[number]),
      onClose: (cleanup) => cleanups.push(cleanup),
      end: () => {
        closed = true;
        for (const cleanup of cleanups.splice(0)) cleanup();
      },
      fail: (code, message) => {
        throw new Error(`${code}: ${message}`);
      },
    };
    t.after(() => sink.end());
    const follow = streams.endpoints.get("session/follow");
    assert.ok(follow);
    const opening = follow({ request: { address: { sessionId: row.id } } }, sink);
    host.delaySnapshot = undefined;
    release.resolve();
    assert.ok((await reading).ok);
    await opening;
    assert.deepEqual(
      frames
        .find((frame) => frame.type === "snapshot")
        ?.projections?.values.inbox["next-turn"].map((entry) => entry.id),
      removal ? [] : [item.id],
      "opening must reconcile changes that predate the subscription, not reuse the old in-flight snapshot",
    );
  });
