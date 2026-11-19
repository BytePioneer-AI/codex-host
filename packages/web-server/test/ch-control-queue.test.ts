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

for (const closeWhileOpening of [false, true])
  it(`orders control baseline before queue updates (closed while opening: ${closeWhileOpening})`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-control-queue-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("queue-thread", directory);
    let queue: ClientThreadSnapshot["queue"] = {
      pausedReason: null,
      items: [
        {
          id: "queued",
          clientUserMessageId: "gui-input",
          input: [{ type: "text", text: "111" }],
          presentationInput: null,
        },
      ],
    };
    const snapshot = host.snapshot.bind(host);
    host.snapshot = async (id) => ({ ...(await snapshot(id)), queue: structuredClone(queue) });
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
    assert.ok((await rpc.dispatch("session/create", { args: { request: { cwd: directory } } })).ok);

    // A pending draft lookup yields while a reconnecting control stream opens.
    const gate = Promise.withResolvers<undefined>();
    const inspect = sessions.catalog.inspect.bind(sessions.catalog);
    sessions.catalog.inspect = async (...args) => {
      await gate.promise;
      return inspect(...args);
    };
    const frames: Array<Record<string, unknown>> = [];
    const cleanups: Array<() => void> = [];
    let closed = false;
    const sink: StreamSink = {
      id: "control",
      get closed() {
        return closed;
      },
      push: (frame) => frames.push(frame as Record<string, unknown>),
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
    const opening = streams.endpoints.get("session/control")?.({}, sink);
    // The queue has changed before the initial baseline is ready. This must be
    // included in that baseline, never delivered as a pre-baseline delta.
    if (closeWhileOpening) sink.end();
    queue = { items: [], pausedReason: null };
    assert.ok((await read()).ok);
    gate.resolve(undefined);
    await opening;
    if (closeWhileOpening) {
      host.connection(false);
      assert.deepEqual(
        frames,
        [],
        "closed streams must not be registered after asynchronous preparation",
      );
      return;
    }
    assert.equal(frames[0]?.type, "baseline", "a pre-baseline update kills RemoteSnapshotStream");
    const baseline = frames[0]?.value as {
      projections: Record<string, { values: { inbox: { "next-turn": unknown[] } } }>;
    };
    assert.deepEqual(baseline.projections[row.id]?.values.inbox["next-turn"], []);
    queue = {
      pausedReason: null,
      items: [
        {
          id: "later",
          clientUserMessageId: "later-input",
          input: [{ type: "text", text: "later" }],
          presentationInput: null,
        },
      ],
    };
    assert.ok((await read()).ok);
    queue = { items: [], pausedReason: null };
    assert.ok((await read()).ok);
    assert.deepEqual(
      frames.filter((frame) => frame.type === "projection" && frame.key === "inbox").at(-1)?.value,
      { "next-turn": [], "next-step": [] },
    );
  });
