import assert from "node:assert/strict";
import { it } from "node:test";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

for (const status of ["completed", "failed", "interrupted"]) {
  it(`projects manual compression ${status} without inserting a native Turn`, async () => {
    const host = new FakeChChannel();
    const row = host.add("compaction", "/project");
    row.turns = [];
    const view = new ChThreadHistory(host, row, "fake", () => {});
    await view.refresh();
    const turn = { id: "command-1", status: "inProgress", items: [] };
    host.commands.set(row.id, { name: "compact", turn });
    row.status = { type: "active" };
    await view.refresh(true);
    assert.equal(view.log.projections.compacting, true);
    assert.deepEqual(
      view.log.events.filter((e) => e.type === "command/run").map((e) => e.data),
      [{ commandId: turn.id, name: "compact", source: { kind: "user" } }],
    );
    await view.refresh(true);
    assert.equal(view.log.events.filter((e) => e.type === "command/run").length, 1);
    turn.status = status;
    row.status = { type: "idle" };
    if (status === "failed")
      Object.assign(turn, { error: { message: "Native compression failed" } });
    await view.refresh(true);
    await view.refresh(); // Idle fast path must also preserve, not duplicate, settlement.
    assert.equal(view.log.projections.compacting, false);
    assert.deepEqual(
      view.log.events.filter((e) => e.type === "command/done").map((e) => e.data),
      [
        {
          commandId: turn.id,
          kind: status === "completed" ? "success" : "error",
          ...(status === "failed"
            ? { text: "Native compression failed" }
            : status === "interrupted"
              ? { text: "Command cancelled." }
              : {}),
        },
      ],
    );
    assert.equal(
      view.log.events.some((e) => e.type === "turn/start"),
      false,
    );
    assert.deepEqual(view.thread.turns, []);

    const reopened = new ChThreadHistory(host, row, "fake", () => {});
    await reopened.refresh();
    assert.equal(reopened.log.events.filter((e) => e.type === "command/run").length, 1);
    assert.equal(reopened.log.events.filter((e) => e.type === "command/done").length, 1);
  });
}

for (const harnessId of ["grok", "pi"]) {
  for (const status of ["completed", "failed", "interrupted"]) {
    it(`does not append an old ${harnessId} compact ${status} after later Turns on reopen`, async () => {
      const host = new FakeChChannel();
      const row = host.add("old-compaction", "/project");
      row.turns = Array.from({ length: 7 }, (_, index) => ({
        id: `later-${index}`,
        status: index === 6 ? "inProgress" : "completed",
        items: [
          {
            id: `user-${index}`,
            type: "userMessage",
            content: [{ type: "text", text: `Later prompt ${index}` }],
          },
        ],
      }));
      const command = {
        name: "compact",
        turn: { id: "old-compact", status, items: [] },
        subsequentTurnId: "later-0", // Outside the initial five-Turn page.
      };
      host.commands.set(row.id, command);
      row.status = { type: "active" };
      const view = new ChThreadHistory(host, row, harnessId, () => {});
      await view.refresh();
      assert.equal(view.log.events.filter((event) => event.type.startsWith("command/")).length, 0);
      for (const turn of row.turns) turn.status = "completed";
      row.status = { type: "idle" };
      await view.refresh(true);
      await view.refresh();
      await view.loadOlder();
      assert.equal(view.thread.turns.length, 7);
      assert.equal(view.log.projections.compacting, false);
      assert.equal(view.log.events.filter((event) => event.type.startsWith("command/")).length, 0);

      // A new explicit command must still be reported, even after skipping an old one.
      host.commands.set(row.id, {
        name: "compact",
        turn: { id: "new-compact", status: "completed", items: [] },
      });
      await view.refresh();
      assert.deepEqual(
        view.log.events.filter((event) => event.type === "command/run").map((event) => event.data),
        [{ commandId: "new-compact", name: "compact", source: { kind: "user" } }],
      );
      assert.equal(view.log.events.filter((event) => event.type === "command/done").length, 1);
    });
  }
}

it("settles an already displayed command even if the next Turn started between snapshots", async () => {
  const host = new FakeChChannel();
  const row = host.add("observed-compaction", "/project");
  row.turns = [];
  const command = { name: "compact", turn: { id: "compact", status: "inProgress", items: [] } };
  host.commands.set(row.id, command);
  const view = new ChThreadHistory(host, row, "pi", () => {});
  await view.refresh();
  command.turn.status = "completed";
  host.commands.set(row.id, { ...command, subsequentTurnId: "later" });
  row.turns.push({ id: "later", status: "inProgress", items: [] });
  row.status = { type: "active" };
  await view.refresh(true);
  assert.equal(view.log.projections.compacting, false);
  assert.equal(view.log.events.filter((event) => event.type === "command/run").length, 1);
  assert.equal(view.log.events.filter((event) => event.type === "command/done").length, 1);
  const run = view.log.events.find((event) => event.type === "command/run");
  const later = view.log.events.find((event) => event.type === "turn/start");
  assert.ok(run && later && run.seq < later.seq);
});

it("closes an observed command if its result was replaced by an unobserved old command", async () => {
  const host = new FakeChChannel();
  const row = host.add("replaced-compaction", "/project");
  row.turns = [];
  host.commands.set(row.id, {
    name: "compact",
    turn: { id: "observed", status: "inProgress", items: [] },
  });
  const view = new ChThreadHistory(host, row, "pi", () => {});
  await view.refresh();
  host.commands.set(row.id, {
    name: "compact",
    turn: { id: "unobserved", status: "completed", items: [] },
    subsequentTurnId: "later",
  });
  row.turns.push({ id: "later", status: "completed", items: [] });
  await view.refresh(true);
  await view.refresh();
  assert.equal(view.log.projections.compacting, false);
  assert.equal(view.log.events.filter((event) => event.type === "command/run").length, 1);
  assert.deepEqual(
    view.log.events.filter((event) => event.type === "command/done").map((event) => event.data),
    [
      {
        commandId: "observed",
        kind: "error",
        text: "The Host no longer reports the outcome of this command.",
      },
    ],
  );
});

it("recovers a manual command completed between snapshots, even with unchanged idle history", async () => {
  const host = new FakeChChannel();
  const row = host.add("compaction", "/project");
  row.turns = [];
  const view = new ChThreadHistory(host, row, "fake", () => {});
  await view.refresh();
  host.commands.set(row.id, {
    name: "compact",
    turn: { id: "fast", status: "completed", items: [] },
  });
  await view.refresh();
  assert.deepEqual(
    view.log.events.map((e) => e.type),
    ["command/run", "command/done"],
  );
});

it("recognizes native compression inside another explicit command without labelling it manual", async () => {
  const host = new FakeChChannel();
  const row = host.add("command-auto", "/project");
  row.turns = [];
  row.status = { type: "active" };
  const item = { id: "auto-in-init", type: "contextCompaction", status: "inProgress" };
  host.commands.set(row.id, {
    name: "init",
    turn: { id: "init-command", status: "inProgress", items: [item] },
  });
  const view = new ChThreadHistory(host, row, "fake", () => {});
  await view.refresh();
  assert.equal(view.log.projections.compacting, true);
  assert.equal(
    (view.log.events.find((e) => e.type === "command/run")?.data as { name: string }).name,
    "init",
  );
  item.status = "completed";
  await view.refresh(true);
  assert.equal(view.log.projections.compacting, false);
  assert.equal(
    view.log.events.some((e) => e.type === "command/done"),
    false,
  );
});

it("finishes native compaction presentation before the Turn ends and keeps it finished on reopen", async () => {
  const host = new FakeChChannel();
  const row = host.add("codex-compaction", "/project");
  const item = { id: "compact", type: "contextCompaction", status: "inProgress" };
  row.turns = [{ id: "turn", status: "inProgress", items: [item] }];
  row.status = { type: "active" };
  const view = new ChThreadHistory(host, row, "codex", () => {});
  await view.refresh();
  assert.equal(view.log.projections.compacting, true);
  item.status = "completed";
  await view.refresh(true);
  await view.refresh(true);
  assert.equal(view.log.projections.compacting, false);
  assert.equal(view.log.events.filter((event) => event.type === "tool/call").length, 1);
  assert.equal(view.log.events.filter((event) => event.type === "tool/result").length, 1);
  assert.equal(
    view.log.events.some((event) => event.type === "turn/end"),
    false,
  );

  const reopened = new ChThreadHistory(host, row, "codex", () => {});
  await reopened.refresh();
  assert.equal(reopened.log.projections.compacting, false);
  assert.equal(reopened.log.events.filter((event) => event.type === "tool/result").length, 1);
  assert.equal(
    reopened.log.events.some((event) => event.type === "command/run"),
    false,
  );
});

it("settles an automatic compaction row while the ordinary Turn keeps running", async () => {
  const host = new FakeChChannel();
  const row = host.add("automatic", "/project");
  const item = {
    id: "auto",
    type: "contextCompaction",
    status: "inProgress",
    error: { message: "Summary failed" },
  };
  row.turns = [{ id: "normal", status: "inProgress", items: [item] }];
  row.status = { type: "active" };
  const view = new ChThreadHistory(host, row, "fake", () => {});
  await view.refresh();
  assert.equal(view.log.projections.compacting, true);
  item.status = "failed";
  await view.refresh(true);
  assert.equal(view.log.projections.compacting, false);
  assert.equal(
    view.log.events.some((e) => e.type === "turn/end"),
    false,
  );
  assert.equal(
    view.log.events.some((e) => e.type === "command/run"),
    false,
  );
  const result = view.log.events.find((e) => e.type === "tool/result");
  assert.ok(result);
  assert.match(JSON.stringify(result.data), /Summary failed/u);
  assert.doesNotMatch(JSON.stringify(result.data), /Context compacted/u);
});
