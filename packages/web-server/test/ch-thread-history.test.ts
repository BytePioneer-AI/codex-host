import assert from "node:assert/strict";
import { it } from "node:test";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { defined } from "./support/defined.ts";
import type { ChTurn } from "../src/ch-thread-view.ts";

function turns(count: number, start = 0): ChTurn[] {
  return Array.from({ length: count }, (_, index) => {
    const i = index + start;
    return {
      id: `turn-${i}`,
      status: "completed",
      startedAt: 1_700_000_000 + i * 120,
      completedAt: 1_700_000_045 + i * 120,
      items: [
        {
          id: `user-${i}`,
          type: "userMessage",
          content: [{ type: "text", text: `Question ${i}` }],
        },
        { id: `reasoning-${i}`, type: "reasoning", summary: ["Thought"], content: [] },
        {
          id: `tool-${i}`,
          type: "commandExecution",
          command: "pwd",
          aggregatedOutput: "/project",
          exitCode: 0,
        },
        { id: `agent-${i}`, type: "agentMessage", text: `Answer ${i}` },
      ],
    };
  });
}
function fixture(count = 205) {
  const host = new FakeChHost();
  const row = host.add("history", "/project");
  row.turns = turns(count);
  const view = new ChThreadHistory(host, row, "fake", () => {});
  return { host, row, view };
}

it("opens only the latest five full Turns, then pages backwards without renumbering the tail", async () => {
  const { host, row, view } = fixture();
  await view.refresh();
  assert.deepEqual(view.thread.turns, row.turns.slice(-5));
  assert.equal(host.requests.filter((r) => r.method === "thread/turns/list").length, 1);
  assert.deepEqual(host.requests[1]?.params, {
    threadId: row.id,
    cursor: null,
    limit: 5,
    sortDirection: "desc",
    itemsView: "full",
  });
  const tail = structuredClone(view.log.events);
  const cursor = view.log.lastSeq;
  let beforeSeq = view.log.firstSeq;
  let pages = 0;
  while (true) {
    const page = await view.olderPage(cursor, beforeSeq);
    pages++;
    const first = (page.records[0] as { event: { seq: number } })?.event.seq;
    assert.ok(first < beforeSeq);
    beforeSeq = first;
    if (!page.hasMore) break;
    assert.ok(pages < 50);
  }
  assert.equal(pages, 40);
  assert.deepEqual(view.thread.turns, row.turns);
  assert.deepEqual(view.log.events.slice(-tail.length), tail);
  assert.equal(view.log.lastSeq, cursor);
  assert.equal(new Set(view.log.events.map((e) => e.seq)).size, view.log.events.length);
  for (let i = 1; i < view.log.events.length; i++)
    assert.equal(view.log.events[i]?.seq, (view.log.events[i - 1]?.seq ?? 0) + 1);
  for (const event of view.log.events)
    for (const source of event.sourceEventSeqs ?? [])
      assert.ok(
        view.log.events.some((e) => e.seq === source),
        "tool references survive prepend",
      );
  assert.ok(host.requests.every((r) => ["thread/read", "thread/turns/list"].includes(r.method)));
});

it("preserves native message times across paging, refreshes and reopening", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { host, row, view } = fixture(12);
  for (const turn of row.turns)
    turn.items = turn.items.filter((item) => ["userMessage", "agentMessage"].includes(item.type));
  const times = (type: string) =>
    view.log.events.filter((event) => event.type === type).map((event) => event.time);
  const expected = (key: "startedAt" | "completedAt", count: number) =>
    row.turns.slice(-count).map((turn) => Number(turn[key]) * 1000);

  await view.refresh();
  assert.deepEqual(times("user/message"), expected("startedAt", 5));
  assert.deepEqual(times("assistant/message"), expected("completedAt", 5));
  assert.deepEqual(times("turn/start"), expected("startedAt", 5));
  assert.deepEqual(times("turn/end"), expected("completedAt", 5));
  assert.equal(view.log.clock, undefined);

  const tail = structuredClone(view.log.events);
  t.mock.timers.tick(60_000);
  await view.prefetchOlder();
  await view.loadOlder();
  await view.refresh(true);
  assert.deepEqual(times("user/message"), expected("startedAt", 12));
  assert.deepEqual(times("assistant/message"), expected("completedAt", 12));
  assert.deepEqual(view.log.events.slice(-tail.length), tail);

  const reopened = new ChThreadHistory(host, row, "fake", () => {});
  await reopened.refresh();
  for (const type of ["user/message", "assistant/message"])
    assert.deepEqual(
      reopened.log.events.filter((event) => event.type === type).map((event) => event.time),
      times(type).slice(-5),
    );
  assert.equal(view.log.append("test/notice", {}).time, Date.now());
});

it("uses stable historical fallbacks when native timing is missing or invalid", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { row, view } = fixture(5);
  Object.assign(defined(row.turns[0]), { startedAt: 0, completedAt: 10 });
  Object.assign(defined(row.turns[1]), { startedAt: null, completedAt: null });
  Object.assign(defined(row.turns[2]), { startedAt: undefined, completedAt: undefined });
  Object.assign(defined(row.turns[3]), { startedAt: NaN, completedAt: -1 });
  Object.assign(defined(row.turns[4]), { startedAt: 20, completedAt: 15 });
  await view.refresh();
  assert.deepEqual(
    view.log.events.filter((event) => event.type === "user/message").map((event) => event.time),
    [0, 10_000, 10_000, 10_000, 20_000],
  );
  assert.deepEqual(
    view.log.events.filter((event) => event.type === "turn/end").map((event) => event.time),
    [10_000, 10_000, 10_000, 10_000, 20_000],
  );

  const untimed = fixture(1);
  Object.assign(defined(untimed.row.turns[0]), { startedAt: null, completedAt: null });
  await untimed.view.refresh();
  assert.ok(untimed.view.log.events.every((event) => event.time === untimed.row.createdAt * 1000));
});

it("does not drain history on refresh and fills new-Turn gaps beyond five Turns", async () => {
  const { host, row, view } = fixture(20);
  await view.refresh();
  await view.refresh();
  assert.equal(host.requests.filter((r) => r.method === "thread/turns/list").length, 1);
  const tail = structuredClone(view.log.events);
  row.turns.push(...turns(12, 20));
  row.updatedAt++;
  await view.refresh();
  assert.deepEqual(view.thread.turns, row.turns.slice(15));
  assert.deepEqual(view.log.events.slice(0, tail.length), tail);
  await view.loadOlder();
  assert.deepEqual(view.thread.turns, row.turns.slice(10));
});

it("refreshes title fallbacks on both full reads and unchanged idle history", async () => {
  const { host, row, view } = fixture(0);
  row.name = "";
  await view.refresh();
  assert.equal(view.log.projections.title, "project");
  const reads = () => host.requests.filter((r) => r.method === "thread/turns/list").length;
  assert.equal(reads(), 1);

  row.name = " \n ";
  row.preview = " First prompt ";
  await view.refresh();
  assert.equal(view.log.projections.title, "First prompt");
  row.name = " Stored title ";
  await view.refresh();
  assert.equal(view.log.projections.title, "Stored title");
  row.name = "";
  row.preview = "";
  row.cwd = "";
  await view.refresh();
  assert.equal(view.log.projections.title, row.id);
  assert.equal(reads(), 1, "title-only updates reuse unchanged idle history");

  row.preview = " Full refresh title ";
  await view.refresh(true);
  assert.equal(view.log.projections.title, "Full refresh title");
  assert.equal(reads(), 2);
});

it("coalesces older pages and retries errors without advancing the cursor", async () => {
  const { host, view } = fixture(12);
  await view.refresh();
  host.historyError = "temporary history failure";
  const boundary = view.log.firstSeq;
  await assert.rejects(view.loadOlder(), /temporary history failure/);
  assert.equal(view.log.firstSeq, boundary);
  host.historyError = undefined;
  const before = host.requests.length;
  await Promise.all([view.loadOlder(), view.loadOlder(), view.loadOlder()]);
  assert.equal(host.requests.length - before, 1);
  assert.equal(view.thread.turns.length, 10);
});

it("keeps one Turn and message identity while active output becomes complete", async () => {
  const { row, view } = fixture(6);
  const last = row.turns.at(-1);
  assert.ok(last);
  last.status = "inProgress";
  last.items = [{ id: "a", type: "agentMessage", text: "hello" }];
  row.status.type = "active";
  await view.refresh();
  await view.loadOlder();
  const item = last.items[0];
  assert.ok(item);
  item.text = "hello world";
  last.status = "completed";
  row.status.type = "idle";
  await view.refresh();
  const starts = view.log.events.filter((e) => e.type === "turn/start");
  assert.equal(starts.length, 6);
  assert.equal(new Set(starts.map((e) => (e.data as { turn: number }).turn)).size, 6);
  assert.ok(JSON.stringify(view.log.events).includes("hello world"));
});

it("uses native boundaries for live Turns without applying the replay clock to live updates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { row, view } = fixture(1);
  const turn = defined(row.turns[0]);
  turn.status = "inProgress";
  turn.completedAt = null;
  turn.items = [
    { id: "user", type: "userMessage", content: [{ type: "text", text: "Live question" }] },
    { id: "answer", type: "agentMessage", text: "Live answer" },
  ];
  row.status.type = "active";
  await view.refresh();
  assert.equal(
    view.log.events.find((event) => event.type === "user/message")?.time,
    Number(turn.startedAt) * 1000,
  );
  assert.equal(view.log.clock, undefined);

  t.mock.timers.tick(5000);
  turn.items.push({ id: "tool", type: "commandExecution", command: "pwd" });
  await view.refresh();
  assert.equal(view.log.events.find((event) => event.type === "tool/call")?.time, Date.now());

  turn.items.push({ id: "final", type: "agentMessage", text: "Final answer" });
  turn.status = "completed";
  turn.completedAt = 1_800_000_004;
  row.status.type = "idle";
  await view.refresh();
  assert.equal(
    view.log.events.findLast((event) => event.type === "assistant/message")?.time,
    turn.completedAt * 1000,
  );
  assert.equal(view.log.events.at(-1)?.time, turn.completedAt * 1000);
  assert.equal(view.log.clock, undefined);
});

it("handles empty history and new Turns without rereading an unavailable older prefix", async () => {
  const { row, view } = fixture(0);
  await view.refresh();
  assert.equal(view.log.events.length, 0);
  row.turns = turns(2);
  row.updatedAt++;
  await view.refresh();
  assert.equal(view.thread.turns.length, 2);
  assert.equal((await view.olderPage(view.log.lastSeq, view.log.firstSeq)).hasMore, false);
});

it("rejects replaced live Items before appending any replacement output", async () => {
  const { row, view } = fixture(1);
  const turn = row.turns[0];
  assert.ok(turn);
  turn.status = "inProgress";
  row.status.type = "active";
  await view.refresh();
  const events = structuredClone(view.log.events);
  turn.items = turn.items.map((item) => ({ ...item, id: `persisted-${item.id}` }));
  turn.status = "completed";
  row.status.type = "idle";
  await assert.rejects(view.refresh(), { code: "host/items-replaced" });
  assert.deepEqual(view.log.events, events);
});

it("clears the historical clock when projecting a changed transcript fails", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { row, view } = fixture(1);
  const turn = defined(row.turns[0]);
  turn.status = "inProgress";
  turn.items = [{ id: "answer", type: "agentMessage", text: "Original answer" }];
  row.status.type = "active";
  await view.refresh();
  defined(turn.items[0]).text = "Rewritten answer";
  turn.status = "completed";
  row.status.type = "idle";
  await assert.rejects(view.refresh(), { code: "host/history-changed" });
  assert.equal(view.log.clock, undefined);
  assert.equal(view.log.append("test/notice", {}).time, Date.now());
});

it("preserves identical text from distinct Items when neither Item was replaced", async () => {
  const { row, view } = fixture(1);
  const turn = row.turns[0];
  assert.ok(turn);
  turn.status = "inProgress";
  turn.items = [{ id: "first", type: "agentMessage", text: "Repeated text" }];
  row.status.type = "active";
  await view.refresh();
  turn.items.push({ id: "second", type: "agentMessage", text: "Repeated text" });
  turn.status = "completed";
  row.status.type = "idle";
  await view.refresh();
  assert.equal(JSON.stringify(view.log.events).split("Repeated text").length - 1, 2);
});

it("rejects repeated cursors and rewritten history rather than looping or fabricating continuity", async () => {
  const { host, row, view } = fixture(12);
  await view.refresh();
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/turns/list" && params.cursor)
      return { data: [], nextCursor: params.cursor } as T;
    return request<T>(method, params);
  };
  await assert.rejects(view.loadOlder(), /cursor did not advance/);
  host.request = request;
  row.turns = turns(3);
  row.updatedAt++;
  await assert.rejects(view.refresh(), /history was rewritten/);
});
