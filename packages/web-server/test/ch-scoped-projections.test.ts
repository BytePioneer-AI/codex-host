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
import { defined } from "./support/defined.ts";

class Streams extends StreamRegistry {
  readonly endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler): void {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}

interface Frame {
  type: string;
  sessionId?: string;
  key?: string;
  value?: unknown;
  seq?: number;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
}

function record() {
  const frames: Frame[] = [];
  const cleanups: Array<() => void> = [];
  let closed = false;
  const sink: StreamSink = {
    id: "test",
    get closed() {
      return closed;
    },
    push: (frame) => frames.push(structuredClone(frame) as Frame),
    onClose: (cleanup) => cleanups.push(cleanup),
    end: () => {
      closed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    fail: (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  };
  return { frames, sink };
}

it("scopes heavy projections to every follower, excludes control deltas/baselines, and reopens with latest values", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ch-scoped-projections-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const a = host.add("a", directory, "Session A");
  const b = host.add("b", directory, "Session B");
  const file = (path: string) => ({
    path,
    kind: { type: "update", move_path: null },
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  });
  const changes = {
    id: "files",
    type: "fileChange",
    status: "inProgress",
    changes: [file("a.ts")],
  };
  const command = {
    id: "command",
    type: "commandExecution",
    status: "inProgress",
    command: "echo progress",
    aggregatedOutput: "first output",
  };
  b.status = { type: "active" };
  b.turns = [
    {
      id: "live",
      status: "inProgress",
      codexhostFileOperations: [],
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "edit files" }] },
        changes,
        command,
      ],
    },
  ];
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(directory), directory),
    new EventHub(directory),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new Streams();
  sessions.register(rpc, streams);
  const read = async () =>
    assert.ok(
      (await rpc.dispatch("session/projections", { args: { request: { sessionId: b.id } } })).ok,
    );
  const open = async (endpoint: string, sessionId?: string) => {
    const recording = record();
    t.after(() => recording.sink.end());
    await defined(streams.endpoints.get(endpoint))(
      sessionId ? { request: { address: { sessionId } } } : {},
      recording.sink,
    );
    return recording;
  };
  await read();
  const list = await rpc.dispatch("session/list", { args: {} });
  assert.ok(list.ok);
  assert.equal(/codexhostTurnChanges|codexhostToolOutput/u.test(JSON.stringify(list)), false);
  const controlA = await open("session/control");
  const controlB = await open("session/control");
  const followA = await open("session/follow", a.id);
  const followB1 = await open("session/follow", b.id);
  const followB2 = await open("session/follow", b.id);
  const initial = defined(followB1.frames[0]?.projections);
  assert.ok(JSON.stringify(initial.values.codexhostTurnChanges).includes("a.ts"));
  assert.ok(JSON.stringify(initial.values.codexhostToolOutput).includes("first output"));

  changes.changes.push(file("b.ts"));
  command.aggregatedOutput = "second output";
  b.name = "Renamed B";
  await read();
  for (const follow of [followB1, followB2]) {
    const deltas = follow.frames.filter((frame) => frame.type === "projection");
    assert.deepEqual(
      deltas.map((frame) => frame.key),
      ["codexhostToolOutput", "codexhostTurnChanges"],
    );
    assert.ok(deltas.every((frame) => frame.sessionId === b.id && frame.seq === initial.asOfSeq));
    assert.ok(JSON.stringify(deltas[0]?.value).includes("second output"));
    assert.ok(JSON.stringify(deltas[1]?.value).includes("b.ts"));
  }
  // An unchanged projection still uses the existing per-key deduplication.
  const count = followB1.frames.length;
  await read();
  assert.equal(followB1.frames.length, count);
  host.connection(false);
  for (const control of [controlA, controlB]) {
    assert.ok(control.frames.some((frame) => frame.key === "title" && frame.value === "Renamed B"));
    assert.ok(
      control.frames.some(
        (frame) =>
          frame.key === "nativeConnection" && JSON.stringify(frame.value).includes("reconnecting"),
      ),
    );
    const baseline = control.frames[0]?.value as {
      projections: Record<string, { values: Record<string, unknown> }>;
    };
    for (const block of Object.values(baseline.projections)) {
      assert.equal(Object.hasOwn(block.values, "codexhostTurnChanges"), false);
      assert.equal(Object.hasOwn(block.values, "codexhostToolOutput"), false);
    }
    assert.equal(
      control.frames.some(
        (frame) => frame.key === "codexhostTurnChanges" || frame.key === "codexhostToolOutput",
      ),
      false,
    );
  }
  assert.equal(
    followA.frames.some((frame) => frame.type === "projection"),
    false,
  );
  followB1.sink.end();
  followB2.sink.end();
  host.connection(true);
  changes.changes.push(file("c.ts"));
  command.aggregatedOutput = "latest output";
  await read();
  assert.equal(followB1.frames.length, count);
  const reopened = await open("session/follow", b.id);
  const latest = defined(reopened.frames[0]?.projections);
  assert.equal(
    latest.asOfSeq,
    initial.asOfSeq,
    "projection-only changes do not advance the journal",
  );
  assert.ok(JSON.stringify(latest.values.codexhostTurnChanges).includes("c.ts"));
  assert.ok(JSON.stringify(latest.values.codexhostToolOutput).includes("latest output"));
  // Reconnecting another control subscriber must not leak the loaded history either.
  const reconnected = await open("session/control");
  assert.equal(JSON.stringify(reconnected.frames).includes("codexhostTurnChanges"), false);
  assert.equal(JSON.stringify(reconnected.frames).includes("codexhostToolOutput"), false);
});
