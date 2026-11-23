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
import { nativeCodex } from "./support/native-codex.ts";

it("keeps a late official user Item above its answer and confirms the Web submission", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ch-native-message-order-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = nativeCodex(new FakeChChannel());
  const row = host.add("native-official", directory);
  row.modelProvider = "openai";
  row.turns = [
    {
      id: "first",
      status: "completed",
      items: [
        { id: "u1", type: "userMessage", content: [{ type: "text", text: "你好" }] },
        { id: "a1", type: "agentMessage", text: "你好！有什么需要我帮忙的？" },
      ],
    },
  ];
  const events = new EventHub(directory);
  const emitted = t.mock.method(events, "emit");
  const sessions = new ChSessions(host, new Workspaces(new DataDir(directory), directory), events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const read = async () => {
    const projections = await rpc.dispatch("session/projections", {
      args: { request: { sessionId: row.id } },
    });
    assert.ok(projections.ok, projections.ok ? undefined : projections.error.message);
    const page = await rpc.dispatch("session/page", {
      args: { request: { address: { sessionId: row.id }, throughSeq: Number.MAX_SAFE_INTEGER } },
    });
    assert.ok(page.ok);
    return (
      page.value as { records: Array<{ event: { type: string; data: unknown } }> }
    ).records.map((record) => record.event);
  };
  await read();
  row.status = { type: "active" };
  row.updatedAt++;
  // A native Turn is observable before its user Item arrives.
  row.turns.push({ id: "second", status: "inProgress", items: [] });
  await read();
  const second = row.turns[1];
  assert.ok(second);
  second.items = [
    {
      id: "u2",
      type: "userMessage",
      clientId: "web-second",
      content: [{ type: "text", text: "你在做是什么" }],
    },
    { id: "a2", type: "agentMessage", text: "我现在在等你的具体任务…" },
  ];
  const assertMessages = (events: Awaited<ReturnType<typeof read>>) => {
    const messages = events.filter(
      (event) => event.type === "user/message" || event.type === "assistant/message",
    );
    assert.deepEqual(
      messages.map((event) => event.type),
      ["user/message", "assistant/message", "user/message", "assistant/message"],
    );
    const user = messages[2]?.data as { content: unknown[]; source: unknown };
    assert.deepEqual(user.content, [{ type: "text", text: "你在做是什么" }]);
    assert.deepEqual(user.source, { kind: "user", rpcId: "web-second" });
  };
  // Confirm the user input even while the answer is still streaming.
  const streaming = await read();
  const user = streaming.filter((event) => event.type === "user/message").at(-1)?.data;
  assert.deepEqual((user as { source: unknown }).source, { kind: "user", rpcId: "web-second" });
  second.status = "completed";
  row.status = { type: "idle" };
  row.updatedAt++;
  const completed = await read();
  assertMessages(completed);
  assert.equal(completed.filter((event) => event.type === "turn/end").length, 2);
  assert.deepEqual(
    emitted.mock.calls.filter((call) => call.arguments[0] === "api-session/status").at(-1)
      ?.arguments,
    ["api-session/status", row.id, false],
  );
});

it("keeps queue projection watermarks increasing after native history is rebuilt", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ch-history-rebuild-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("rebuild-thread", directory);
  row.status = { type: "active" };
  const original = row.turns[0];
  assert.ok(original);
  row.turns = Array.from({ length: 5 }, (_, index) => ({ ...original, id: `old-${index}` }));
  let queue: ClientThreadSnapshot["queue"] = { items: [], pausedReason: null };
  const snapshot = host.snapshot.bind(host);
  host.snapshot = async (id) => ({ ...(await snapshot(id)), queue: structuredClone(queue) });
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(directory), directory),
    new EventHub(directory),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const read = () =>
    rpc.dispatch("session/projections", {
      args: { request: { sessionId: row.id } },
    });
  const baseline = async () => {
    const result = await read();
    assert.ok(result.ok);
    return result.value as {
      asOfSeq: number;
      values: { inbox: { "next-turn": Array<{ id: string }> } };
    };
  };
  let previous = await baseline();
  // A rewritten native transcript retires the disposable Web journal. The
  // browser keeps its projection store when it reopens the same Thread.
  for (let generation = 0; generation < 2; generation++) {
    row.turns = [{ ...original, id: `replacement-${generation}` }];
    row.updatedAt++;
    const reopened = await baseline();
    assert.ok(reopened.asOfSeq > previous.asOfSeq);
    assert.deepEqual(reopened.values.inbox["next-turn"], []);
    queue = {
      pausedReason: null,
      items: [
        {
          id: `queued-${generation}`,
          clientUserMessageId: `input-${generation}`,
          input: [{ type: "text", text: "still pending" }],
          presentationInput: null,
        },
      ],
    };
    const rebuilt = await baseline();
    assert.ok(
      rebuilt.asOfSeq > previous.asOfSeq,
      "rebuilt projections must supersede the browser's old watermark",
    );
    assert.deepEqual(
      rebuilt.values.inbox["next-turn"].map((item) => item.id),
      [`queued-${generation}`],
    );
    queue = { items: [], pausedReason: null };
    const consumed = await baseline();
    assert.ok(consumed.asOfSeq >= rebuilt.asOfSeq);
    assert.deepEqual(consumed.values.inbox["next-turn"], []);
    previous = consumed;
  }
});

it("drops a view nobody followed for ten minutes and reopens it above the browser's cursor", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_800_000_000_000 });
  const directory = mkdtempSync(join(tmpdir(), "ch-idle-view-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const idle = host.add("idle", directory, "Idle title");
  const followed = host.add("followed", directory);
  const running = host.add("running", directory);
  running.status = { type: "active" };
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(directory), directory),
    new EventHub(directory),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const endpoints = new Map<string, StreamHandler>();
  const streams = new StreamRegistry();
  streams.register = (name, handler) => endpoints.set(name, handler);
  sessions.register(rpc, streams);
  interface Frame {
    type: string;
    sessionId?: string;
    key?: string;
    value?: unknown;
    seq?: number;
    epoch?: string;
    resumedAfter?: number;
    cursor?: number;
    records?: Array<{ event: { seq: number; type: string; data: unknown } }>;
    projections?: { asOfSeq: number; values: Record<string, unknown> };
  }
  const open = async (endpoint: string, request: object = {}) => {
    const frames: Frame[] = [];
    const cleanups: Array<() => void> = [];
    let closed = false;
    const sink: StreamSink = {
      id: "browser",
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
    t.after(() => sink.end());
    await endpoints.get(endpoint)?.({ request }, sink);
    return { frames, close: () => sink.end() };
  };
  const follow = async (id: string, resume?: { epoch: string; cursor: number }) => {
    const stream = await open("session/follow", { address: { sessionId: id }, resume });
    const snapshot = stream.frames[0];
    assert.equal(snapshot?.type, "snapshot");
    return { ...stream, snapshot: snapshot as Required<Frame> };
  };
  // Turn coordinates and message identities belong to one journal generation.
  const history = (snapshot: Frame) =>
    snapshot.records?.map(({ event }) => [
      event.type,
      JSON.stringify(event.data, (key, value: unknown) =>
        key === "id" || key === "turn" ? undefined : value,
      ),
    ]);
  const list = async () => assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  const control = await open("session/control");
  const titles = () =>
    control.frames.filter((frame) => frame.sessionId === idle.id && frame.key === "title");
  await list();
  const first = {
    idle: await follow(idle.id),
    followed: await follow(followed.id),
    running: await follow(running.id),
  };
  first.idle.close();
  first.running.close();
  const resumeFrom = (opened: typeof first.idle) => ({
    epoch: opened.snapshot.epoch,
    cursor: opened.snapshot.cursor,
  });
  const minutes = async (count: number) => {
    for (let minute = 0; minute < count; minute++) {
      t.mock.timers.tick(60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  // The first check starts the ten minutes, so the tenth still finds the view.
  await minutes(10);
  const warm = await follow(idle.id, resumeFrom(first.idle));
  assert.equal(warm.snapshot.resumedAfter, first.idle.snapshot.cursor);
  warm.close();
  await minutes(10);
  const reads = host.snapshots;

  // Browsers keep the dropped Thread's sequenced title; the catalog still replaces it.
  idle.name = "Renamed while dropped";
  await list();
  const renamed = titles().at(-1);
  assert.equal(renamed?.value, idle.name);
  assert.ok((renamed?.seq ?? 0) > first.idle.snapshot.cursor);
  assert.equal(host.snapshots, reads, "a dropped view is not read until it is reopened");

  const reopened = await follow(idle.id, resumeFrom(first.idle));
  assert.notEqual(reopened.snapshot.epoch, first.idle.snapshot.epoch);
  assert.equal(reopened.snapshot.resumedAfter, undefined);
  assert.deepEqual(history(reopened.snapshot), history(first.idle.snapshot));
  assert.ok((reopened.snapshot.records?.[0]?.event.seq ?? 0) > first.idle.snapshot.cursor);
  assert.ok(reopened.snapshot.projections.asOfSeq >= (renamed?.seq ?? 0));
  assert.equal(reopened.snapshot.projections.values.title, idle.name);

  // A followed view and a running Thread's view keep their generation.
  for (const [row, kept] of [
    [followed, first.followed],
    [running, first.running],
  ] as const) {
    const again = await follow(row.id, resumeFrom(kept));
    assert.equal(again.snapshot.resumedAfter, kept.snapshot.cursor);
  }
});

it("replays dropped-view catalog updates after control reconnect with increasing seqs and without clearing other projections", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_800_000_000_000 });
  const directory = mkdtempSync(join(tmpdir(), "ch-idle-view-reconnect-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const parent = host.add("parent", directory, "Parent title");
  const idle = host.add("idle", directory, "Initial title");
  let parents: Record<string, string> = {};
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    method === "codexhost/thread/tree/read"
      ? ({ parents: { ...parents } } as T)
      : request<T>(method, params);
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(directory), directory),
    new EventHub(directory),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const endpoints = new Map<string, StreamHandler>();
  const streams = new StreamRegistry();
  streams.register = (name, handler) => endpoints.set(name, handler);
  sessions.register(rpc, streams);
  interface Frame {
    type: string;
    sessionId?: string;
    key?: string;
    value?: unknown;
    seq?: number;
    epoch?: string;
    cursor?: number;
    projections?: { asOfSeq: number; values: Record<string, unknown> };
  }
  const open = async (endpoint: string, req: object = {}) => {
    const frames: Frame[] = [];
    const cleanups: Array<() => void> = [];
    let closed = false;
    const sink: StreamSink = {
      id: "browser",
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
    t.after(() => sink.end());
    await endpoints.get(endpoint)?.({ request: req }, sink);
    return { frames, close: () => sink.end() };
  };
  const follow = async (id: string) => {
    const stream = await open("session/follow", { address: { sessionId: id } });
    const snapshot = stream.frames[0];
    assert.equal(snapshot?.type, "snapshot");
    return { ...stream, snapshot: snapshot as Required<Frame> };
  };
  const list = async () => assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  const minutes = async (count: number) => {
    for (let minute = 0; minute < count; minute++) {
      t.mock.timers.tick(60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const control1 = await open("session/control");
  await list();
  const first = await follow(idle.id);
  first.close();
  await minutes(11);
  const reads = host.snapshots;

  idle.name = "Renamed while online";
  await list();
  const onlineRename = control1.frames
    .filter(
      (frame) =>
        frame.type === "projection" && frame.sessionId === idle.id && frame.key === "title",
    )
    .at(-1);
  assert.equal(onlineRename?.value, idle.name);
  assert.ok((onlineRename?.seq ?? 0) > first.snapshot.cursor);

  // Disconnect control, then mutate both title and tree parent while the view remains dropped.
  control1.close();
  idle.name = "Renamed while offline";
  parents = { [idle.id]: parent.id };
  await list();

  const control2 = await open("session/control");
  assert.equal(control2.frames[0]?.type, "baseline");
  const baseline = control2.frames[0]?.value as { projections: Record<string, unknown> };
  assert.equal(
    baseline.projections[idle.id],
    undefined,
    "dropped views must not emit a partial baseline block that clears non-catalog global projections",
  );
  const replayed = control2.frames
    .slice(1)
    .filter((frame) => frame.type === "projection" && frame.sessionId === idle.id);
  const replayedTitle = replayed.find((frame) => frame.key === "title");
  const replayedParent = replayed.find((frame) => frame.key === "threadTreeParent");
  assert.equal(replayedTitle?.value, "Renamed while offline");
  assert.equal(replayedParent?.value, parent.id);
  assert.ok(
    (replayedTitle?.seq ?? 0) > (onlineRename?.seq ?? 0),
    "reconnected catalog replay must advance above the prior dropped-view sequence",
  );
  assert.equal(replayedParent?.seq, replayedTitle?.seq);
  assert.equal(host.snapshots, reads, "control reconnect must not hydrate a dropped view");

  idle.name = "Renamed after reconnect";
  await list();
  const afterReconnect = control2.frames
    .filter(
      (frame) =>
        frame.type === "projection" && frame.sessionId === idle.id && frame.key === "title",
    )
    .at(-1);
  assert.equal(afterReconnect?.value, "Renamed after reconnect");
  assert.ok(
    (afterReconnect?.seq ?? 0) > (replayedTitle?.seq ?? 0),
    "later dropped-view catalog updates must continue advancing the reserved sequence",
  );

  const reopened = await follow(idle.id);
  assert.ok(reopened.snapshot.projections.asOfSeq > (afterReconnect?.seq ?? 0));
  assert.equal(reopened.snapshot.projections.values.title, "Renamed after reconnect");
  assert.equal(reopened.snapshot.projections.values.threadTreeParent, parent.id);
});

it("keeps a view alive during an in-flight session/page read and refreshes its idle timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_800_000_000_000 });
  const directory = mkdtempSync(join(tmpdir(), "ch-idle-view-page-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("paged", directory, "Paged thread");
  const template = row.turns[0];
  assert.ok(template);
  row.turns = Array.from({ length: 7 }, (_, index) => ({
    ...structuredClone(template),
    id: `turn-${index}`,
  }));
  let holdOlderPage = false;
  let olderPageStartedResolve: (() => void) | undefined;
  const olderPageStarted = new Promise<void>((resolve) => {
    olderPageStartedResolve = resolve;
  });
  let releaseOlderPage: (() => void) | undefined;
  const olderPageGate = new Promise<void>((resolve) => {
    releaseOlderPage = resolve;
  });
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/turns/list" && holdOlderPage) {
      olderPageStartedResolve?.();
      await olderPageGate;
    }
    return request<T>(method, params);
  };
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(directory), directory),
    new EventHub(directory),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const endpoints = new Map<string, StreamHandler>();
  const streams = new StreamRegistry();
  streams.register = (name, handler) => endpoints.set(name, handler);
  sessions.register(rpc, streams);
  interface Frame {
    type: string;
    epoch?: string;
    resumedAfter?: number;
    cursor?: number;
    records?: Array<{ event: { seq: number } }>;
  }
  const follow = async (id: string, resume?: { epoch: string; cursor: number }) => {
    const frames: Frame[] = [];
    const cleanups: Array<() => void> = [];
    let closed = false;
    const sink: StreamSink = {
      id: "browser",
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
    t.after(() => sink.end());
    await endpoints.get("session/follow")?.(
      { request: { address: { sessionId: id }, resume } },
      sink,
    );
    const snapshot = frames[0];
    assert.equal(snapshot?.type, "snapshot");
    return { close: () => sink.end(), snapshot: snapshot as Required<Frame> };
  };
  const minutes = async (count: number) => {
    for (let minute = 0; minute < count; minute++) {
      t.mock.timers.tick(60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  const first = await follow(row.id);
  first.close();
  const firstSeq = first.snapshot.records[0]?.event.seq;
  assert.ok(firstSeq !== undefined);

  // Reach minute 10 (9 minutes after the first unfollowed check); one more tick would evict it.
  await minutes(10);
  holdOlderPage = true;
  const paging = rpc.dispatch("session/page", {
    args: {
      request: {
        address: { sessionId: row.id },
        throughSeq: first.snapshot.cursor,
        beforeSeq: firstSeq,
      },
    },
  });
  await olderPageStarted;

  // Advance past the idle threshold while session/page is still awaiting thread/turns/list.
  await minutes(3);
  releaseOlderPage?.();
  const pageResult = await paging;
  assert.ok(pageResult.ok, pageResult.ok ? undefined : pageResult.error.message);
  assert.ok(((pageResult.value as { records: unknown[] }).records ?? []).length > 0);

  // Advance 10 minutes after paging completed (minute 1 starts the new window -> 9m elapsed),
  // then perform a fast in-memory session/page before the 11th tick to refresh historyReadAt.
  await minutes(10);
  holdOlderPage = false;
  const fastPage = await rpc.dispatch("session/page", {
    args: {
      request: {
        address: { sessionId: row.id },
        throughSeq: first.snapshot.cursor,
      },
    },
  });
  assert.ok(fastPage.ok, fastPage.ok ? undefined : fastPage.error.message);
  await minutes(1);

  const resumed = await follow(row.id, {
    epoch: first.snapshot.epoch,
    cursor: first.snapshot.cursor,
  });
  assert.equal(resumed.snapshot.epoch, first.snapshot.epoch);
  assert.equal(resumed.snapshot.resumedAfter, first.snapshot.cursor);
});
