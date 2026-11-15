import assert from "node:assert/strict";
import { it } from "node:test";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import type { ChThread, ChTurn } from "../src/ch-thread-view.ts";
import { readRemoteHistory } from "../src/remote-session-history.ts";
import { RemoteSessions, remoteSessionId } from "../src/remote-sessions.ts";
import { EventHub, RpcRegistry, StreamRegistry, type StreamSink } from "../src/transport.ts";
import { RemoteSessionError } from "@codexhost/desktop-control";

const identity = { hostId: "remote-ssh-discovered:fixture", threadId: "thread" };
function turn(id: string, status = "completed", text = id): ChTurn {
  return { id, status, items: [{ id: `${id}-answer`, type: "agentMessage", text }] };
}
function fixture(turns: ChTurn[]) {
  const calls: RemoteSessionOperation[] = [];
  const thread: ChThread = {
    id: identity.threadId,
    cwd: "/remote",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    historyMode: "paginated",
    status: { type: "idle" },
    turns,
  };
  let epoch = "one";
  let readError: Error | undefined;
  const call = async (operation: RemoteSessionOperation): Promise<unknown> => {
    calls.push(operation);
    if (operation.kind === "hosts") return [{ hostId: identity.hostId, online: true }];
    if (operation.kind === "list") return { data: [{ ...thread, turns: [] }], nextCursor: null };
    if (operation.kind === "status")
      return {
        threadId: thread.id,
        status: thread.status.type,
        turnId: thread.turns.at(-1)?.status === "inProgress" ? thread.turns.at(-1)?.id : null,
        epoch,
      };
    if (operation.kind !== "read") return {};
    if (readError) throw readError;
    const ordered =
      operation.page?.sortDirection === "desc" ? thread.turns.toReversed() : thread.turns;
    const start = Number(operation.page?.cursor ?? 0);
    const data = operation.page
      ? ordered.slice(start, start + (operation.page.limit ?? 20))
      : ordered;
    return structuredClone({
      result: { thread: { ...thread, turns: data } },
      epoch,
      configuration: { owner: "codex", locked: true },
      requests: [],
      ...(operation.page
        ? { nextCursor: start + data.length < ordered.length ? String(start + data.length) : null }
        : {}),
    });
  };
  return {
    call,
    calls,
    thread,
    failRead: (error?: Error) => {
      readError = error;
    },
    reconnect: () => {
      epoch = "two";
    },
  };
}

function followFixture(call: (operation: RemoteSessionOperation) => Promise<unknown>) {
  const remote = new RemoteSessions(new EventHub("retry-history"), call);
  const rpc = new RpcRegistry(),
    streams = new StreamRegistry();
  let route: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    route = value;
  };
  remote.install(rpc, streams);
  rpc.register("session/cancel", () => {
    throw new Error("must not route locally");
  });
  const id = remoteSessionId(identity.hostId, identity.threadId);
  let viewers = 0;
  function viewer() {
    const frames: unknown[] = [],
      closed: Array<() => void> = [];
    let isClosed = false;
    const close = () => {
      if (isClosed) return;
      isClosed = true;
      for (const listener of closed.splice(0)) listener();
    };
    const sink: StreamSink = {
      id: `follow-${++viewers}`,
      get closed() {
        return isClosed;
      },
      push: (frame) => {
        if (!isClosed) frames.push(frame);
      },
      end: close,
      fail: close,
      onClose: (listener) => {
        if (isClosed) listener();
        else closed.push(listener);
      },
    };
    return {
      frames,
      sink,
      async open() {
        assert.ok(route);
        await route(
          "session/follow",
          { request: { address: { sessionId: id } } },
          sink,
          async () => {},
        );
      },
      close,
    };
  }
  return { remote, rpc, id, viewer, ...viewer() };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

it("revalidates a settled prefix after 30 seconds and when the live tail settles", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = fixture([turn("old"), turn("live", "inProgress")]);
  const initial = await readRemoteHistory(f.call, identity);
  f.thread.turns[0] = turn("old", "completed", "late native edit");
  const previous = {
    epoch: initial.epoch,
    fullReadAt: initial.fullReadAt,
    owner: "codex" as const,
    thread: initial.result.thread,
  };
  t.mock.timers.tick(29_999);
  const reused = await readRemoteHistory(f.call, identity, previous);
  assert.equal(reused.result.thread.turns[0]?.items[0]?.text, "old");
  assert.equal(reused.fullReadAt, initial.fullReadAt);
  t.mock.timers.tick(1);
  const verified = await readRemoteHistory(f.call, identity, previous);
  assert.equal(verified.result.thread.turns[0]?.items[0]?.text, "late native edit");
  assert.ok(verified.fullReadAt > initial.fullReadAt);
  f.thread.turns = [turn("old", "completed", "settlement edit"), turn("live")];
  const settled = await readRemoteHistory(f.call, identity, {
    ...previous,
    fullReadAt: verified.fullReadAt,
    thread: verified.result.thread,
  });
  assert.deepEqual(settled.result.thread.turns, f.thread.turns);
});

it("recovers the initial read on the same connection and bounds unsuccessful attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture([turn("head")]);
  f.failRead(new RemoteSessionError(-32603, "temporary failure"));
  const follow = followFixture(f.call);
  t.after(() => follow.remote.close());
  const opening = follow.open();
  await flush();
  assert.equal(f.calls.filter((call) => call.kind === "read").length, 1);
  f.failRead();
  t.mock.timers.tick(1500);
  await opening;
  assert.match(JSON.stringify(follow.frames), /snapshot/);
  follow.close();

  f.failRead(new RemoteSessionError(-32603, "still unavailable"));
  const failed = followFixture(f.call);
  t.after(() => failed.remote.close());
  f.calls.length = 0;
  const failure = assert.rejects(failed.open(), /still unavailable/);
  await flush();
  t.mock.timers.tick(1500);
  await flush();
  t.mock.timers.tick(3000);
  await failure;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.filter((call) => call.kind === "read").length, 3);
});

it("cancels the initial retry when its viewer closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture([turn("head")]);
  f.failRead(new RemoteSessionError(-32603, "temporary failure"));
  const follow = followFixture(f.call);
  t.after(() => follow.remote.close());
  const opening = follow.open();
  await flush();
  follow.close();
  await opening;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.filter((call) => call.kind === "read").length, 1);
  assert.equal(follow.frames.length, 0);
});

it("pauses oversized history polling and allows an explicit fresh follow to recover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture([turn("head")]);
  const follow = followFixture(f.call);
  t.after(() => follow.remote.close());
  await follow.open();
  f.failRead(new RemoteSessionError(-32094, "Turn too large"));
  f.calls.length = 0;
  t.mock.timers.tick(1500);
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.filter((call) => call.kind === "read").length, 1);
  assert.match(JSON.stringify(follow.frames), /Turn too large/);
  follow.close();
  const retry = followFixture(f.call);
  t.after(() => retry.remote.close());
  await assert.rejects(retry.open(), /Turn too large/);
  assert.equal(f.calls.filter((call) => call.kind === "read").length, 2);
  f.failRead();
  const recovered = followFixture(f.call);
  t.after(() => recovered.remote.close());
  await recovered.open();
  assert.match(JSON.stringify(recovered.frames), /"remoteHistoryError"[^}]*null/);
});

it("resumes a paused follower after a successful independent history read", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const f = fixture([turn("head")]);
  const follow = followFixture(f.call);
  t.after(() => follow.remote.close());
  await follow.open();
  f.failRead(new RemoteSessionError(-32094, "Turn too large"));
  t.mock.timers.tick(1500);
  await flush();
  f.calls.length = 0;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.filter((call) => call.kind === "read").length, 0);
  f.failRead();
  await follow.remote.read(follow.id);
  f.calls.length = 0;
  f.thread.turns.push(turn("next", "inProgress", "progress after recovery"));
  t.mock.timers.tick(1500);
  await flush();
  assert.ok(f.calls.some((call) => call.kind === "read"));
  assert.match(JSON.stringify(follow.frames), /progress after recovery/);
});

it("honors a shared permanent failure during another viewer's initial retry delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture([turn("head")]);
  f.failRead(new RemoteSessionError(-32603, "temporary failure"));
  const follow = followFixture(f.call);
  t.after(() => follow.remote.close());
  const opening = assert.rejects(follow.open(), /Turn too large/);
  await flush();
  f.failRead(new RemoteSessionError(-32094, "Turn too large"));
  await assert.rejects(follow.viewer().open(), /Turn too large/);
  f.calls.length = 0;
  t.mock.timers.tick(1500);
  await opening;
  assert.equal(f.calls.filter((call) => call.kind === "read").length, 0);
  f.failRead();
  const recovered = follow.viewer();
  await recovered.open();
  assert.match(JSON.stringify(recovered.frames), /snapshot/);
});

it("shares recovery between viewers and releases retired and closed subscriptions", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const f = fixture([turn("head")]);
  const follow = followFixture(f.call);
  t.after(() => follow.remote.close());
  const second = follow.viewer();
  await follow.open();
  await second.open();
  f.failRead(new RemoteSessionError(-32094, "Turn too large"));
  t.mock.timers.tick(1500);
  await flush();
  assert.match(JSON.stringify(follow.frames), /Turn too large/);
  assert.match(JSON.stringify(second.frames), /Turn too large/);
  f.calls.length = 0;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.length, 0);

  second.close();
  const retry = follow.viewer();
  f.failRead();
  await retry.open();
  f.thread.turns.push(turn("live", "inProgress", "shared recovery"));
  t.mock.timers.tick(1500);
  await flush();
  for (const viewer of [follow, retry])
    assert.match(JSON.stringify(viewer.frames), /shared recovery/);
  assert.doesNotMatch(JSON.stringify(second.frames), /shared recovery/);

  f.reconnect();
  await follow.remote.read(follow.id);
  assert.equal(follow.sink.closed, true);
  assert.equal(retry.sink.closed, true);
  f.calls.length = 0;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.length, 0);
  const reopened = follow.viewer();
  await reopened.open();
  const liveItem = f.thread.turns.at(-1)?.items[0];
  assert.ok(liveItem);
  liveItem.text = "shared recovery after reconnect";
  t.mock.timers.tick(1500);
  await flush();
  assert.match(JSON.stringify(reopened.frames), /after reconnect/);
  reopened.close();
  f.calls.length = 0;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.length, 0);
});

it("rejects a view removed between reading and registering its follower", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const f = fixture([turn("head")]);
  let removed = false;
  const follow = followFixture(async (operation) =>
    removed && operation.kind === "list" ? { data: [], nextCursor: null } : f.call(operation),
  );
  t.after(() => follow.remote.close());
  const read = follow.remote.read.bind(follow.remote);
  follow.remote.read = async (id) => {
    const view = await read(id);
    removed = true;
    await follow.remote.refresh();
    return view;
  };
  await assert.rejects(follow.open(), { code: "remote/connection-changed" });
  assert.equal(follow.frames.length, 0);
  f.calls.length = 0;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.length, 0);
});

it("stops without awaiting an already pending full history read", { timeout: 3000 }, async (t) => {
  const f = fixture([turn("current", "inProgress")]);
  f.thread.status.type = "active";
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  t.after(() => release.resolve(undefined));
  const follow = followFixture(async (operation) => {
    if (operation.kind === "read") {
      started.resolve(undefined);
      await release.promise;
    }
    return f.call(operation);
  });
  t.after(() => follow.remote.close());
  const reading = follow.remote.read(follow.id);
  await started.promise;
  f.calls.length = 0;
  const stopped = await follow.rpc.dispatch("session/cancel", {
    args: { request: { sessionId: follow.id } },
  });
  assert.equal(stopped.ok, true);
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ["status", "interrupt"],
  );
  release.resolve(undefined);
  await reading;
});

it("stops once using fresh lightweight status despite unreadable history", async (t) => {
  const f = fixture([turn("orphan", "inProgress"), turn("current", "inProgress")]);
  f.thread.status.type = "active";
  f.failRead(new RemoteSessionError(-32094, "Turn too large"));
  const follow = followFixture(f.call);
  t.after(() => follow.remote.close());
  const result = await follow.rpc.dispatch("session/cancel", {
    args: { request: { sessionId: follow.id } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, [
    { kind: "status", ...identity },
    { kind: "interrupt", ...identity, epoch: "one", turnId: "current" },
  ]);
  f.calls.length = 0;
  f.thread.turns[1] = turn("current");
  const refused = await follow.rpc.dispatch("session/cancel", {
    args: { request: { sessionId: follow.id } },
  });
  assert.equal(refused.ok, false);
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ["status"],
  );
});

it("does not replay an unconfirmed interrupt or interrupt after a failed status read", async (t) => {
  const f = fixture([turn("current", "inProgress")]);
  f.thread.status.type = "active";
  let statusFails = false;
  const follow = followFixture(async (operation) => {
    const result = await f.call(operation);
    if (operation.kind === "interrupt" || (statusFails && operation.kind === "status"))
      throw new RemoteSessionError(-32095, "Connection changed");
    return result;
  });
  t.after(() => follow.remote.close());
  assert.equal(
    (await follow.rpc.dispatch("session/cancel", { args: { request: { sessionId: follow.id } } }))
      .ok,
    false,
  );
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ["status", "interrupt"],
  );
  statusFails = true;
  f.calls.length = 0;
  assert.equal(
    (await follow.rpc.dispatch("session/cancel", { args: { request: { sessionId: follow.id } } }))
      .ok,
    false,
  );
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ["status"],
  );
});

it("refreshes live output without transferring a large settled prefix again", async () => {
  const f = fixture([
    ...["old-one", "old-two", "old-three"].map((id) =>
      turn(id, "completed", "x".repeat(6 * 1024 * 1024)),
    ),
    turn("live", "inProgress", "first"),
  ]);
  const previous = await readRemoteHistory(f.call, identity);
  f.thread.turns[3] = turn("live", "inProgress", "first update");
  f.calls.length = 0;
  const updated = await readRemoteHistory(f.call, identity, {
    epoch: previous.epoch,
    fullReadAt: previous.fullReadAt,
    owner: "codex",
    thread: previous.result.thread,
  });
  assert.equal(updated.result.thread.turns[0], previous.result.thread.turns[0]);
  assert.equal(updated.result.thread.turns[3]?.items[0]?.text, "first update");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], {
    kind: "read",
    ...identity,
    page: { cursor: null, sortDirection: "desc", limit: 1 },
  });
});

it("does not reserialize a retained prefix while checking refreshed history limits", async () => {
  const f = fixture([
    turn("old", "completed", "x".repeat(1024 * 1024)),
    turn("live", "inProgress"),
  ]);
  let previous = await readRemoteHistory(f.call, identity);
  const oldItem = previous.result.thread.turns[0]?.items[0];
  assert.ok(oldItem);
  const text = oldItem.text;
  let textReads = 0;
  Object.defineProperty(oldItem, "text", {
    enumerable: true,
    get: () => {
      textReads++;
      return text;
    },
  });
  for (const update of ["new tail", 'new tail with 中文 and \\" escapes']) {
    f.thread.turns[1] = turn("live", "inProgress", update);
    previous = await readRemoteHistory(f.call, identity, {
      epoch: previous.epoch,
      fullReadAt: previous.fullReadAt,
      owner: "codex",
      thread: previous.result.thread,
    });
    assert.equal(previous.result.thread.turns[0]?.items[0], oldItem);
    assert.equal(previous.result.thread.turns[1]?.items[0]?.text, update);
  }
  assert.equal(textReads, 0);
});

it("counts JSON array delimiters and UTF-8 tail growth against the full history byte limit", async () => {
  const old = turn("old"),
    live = turn("live", "inProgress", "");
  const oldItem = old.items[0];
  assert.ok(oldItem);
  oldItem.text = "";
  const overhead = Buffer.byteLength(JSON.stringify([old, live]));
  oldItem.text = "x".repeat(128 * 1024 * 1024 - overhead);
  const f = fixture([old, live]);
  const previous = await readRemoteHistory(f.call, identity);
  f.thread.turns[1] = turn("live", "inProgress", "é");
  await assert.rejects(
    readRemoteHistory(f.call, identity, {
      epoch: previous.epoch,
      fullReadAt: previous.fullReadAt,
      owner: "codex",
      thread: previous.result.thread,
    }),
    { code: "remote/history-too-large" },
  );
  assert.equal(previous.result.thread.turns[1]?.items[0]?.text, "");
});

it("keeps the Turn-count limit when sizing histories by individual Turns", async () => {
  const f = fixture(Array.from({ length: 5000 }, (_, index) => turn(String(index))));
  await readRemoteHistory(f.call, identity);
  f.thread.turns.push(turn("overflow"));
  await assert.rejects(readRemoteHistory(f.call, identity), { code: "remote/history-too-large" });
});

it("reads new Turns back to the known tail and replaces a rolled-back suffix", async () => {
  const f = fixture([turn("old"), turn("previous", "inProgress")]);
  const previous = await readRemoteHistory(f.call, identity);
  f.thread.turns = [
    turn("old"),
    turn("previous"),
    turn("new-one"),
    turn("new-two"),
    turn("new-three", "inProgress"),
  ];
  f.calls.length = 0;
  const updated = await readRemoteHistory(f.call, identity, {
    epoch: previous.epoch,
    fullReadAt: previous.fullReadAt,
    owner: "codex",
    thread: previous.result.thread,
  });
  assert.deepEqual(updated.result.thread.turns, f.thread.turns);
  assert.equal(f.calls.length, 5);
  assert.equal(
    (f.calls[1] as Extract<RemoteSessionOperation, { kind: "read" }>).page?.epoch,
    "one",
  );

  f.thread.turns = [turn("old"), turn("replacement")];
  const rolledBack = await readRemoteHistory(f.call, identity, {
    epoch: updated.epoch,
    fullReadAt: updated.fullReadAt,
    owner: "codex",
    thread: updated.result.thread,
  });
  assert.deepEqual(rolledBack.result.thread.turns, f.thread.turns);
  f.thread.turns = [];
  const cleared = await readRemoteHistory(f.call, identity, {
    epoch: rolledBack.epoch,
    fullReadAt: rolledBack.fullReadAt,
    owner: "codex",
    thread: rolledBack.result.thread,
  });
  assert.deepEqual(cleared.result.thread.turns, []);
});

it("rebuilds after reconnect and rejects a failed continuation without publishing a partial tail", async () => {
  const f = fixture([turn("old")]);
  const previous = await readRemoteHistory(f.call, identity);
  f.reconnect();
  f.thread.turns = [turn("replacement")];
  f.calls.length = 0;
  const reconnected = await readRemoteHistory(f.call, identity, {
    epoch: previous.epoch,
    fullReadAt: previous.fullReadAt,
    owner: "codex",
    thread: previous.result.thread,
  });
  assert.equal(reconnected.epoch, "two");
  assert.deepEqual(reconnected.result.thread.turns, f.thread.turns);
  assert.equal(f.calls.length, 2);
  assert.equal((f.calls[1] as Extract<RemoteSessionOperation, { kind: "read" }>).page, undefined);

  f.thread.turns.push(turn("one"), turn("two"), turn("three"));
  await assert.rejects(
    readRemoteHistory(
      async (operation) => {
        if (operation.page?.cursor) throw new Error("continuation lost");
        return f.call(operation);
      },
      identity,
      {
        epoch: reconnected.epoch,
        fullReadAt: reconnected.fullReadAt,
        owner: "codex",
        thread: reconnected.result.thread,
      },
    ),
    /continuation lost/,
  );
  assert.equal(reconnected.result.thread.turns.length, 1);
});

for (const source of ["external", "unknown", "readonly", "background"] as const) {
  it(`refreshes old content for ${source} history even when the newest Turn is unchanged`, async () => {
    const f = fixture([turn("old"), turn("head")]);
    if (source === "readonly") f.thread.canAcceptDirectInput = false;
    if (source === "background") {
      const old = f.thread.turns[0];
      assert.ok(old);
      old.items.push({
        id: "job",
        type: "commandExecution",
        status: "inProgress",
        aggregatedOutput: "before",
      });
    }
    const previous = await readRemoteHistory(f.call, identity);
    f.thread.turns[0] = {
      ...turn("old", "completed", "late update"),
      items: [
        { id: "old-answer", type: "agentMessage", text: "late update" },
        { id: "job", type: "commandExecution", status: "completed", aggregatedOutput: "after" },
        { id: "diff", type: "fileChange", status: "completed", changes: [] },
      ],
    };
    f.calls.length = 0;
    const updated = await readRemoteHistory(f.call, identity, {
      epoch: previous.epoch,
      fullReadAt: previous.fullReadAt,
      ...(source === "unknown"
        ? {}
        : { owner: source === "external" ? ("external" as const) : ("codex" as const) }),
      thread: previous.result.thread,
    });
    assert.deepEqual(updated.result.thread.turns, f.thread.turns);
    assert.ok(f.calls.some((call) => call.kind === "read" && !call.page));
    if (source === "background") {
      f.calls.length = 0;
      await readRemoteHistory(f.call, identity, {
        epoch: updated.epoch,
        fullReadAt: updated.fullReadAt,
        owner: "codex",
        thread: updated.result.thread,
      });
      assert.equal(f.calls.length, 1);
      assert.equal(
        (f.calls[0] as Extract<RemoteSessionOperation, { kind: "read" }>).page?.sortDirection,
        "desc",
      );
    }
  });
}

it("keeps a follower connected through a history error and clears the error after recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const f = fixture([turn("head")]);
  const summaries: Array<{
    agentAvailable: boolean;
    projections: { values: Record<string, unknown> };
  }> = [];
  const events = new EventHub("history-errors");
  events.emit = (event, ...args) => {
    if (event === "api-session/added") summaries.push(args[0] as (typeof summaries)[number]);
  };
  const remote = new RemoteSessions(events, f.call);
  t.after(() => remote.close());
  const rpc = new RpcRegistry(),
    streams = new StreamRegistry();
  let route: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    route = value;
  };
  remote.install(rpc, streams);
  const frames: unknown[] = [],
    closed: Array<() => void> = [];
  let ended = false;
  const sink: StreamSink = {
    id: "follow",
    closed: false,
    push: (frame) => frames.push(frame),
    end: () => {
      ended = true;
    },
    fail: () => {
      ended = true;
    },
    onClose: (close) => closed.push(close),
  };
  assert.ok(route);
  await route(
    "session/follow",
    { request: { address: { sessionId: remoteSessionId(identity.hostId, identity.threadId) } } },
    sink,
    async () => {},
  );
  frames.length = 0;
  f.failRead(new RemoteSessionError(-32603, "Temporary history read failure"));
  t.mock.timers.tick(1500);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(summaries.at(-1)?.agentAvailable, true);
  assert.deepEqual(summaries.at(-1)?.projections.values.remoteHistoryError, {
    code: "remote/read-failed",
    message: "Temporary history read failure",
  });
  assert.match(JSON.stringify(frames), /Temporary history read failure/);
  assert.equal(ended, false);
  await remote.refresh();
  assert.ok(summaries.at(-1)?.projections.values.remoteHistoryError);
  f.failRead();
  t.mock.timers.tick(3000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(summaries.at(-1)?.projections.values.remoteHistoryError, null);
  assert.equal(summaries.at(-1)?.agentAvailable, true);
  assert.equal(ended, false);
  f.failRead(new RemoteSessionError(-32090, "Remote Host is offline"));
  t.mock.timers.tick(1500);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(summaries.at(-1)?.agentAvailable, false);
  for (const close of closed) close();
});

it("publishes new output and running state to an existing follower, and stops the newest live Turn", async (t) => {
  const f = fixture([turn("orphan", "inProgress"), turn("settled")]);
  const events = new EventHub("live-history");
  const summaries: Array<{ running: boolean }> = [];
  const statuses: unknown[][] = [];
  events.emit = (event, ...args) => {
    if (event === "api-session/added") summaries.push(args[0] as { running: boolean });
    if (event === "api-session/status") statuses.push(args);
  };
  const remote = new RemoteSessions(events, f.call);
  t.after(() => remote.close());
  const rpc = new RpcRegistry();
  rpc.register("session/cancel", () => {
    throw new Error("must not route locally");
  });
  const streams = new StreamRegistry();
  let route: Parameters<StreamRegistry["routeSessions"]>[0] | undefined;
  streams.routeSessions = (value) => {
    route = value;
  };
  remote.install(rpc, streams);
  const id = remoteSessionId(identity.hostId, identity.threadId);
  const frames: unknown[] = [];
  const closing: Array<() => void> = [];
  const sink: StreamSink = {
    id: "follow",
    closed: false,
    push: (frame) => frames.push(frame),
    end() {},
    fail() {},
    onClose: (close) => closing.push(close),
  };
  assert.ok(route);
  await route(
    "session/follow",
    { request: { address: { sessionId: id }, assistantStream: true } },
    sink,
    async () => {},
  );
  f.thread.status.type = "active";
  f.thread.turns.push(turn("live", "inProgress", "visible-progress"));
  summaries.length = 0;
  frames.length = 0;
  await remote.read(id);
  assert.match(JSON.stringify(frames), /visible-progress/);
  assert.equal(summaries.at(-1)?.running, true);
  assert.deepEqual(statuses.at(-1), [id, true]);
  const stopped = await rpc.dispatch("session/cancel", { args: { request: { sessionId: id } } });
  assert.ok(stopped.ok);
  assert.equal(f.calls.findLast((call) => call.kind === "interrupt")?.turnId, "live");

  f.thread.status.type = "idle";
  f.thread.turns[f.thread.turns.length - 1] = turn(
    "live",
    "completed",
    "visible-progress complete",
  );
  await remote.read(id);
  assert.equal(summaries.at(-1)?.running, false);
  assert.deepEqual(statuses.at(-1), [id, false]);
  assert.match(JSON.stringify(frames), /complete/);
  for (const close of closing) close();
});
