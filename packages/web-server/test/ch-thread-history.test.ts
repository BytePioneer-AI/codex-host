import assert from "node:assert/strict";
import { it } from "node:test";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { FakeChHost } from "./support/ch-host.ts";
import type { ChTurn } from "../src/ch-thread-view.ts";

function turns(count: number, start = 0): ChTurn[] {
  return Array.from({ length: count }, (_, index) => {
    const i = index + start;
    return {
      id: `turn-${i}`,
      status: "completed",
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
