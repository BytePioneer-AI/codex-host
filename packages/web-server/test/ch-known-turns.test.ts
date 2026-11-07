/** Skipping unchanged completed Turns: merge, fallback, old Host and Host generation. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FakeChChannel } from "./support/ch-channel.ts";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import type { ChTurn } from "../src/ch-thread-view.ts";
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

function turn(index: number): ChTurn {
  return {
    id: `turn-${index}`,
    status: "completed",
    startedAt: 1_700_000_000 + index * 120,
    completedAt: 1_700_000_045 + index * 120,
    items: [
      { id: `user-${index}`, type: "userMessage", content: [{ type: "text", text: `Q${index}` }] },
      { id: `tool-${index}`, type: "commandExecution", command: "ls", aggregatedOutput: "out" },
      { id: `agent-${index}`, type: "agentMessage", text: `A${index}` },
    ],
  };
}
function fixture(count = 7) {
  const host = new FakeChChannel();
  const row = host.add("thread", "/project");
  row.turns = Array.from({ length: count }, (_, index) => turn(index));
  const view = new ChThreadHistory(host, row, "fake", () => {});
  return { host, row, view };
}
const userMessages = (view: ChThreadHistory) =>
  view.log.events.filter((event) => event.type === "user/message").length;

it("asks for fingerprints first, then skips completed Turns it already holds", async () => {
  const { host, row, view } = fixture();
  await view.refresh();
  assert.equal(host.snapshotOptions.length, 1);
  assert.deepEqual(host.snapshotOptions[0], { knownTurns: [] });
  assert.deepEqual(host.snapshotPlaceholders, [0]);
  assert.deepEqual(
    view.thread.turns.map((value) => value.id),
    row.turns.slice(-5).map((value) => value.id),
  );
  assert.ok(view.thread.turns.every((value) => value.fingerprint));

  row.turns.push(turn(7));
  await view.refresh(true);
  assert.deepEqual(
    host.snapshotOptions[1]?.knownTurns?.map((known) => known.id),
    ["turn-2", "turn-3", "turn-4", "turn-5", "turn-6"],
  );
  assert.deepEqual(host.snapshotPlaceholders, [0, 4]);
  // Placeholders resolve to the held Turns; only the new one is projected.
  assert.deepEqual(
    view.thread.turns.map((value) => value.id),
    ["turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7"],
  );
  assert.ok(view.thread.turns.every((value) => value.items.length === 3));
  assert.equal(userMessages(view), 6);
  assert.deepEqual(view.ownerSnapshot?.turnsPage.data.map((value) => value.id).reverse(), [
    "turn-3",
    "turn-4",
    "turn-5",
    "turn-6",
    "turn-7",
  ]);
  assert.ok(view.ownerSnapshot?.turnsPage.data.every((value) => value.items.length === 3));
});

it("re-sends and applies a completed Turn whose content changed", async () => {
  const { host, row, view } = fixture();
  await view.refresh();
  const edited = row.turns.at(-1);
  assert.ok(edited);
  // A late native refresh may add an Item to a settled Turn.
  edited.items.push({ id: "late", type: "agentMessage", text: "late" });
  await view.refresh(true);
  assert.deepEqual(host.snapshotPlaceholders, [0, 4]);
  assert.equal(view.thread.turns.at(-1)?.items.length, 4);
});

it("reads a full snapshot again when a placeholder does not match the held Turn", async () => {
  const { host, row, view } = fixture();
  await view.refresh();
  host.forgeUnchanged = true;
  row.turns.push(turn(7));
  await view.refresh(true);
  assert.deepEqual(
    host.snapshotOptions.map((options) => options.knownTurns?.length),
    [0, 5, 0],
  );
  // The fallback replies are full Turns and the new Turn is still projected once.
  assert.deepEqual(
    view.thread.turns.map((value) => value.id),
    ["turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7"],
  );
  assert.equal(userMessages(view), 6);
});

it("fails instead of trusting placeholders when it asked for none", async () => {
  const { host, view } = fixture();
  host.forgeUnchanged = true;
  const first = host.snapshot.bind(host);
  host.snapshot = async (id, options) => {
    // A Host that answers even an empty request with placeholders is invalid.
    const value = await first(id, options);
    value.turnsPage.data = value.turnsPage.data.map((value) => ({ ...value, unchanged: true }));
    return value;
  };
  await assert.rejects(view.refresh(), /not asked/);
});

it("keeps working against an older Host that ignores knownTurns", async () => {
  const { host, row, view } = fixture();
  host.supportsKnownTurns = false;
  await view.refresh();
  row.turns.push(turn(7));
  await view.refresh(true);
  assert.deepEqual(host.snapshotPlaceholders, [0, 0]);
  assert.ok(view.thread.turns.every((value) => value.fingerprint === undefined));
  assert.deepEqual(
    host.snapshotOptions.map((options) => options.knownTurns?.length),
    [0, 0],
  );
  assert.equal(userMessages(view), 6);
});

it("forgets held fingerprints so the next read is a full snapshot", async () => {
  const { host, row, view } = fixture();
  await view.refresh();
  view.forgetKnownTurns();
  row.turns.push(turn(7));
  await view.refresh(true);
  assert.equal(host.snapshotOptions[1]?.knownTurns?.length, 0);
  assert.deepEqual(host.snapshotPlaceholders, [0, 0]);
  assert.equal(userMessages(view), 6);
});

class Streams extends StreamRegistry {
  endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler): void {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}
function sink(): StreamSink {
  let closed = false;
  return {
    id: "test",
    get closed() {
      return closed;
    },
    push: () => {},
    end() {
      closed = true;
    },
    fail(code, message) {
      throw new Error(`${code}: ${message}`);
    },
    onClose: () => {},
  };
}
async function wait(check: () => boolean) {
  const until = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > until) throw new Error("Known-Turn assertion timed out");
    await delay(10);
  }
}

it("drops held Turns on a new Host generation and on a non-replayable reconnect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-known-turns-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  host.add("thread", root).turns = Array.from({ length: 3 }, (_, index) => turn(index));
  const events = new EventHub(root),
    sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events),
    rpc = new RpcRegistry(),
    streams = new Streams();
  t.after(() => sessions.close());
  sessions.register(rpc, streams);
  await rpc.dispatch("session/list", { args: {} });
  const follower = sink();
  await streams.endpoints.get("session/follow")?.(
    { request: { address: { sessionId: "thread" } } },
    follower,
  );
  await wait(() => host.snapshotOptions.length > 0);
  const known = () => host.snapshotOptions.at(-1)?.knownTurns?.length;

  host.changed("thread");
  await wait(() => host.snapshotOptions.length > 1);
  assert.equal(known(), 3, "an ordinary invalidation reuses the held Turns");

  // Same Host, cursor not replayable: reset=true makes the next read full.
  const afterChange = host.snapshotOptions.length;
  host.connection(false);
  host.connection(true);
  await wait(() => host.snapshotOptions.length > afterChange);
  assert.equal(known(), 0);

  host.changed("thread");
  await wait(() => host.snapshotOptions.length > afterChange + 1);
  assert.equal(known(), 3);

  // A new Host generation retires the view and its fingerprints.
  const beforeGeneration = host.snapshotOptions.length;
  host.epoch = randomUUID();
  host.connection(false);
  host.connection(true);
  await wait(() => host.snapshotOptions.length > beforeGeneration);
  assert.equal(known(), 0);
  assert.ok(host.snapshotPlaceholders.at(-1) === 0);
  follower.end();
});
