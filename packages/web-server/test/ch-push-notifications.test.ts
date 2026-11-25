import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { HostClientUpdate } from "@codexhost/desktop-control";
import type { ClientInteraction } from "@codexhost/shared-contracts";
import { ChPushNotifications } from "../src/ch-push-notifications.ts";
import type { PushMessage } from "../src/push.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

function fixture() {
  const host = new FakeChChannel();
  const row = host.add("thread/id", "/workspace", "My task");
  const messages: PushMessage[] = [];
  const push = {
    subscriptionCount: 1,
    async notify(message: PushMessage) {
      messages.push(message);
      return 1;
    },
  };
  const notifications = new ChPushNotifications(host.realtime, push);
  const emit = (event: HostClientUpdate) => {
    for (const listener of host.listeners) listener(event);
  };
  return { host, row, push, messages, notifications, emit };
}

for (const owner of ["external", "codex"])
  it(`pushes ${owner} completion without any browser or history follower`, async (t) => {
    const f = fixture();
    t.after(() => f.notifications.close());
    if (owner === "codex") f.row.modelProvider = "openai";
    await delay(0);
    assert.equal(f.messages.length, 0, "startup must not notify for old history");
    assert.equal(f.host.snapshots, 0);
    f.host.changed(f.row.id, "turn/completed");
    await delay(0);
    assert.deepEqual(f.messages, [
      {
        kind: "turn",
        title: "My task",
        body: "已回复",
        tag: f.row.id,
        sessionId: f.row.id,
        url: "./?session=thread%2Fid",
      },
    ]);
    assert.deepEqual(f.host.snapshotOptions, [{ truncateToolOutput: true }]);
    assert.equal(f.host.answers.length, 0, "notifications must not answer interactions");
  });

it("reports failures, ignores interrupted turns and deduplicates terminal invalidations", async (t) => {
  const f = fixture();
  t.after(() => f.notifications.close());
  f.row.turns = [{ id: "failed", status: "failed", items: [] }];
  f.host.changed(f.row.id, "turn/completed");
  f.host.changed(f.row.id, "turn/completed");
  await delay(0);
  assert.deepEqual(
    f.messages.map((message) => message.kind),
    ["error"],
  );
  assert.equal(f.messages[0]?.title, "My task");
  assert.equal(f.messages[0]?.body, "运行失败");
  f.row.turns = [{ id: "cancelled", status: "interrupted", items: [] }];
  f.host.changed(f.row.id, "turn/completed");
  await delay(0);
  assert.equal(f.messages.length, 1);
  f.row.turns = [
    { id: "failed", status: "failed", items: [] },
    { id: "next", status: "completed", items: [] },
    { id: "queued", status: "inProgress", items: [] },
  ];
  f.host.changed(f.row.id, "turn/completed");
  await delay(0);
  assert.deepEqual(
    f.messages.map((message) => message.kind),
    ["error", "turn"],
  );
});

for (const [method, kind] of [
  ["item/commandExecution/requestApproval", "approval"],
  ["item/fileChange/requestApproval", "approval"],
  ["mcpServer/elicitation/request", "approval"],
  ["item/tool/requestUserInput", "question"],
  ["codexhost/thread/questions/updated", "question"],
] as const)
  it(`pushes current ${kind} on ${method}, only once per request`, async (t) => {
    const f = fixture();
    t.after(() => f.notifications.close());
    const pending: ClientInteraction = {
      threadId: f.row.id,
      requestId: -42,
      kind,
      interaction:
        kind === "approval"
          ? { type: "approval", title: "Allow command?", actions: [] }
          : { type: "question", title: "Choose an option", questions: [] },
      request: { method },
    };
    f.host.pending = [pending];
    f.host.changed(f.row.id, method);
    f.host.changed(f.row.id, method);
    await delay(0);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0]?.kind, kind);
    assert.equal(f.messages[0]?.title, "My task");
    assert.equal(f.messages[0]?.body, kind === "approval" ? "待授权" : "待回答");
    assert.equal(f.host.answers.length, 0);
    f.host.pending = [];
    f.host.changed(f.row.id, method);
    await delay(0);
    assert.equal(f.messages.length, 1, "resolved interactions must not notify");
    f.host.pending = [{ ...pending, requestId: -43 }];
    f.host.changed(f.row.id, method);
    await delay(0);
    assert.equal(f.messages.length, 2);
  });

it("does not read token deltas or read any state without push subscribers", async (t) => {
  const f = fixture();
  t.after(() => f.notifications.close());
  for (let n = 0; n < 100; n++) f.host.changed(f.row.id);
  f.push.subscriptionCount = 0;
  f.host.changed(f.row.id, "turn/completed");
  f.host.changed(f.row.id, "item/tool/requestUserInput");
  await delay(0);
  assert.equal(f.host.snapshots, 0);
  assert.equal(f.messages.length, 0);
  f.push.subscriptionCount = 1;
  f.host.changed(f.row.id, "turn/completed");
  await delay(0);
  assert.equal(f.messages.length, 1);
});

it("accepts journal replay after reconnect without resending a completed turn", async (t) => {
  const f = fixture();
  t.after(() => f.notifications.close());
  f.host.changed(f.row.id, "turn/completed");
  await delay(0);
  f.emit({ type: "connection", online: false });
  f.emit({ type: "connection", online: true });
  const cursor = { epoch: f.host.epoch, sequence: 2 };
  f.emit({ type: "hello", version: 1, cursor, reset: false });
  f.emit({ type: "changed", cursor, threadId: f.row.id, method: "turn/completed" });
  await delay(0);
  assert.equal(f.messages.length, 1);
  // A duplicate delivery of the same event must not even read a snapshot.
  const snapshots = f.host.snapshots;
  f.emit({ type: "changed", cursor, threadId: f.row.id, method: "turn/completed" });
  await delay(0);
  assert.equal(f.host.snapshots, snapshots);
  f.row.turns.push({ id: "new", status: "completed", items: [] });
  const next = { epoch: f.host.epoch, sequence: 3 };
  f.emit({ type: "hello", version: 1, cursor: next, reset: false });
  f.emit({ type: "changed", cursor: next, threadId: f.row.id, method: "turn/completed" });
  await delay(0);
  assert.equal(f.messages.length, 2, "unseen completions in replay still notify");
});

for (const action of ["disconnect", "epoch", "close"])
  it(`discards an in-flight snapshot on ${action}`, async (t) => {
    const f = fixture();
    t.after(() => f.notifications.close());
    const gate = Promise.withResolvers<undefined>();
    f.host.delaySnapshot = () => gate.promise;
    f.host.changed(f.row.id, "turn/completed");
    await delay(0);
    assert.equal(f.host.snapshots, 1);
    if (action === "disconnect") f.host.connection(false);
    else if (action === "epoch") {
      f.host.epoch = randomUUID();
      f.host.connection(true);
    } else f.notifications.close();
    gate.resolve(undefined);
    await delay(0);
    assert.equal(f.messages.length, 0);
    if (action === "close") assert.equal(f.host.listeners.size, 0);
  });
