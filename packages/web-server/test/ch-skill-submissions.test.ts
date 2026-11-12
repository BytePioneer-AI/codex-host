import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import { harnessCommandMentionPath, type HarnessCommandCatalog } from "@codexhost/shared-contracts";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import type { ChHostClient } from "../src/ch-host-client.ts";
import { skillHost } from "./support/skill-host.ts";

async function eventually(check: () => void | Promise<void>) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

async function fixture(t: TestContext, harnessId: "pi" | "claude-code") {
  const f = await skillHost(harnessId);
  t.after(() => f.close());
  const host: ChHostClient = {
    request: f.request,
    projects: async () => ({ projects: [], assignments: {}, projectless: [] }),
    pins: async () => [],
    close: () => undefined,
    realtime: {
      request: f.request,
      snapshot: (id, options) => f.host.clientSnapshot(id, options),
      respond: (response) => f.host.respondClient(response),
      subscribe: (listener, after) => f.host.clientEvents.subscribe(listener, after),
    },
  };
  await f.request("turn/start", {
    threadId: f.threadId,
    clientUserMessageId: "warm",
    input: [{ type: "text", text: "warm" }],
  });
  await eventually(async () =>
    assert.equal((await f.host.clientSnapshot(f.threadId)).activeTurnId, null),
  );
  const catalog = await f.request<HarnessCommandCatalog>("codexhost/thread/commands/inspect", {
    threadId: f.threadId,
  });
  const skill = catalog.commands.find((command) => command.kind === "skill");
  assert.ok(skill, "Real Adapter must expose its native Skill");
  assert.equal("executionMode" in skill, false);
  const text = `[@${skill.label}](${harnessCommandMentionPath(skill.invocation, "skill")}) Explain this task`;
  const submit = (id: string, extra: Record<string, unknown> = {}) =>
    f.request("turn/start", {
      threadId: f.threadId,
      clientUserMessageId: id,
      input: [{ type: "text", text }],
      ...extra,
    });
  const snapshot = await f.host.clientSnapshot(f.threadId);
  const view = new ChThreadHistory(host, snapshot.thread, harnessId, () => undefined);
  await view.refresh();
  const frames: unknown[] = [];
  view.log.follow(
    {
      id: "test",
      closed: false,
      push: (value) => frames.push(value),
      end: () => undefined,
      fail: () => undefined,
      onClose: (close) => t.after(close),
    },
    { assistantStream: true },
  );
  return { ...f, gateway: host, catalog, skill, text, submit, view, frames };
}

for (const harnessId of ["pi", "claude-code"] as const) {
  it(`${harnessId}: real native catalogue and command execution stream a conversation through Host to Web`, async (t) => {
    const f = await fixture(t, harnessId);
    const accepted = await f.submit("skill");
    assert.deepEqual(await f.submit("skill"), accepted);
    assert.equal(f.inputs.at(-1), `${f.skill.invocation} Explain this task`);
    f.delta("Working on the task");
    await eventually(async () => {
      await f.view.refresh(true);
      assert.match(JSON.stringify(f.frames), /Working on the task/);
    });
    assert.equal(
      f.view.log.events.some((event) => event.type === "command/run"),
      false,
    );
    assert.match(JSON.stringify(f.view.log.events), /"rpcId":"skill"/);
    assert.match(JSON.stringify(f.view.log.events), /codexhost-skill/);
    f.finish();
    await eventually(async () => {
      const snapshot = await f.host.clientSnapshot(f.threadId);
      assert.equal(snapshot.activeTurnId, null);
      assert.equal(snapshot.command, undefined);
      assert.deepEqual(
        snapshot.submissions?.find((entry) => entry.clientUserMessageId === "skill"),
        {
          clientUserMessageId: "skill",
          turnId: snapshot.turnsPage.data[0]?.id,
          status: "completed",
          execution: "conversation",
        },
      );
    });
    await f.request("thread/turns/list", { threadId: f.threadId, itemsView: "full" });
    const snapshot = await f.host.clientSnapshot(f.threadId);
    const reopened = new ChThreadHistory(f.gateway, snapshot.thread, harnessId, () => undefined);
    await reopened.refresh();
    assert.equal(reopened.log.events.filter((event) => event.type === "user/message").length, 2);
    assert.match(JSON.stringify(reopened.log.events), /codexhost-skill/);
    assert.equal(
      reopened.log.events.some((event) => event.type === "command/run"),
      false,
    );
  });

  it(`${harnessId}: compact confirms only its own submission without a conversation echo`, async (t) => {
    const f = await fixture(t, harnessId);
    await f.request("turn/start", {
      threadId: f.threadId,
      clientUserMessageId: "compact",
      input: [{ type: "text", text: "/compact" }],
    });
    await eventually(async () => {
      await f.view.refresh(true);
      const receipts = f.view.ownerSnapshot?.submissions;
      assert.equal(
        receipts?.find((entry) => entry.clientUserMessageId === "compact")?.status,
        "completed",
      );
      assert.equal(
        receipts?.find((entry) => entry.clientUserMessageId === "compact")?.execution,
        "operation",
      );
      assert.equal(f.view.ownerSnapshot?.turnsPage.data.length, 1);
      assert.equal(f.view.log.events.filter((event) => event.type === "command/done").length, 1);
    });
    assert.equal(f.view.log.events.filter((event) => event.type === "user/message").length, 1);
    assert.equal(f.view.log.projections.compacting, false);
  });

  it(`${harnessId}: queue, failure and cancellation retain per-submission identities`, async (t) => {
    const f = await fixture(t, harnessId);
    await f.submit("first");
    await f.submit("second", { delivery: "queue" });
    let snapshot = await f.host.clientSnapshot(f.threadId);
    assert.equal(snapshot.queue?.items[0]?.clientUserMessageId, "second");
    f.delta("First answer");
    f.finish();
    await eventually(() => assert.equal(f.inputs.length, 3));
    snapshot = await f.host.clientSnapshot(f.threadId);
    assert.equal(
      snapshot.submissions?.find((entry) => entry.clientUserMessageId === "first")?.status,
      "completed",
    );
    assert.notEqual(
      snapshot.submissions?.find((entry) => entry.clientUserMessageId === "second")?.status,
      "completed",
    );
    f.delta("Failed second");
    f.finish("failed");
    await eventually(async () =>
      assert.equal(
        (await f.host.clientSnapshot(f.threadId)).submissions?.find(
          (entry) => entry.clientUserMessageId === "second",
        )?.status,
        "failed",
      ),
    );
    await f.request("turn/start", {
      threadId: f.threadId,
      clientUserMessageId: "third",
      input: [{ type: "text", text: "Ordinary follow-up" }],
    });
    snapshot = await f.host.clientSnapshot(f.threadId);
    await f.request("turn/interrupt", { threadId: f.threadId, turnId: snapshot.activeTurnId });
    await eventually(async () =>
      assert.equal(
        (await f.host.clientSnapshot(f.threadId)).submissions?.find(
          (entry) => entry.clientUserMessageId === "third",
        )?.status,
        "cancelled",
      ),
    );
  });
}

it("a Pi extension consumed without an agent run settles through Host and Web without native history", async (t) => {
  const f = await fixture(t, "pi");
  assert.ok(f.catalog.commands.some((command) => command.invocation === "/local"));
  await f.request("turn/start", {
    threadId: f.threadId,
    clientUserMessageId: "local",
    input: [{ type: "text", text: "/local" }],
  });
  await eventually(async () => {
    await f.view.refresh(true);
    const operation = f.view.ownerSnapshot?.command;
    assert.ok(operation);
    assert.equal(operation.name, "local");
    assert.equal(operation.turn.status, "completed");
    assert.deepEqual(operation.turn.items, []);
    assert.deepEqual(
      f.view.ownerSnapshot?.submissions?.find((entry) => entry.clientUserMessageId === "local"),
      {
        clientUserMessageId: "local",
        turnId: operation.turn.id,
        status: "completed",
        execution: "operation",
        operation,
      },
    );
    assert.equal(f.view.ownerSnapshot?.activeTurnId, null);
    assert.equal(f.view.ownerSnapshot?.turnsPage.data.length, 1);
    assert.equal(f.view.log.events.filter((event) => event.type === "user/message").length, 1);
    assert.equal(f.view.log.events.filter((event) => event.type === "command/done").length, 1);
  });
});
