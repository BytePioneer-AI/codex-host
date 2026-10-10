import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientInteraction } from "@codexhost/shared-contracts";
import { FakeChChannel } from "./support/ch-channel.ts";
import { defined } from "./support/defined.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { ChThreadView } from "../src/ch-thread-view.ts";
import { randomUUID } from "node:crypto";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import {
  EventHub,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";

class Streams extends StreamRegistry {
  endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler): void {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}
function sink() {
  const frames: unknown[] = [];
  const cleanup: Array<() => void> = [];
  let closed = false;
  const sink: StreamSink = {
    id: "test",
    get closed() {
      return closed;
    },
    push: (value) => frames.push(value),
    end() {
      closed = true;
      for (const stop of cleanup) stop();
    },
    fail(code, message) {
      throw new Error(`${code}: ${message}`);
    },
    onClose: (fn) => cleanup.push(fn),
  };
  return { frames, sink };
}
async function wait(check: () => boolean) {
  const until = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > until) throw new Error("Realtime assertion timed out");
    await delay(10);
  }
}

it("coalesces changes, reconciles a change during snapshot read, and stops reading after unfollow", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-realtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel(),
    row = host.add("thread", root);
  const events = new EventHub(root),
    sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events),
    rpc = new RpcRegistry(),
    streams = new Streams();
  t.after(() => sessions.close());
  sessions.register(rpc, streams);
  await rpc.dispatch("session/list", { args: {} });
  const follow = sink();
  await streams.endpoints.get("session/follow")?.(
    { request: { address: { sessionId: "thread" } } },
    follow.sink,
  );
  let release: () => void = () => {};
  let blocked = false;
  host.delaySnapshot = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      blocked = true;
    });
  host.changed("thread");
  await wait(() => blocked);
  row.turns.push({
    id: "live",
    status: "inProgress",
    items: [
      { type: "userMessage", id: "user-live", content: [{ type: "text", text: "second" }] },
      { type: "agentMessage", id: "agent-live", text: "during read" },
    ],
  });
  row.status = { type: "active" };
  for (let n = 0; n < 100; n++) host.changed("thread");
  host.delaySnapshot = undefined;
  release();
  await wait(() => JSON.stringify(follow.frames).includes("during read"));
  assert.ok(host.snapshots <= 4, `Expected coalesced reads, got ${host.snapshots}`);
  const count = host.snapshots;
  await delay(1650);
  assert.equal(host.snapshots, count, "No 1.5 second history polling in event mode");
  follow.sink.end();
  host.changed("thread");
  await delay(150);
  assert.equal(host.snapshots, count);
});

it("withdraws cross-client approvals and restores only current pending interactions after reconnect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-interactions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  host.add("thread", root);
  const approval: ClientInteraction = {
    requestId: -42,
    threadId: "thread",
    kind: "approval",
    interaction: {
      type: "approval",
      title: "Run native tool?",
      actions: [
        { id: "once", label: "Allow once", effect: "allowOnce" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    },
    request: {
      method: "mcpServer/elicitation/request",
      params: { requestedSchema: { type: "object", properties: {} } },
    },
  };
  host.pending = [approval];
  const events = new EventHub(root),
    a = sink(),
    b = sink();
  events.handler({}, a.sink);
  events.handler({}, b.sink);
  const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events),
    rpc = new RpcRegistry(),
    streams = new Streams();
  t.after(() => sessions.close());
  sessions.register(rpc, streams);
  await rpc.dispatch("session/list", { args: {} });
  const follow = sink();
  await streams.endpoints.get("session/follow")?.(
    { request: { address: { sessionId: "thread" } } },
    follow.sink,
  );
  const request = a.frames.find((value) => (value as { type: string }).type === "waterfall") as {
    eventId: string;
  };
  assert.ok(request);
  const clientA = (a.frames[0] as { clientId: string }).clientId;
  events.settle({
    clientId: clientA,
    eventId: request.eventId,
    outcome: {
      kind: "returned",
      value: { answers: [{ id: "approval", selected: ["Allow once"] }] },
    },
  });
  await wait(() => host.answers.length === 1);
  assert.deepEqual(host.answers[0]?.result, { action: "accept", content: {} });
  assert.ok(
    b.frames.some(
      (value) =>
        (value as { type: string; eventId?: string }).type === "cancel" &&
        (value as { eventId?: string }).eventId === request.eventId,
    ),
  );
  host.pending = [{ ...approval, requestId: -43 }];
  host.changed("thread", "mcpServer/elicitation/request");
  await wait(
    () => a.frames.filter((value) => (value as { type: string }).type === "waterfall").length === 2,
  );
  host.connection(false);
  assert.equal((a.frames.at(-1) as { type: string }).type, "cancel");
  host.pending = [];
  host.connection(true);
  await delay(200);
  assert.equal(
    a.frames.filter((value) => (value as { type: string }).type === "waterfall").length,
    2,
  );
  assert.equal(host.answers.length, 1, "Disconnect/withdrawal does not answer an interaction");
  follow.sink.end();
});

it("retires in-flight old-epoch snapshots and advances the Web display generation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-epoch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel(),
    row = host.add("thread", root);
  const sessions = new ChSessions(
      host,
      new Workspaces(new DataDir(root), root),
      new EventHub(root),
    ),
    rpc = new RpcRegistry(),
    streams = new Streams();
  t.after(() => sessions.close());
  sessions.register(rpc, streams);
  await rpc.dispatch("session/list", { args: {} });
  const before = sink();
  await streams.endpoints.get("session/follow")?.(
    { request: { address: { sessionId: row.id } } },
    before.sink,
  );
  const oldCursor = (before.frames[0] as { cursor: number }).cursor;
  let release: () => void = () => {};
  let blocked = false;
  host.delaySnapshot = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      blocked = true;
    });
  host.changed(row.id);
  await wait(() => blocked);
  host.connection(false);
  host.epoch = randomUUID();
  defined(row.turns[0]).id = "restored";
  host.connection(true);
  assert.equal(before.sink.closed, true);
  host.delaySnapshot = undefined;
  const after = sink();
  await streams.endpoints.get("session/follow")?.(
    { request: { address: { sessionId: row.id } } },
    after.sink,
  );
  assert.ok((after.frames[0] as { cursor: number }).cursor > oldCursor);
  release();
  await delay(150);
  assert.equal(
    after.frames.filter((value) => (value as { type: string }).type === "snapshot").length,
    1,
  );
  assert.ok(JSON.stringify(after.frames).includes("existing CH answer"));
  after.sink.end();
});

it("does not turn an acknowledged send into a rejection when the following read fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-send-ack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  host.add("thread", root);
  host.delaySnapshot = async () => {
    throw new Error("Read unavailable");
  };
  const sessions = new ChSessions(
      host,
      new Workspaces(new DataDir(root), root),
      new EventHub(root),
    ),
    rpc = new RpcRegistry();
  t.after(() => sessions.close());
  sessions.register(rpc, new StreamRegistry());
  await rpc.dispatch("session/list", { args: {} });
  const result = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: "thread",
        requestId: "accepted",
        content: [{ type: "text", text: "one send" }],
      },
    },
  });
  assert.deepEqual(result, { ok: true, value: { accepted: true } });
  await delay(150);
  assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 1);
});

it("projects running tool output and individual completion without rebroadcasting unchanged controls", () => {
  const host = new FakeChChannel(),
    row = host.add("thread", "/synthetic");
  row.turns = [
    {
      id: "live",
      status: "inProgress",
      items: [
        {
          id: "u",
          type: "userMessage",
          clientId: "request",
          content: [{ type: "text", text: "input" }],
        },
        {
          id: "command",
          type: "commandExecution",
          command: "echo live",
          status: "inProgress",
          aggregatedOutput: "first",
        },
      ],
    },
  ];
  const controls: unknown[] = [];
  const view = new ChThreadView(structuredClone(row), "fake", (...args) => controls.push(args));
  view.update(structuredClone(row));
  assert.deepEqual(view.log.projectionBaseline().values.codexhostToolOutput, { command: "first" });
  const count = controls.length;
  view.update(structuredClone(row));
  assert.equal(controls.length, count);
  const command = defined(row.turns[0]?.items[1]);
  command.aggregatedOutput = "replacement";
  view.update(structuredClone(row));
  assert.deepEqual(view.log.projectionBaseline().values.codexhostToolOutput, {
    command: "replacement",
  });
  command.status = "completed";
  view.update(structuredClone(row));
  assert.deepEqual(view.log.projectionBaseline().values.codexhostToolOutput, {});
  assert.equal(view.log.events.filter((event) => event.type === "tool/result").length, 1);
  view.update(structuredClone(row));
  assert.equal(view.log.events.filter((event) => event.type === "tool/result").length, 1);
});
