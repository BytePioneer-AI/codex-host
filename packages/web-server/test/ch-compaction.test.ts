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
