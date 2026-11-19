import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
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
