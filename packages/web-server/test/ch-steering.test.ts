import assert from "node:assert/strict";
import { it } from "node:test";
import { ChThreadView, type ChItem, type ChThread } from "../src/ch-thread-view.ts";
import { defined } from "./support/defined.ts";

function user(id: string, text = id): ChItem {
  return { id, type: "userMessage", clientId: `request-${id}`, content: [{ type: "text", text }] };
}

function command(id: string, status = "completed"): ChItem {
  return { id, type: "commandExecution", command: `echo ${id}`, status, aggregatedOutput: id };
}

function thread(items: ChItem[], status = "inProgress"): ChThread {
  return {
    id: "thread",
    cwd: "/synthetic",
    modelProvider: "codexhost",
    createdAt: 1,
    updatedAt: 2,
    status: { type: status === "inProgress" ? "active" : "idle" },
    turns: [{ id: "turn", status, items }],
  };
}

function view(
  row: ChThread,
  harnessId = "claude-code",
  projectInput?: (input: unknown[]) => unknown[],
) {
  const value = new ChThreadView(
    { ...structuredClone(row), turns: [] },
    harnessId,
    () => {},
    10,
    1000,
    undefined,
    projectInput,
  );
  value.update(structuredClone(row));
  return value;
}

function users(value: ChThreadView) {
  return value.log.events
    .filter((event) => event.type === "user/message")
    .map((event) => event.data as { source: { rpcId?: string }; content: unknown[] });
}

function order(value: ChThreadView): string[] {
  return value.log.events.flatMap((event) => {
    if (event.type === "user/message") {
      const message = event.data as { content: Array<{ text: string }> };
      return [message.content.map((part) => part.text).join("")];
    }
    if (event.type === "tool/call") return [(event.data as { callId: string }).callId];
    return [];
  });
}

for (const harness of ["claude-code", "codex", "custom-harness"])
  for (const status of ["inProgress", "completed"])
    it(`preserves each same-Turn input and position in ${harness} ${status} snapshots`, () => {
      const row = thread(
        [
          user("opening"),
          command("first-tool"),
          user("steer-1"),
          user("steer-2"),
          command("last-tool"),
        ],
        status,
      );
      const value = view(row, harness);
      assert.deepEqual(order(value), ["opening", "first-tool", "steer-1", "steer-2", "last-tool"]);
      assert.deepEqual(
        users(value).map((entry) => entry.source.rpcId),
        ["request-opening", "request-steer-1", "request-steer-2"],
      );
      const count = value.log.events.length;
      value.update(structuredClone(row));
      assert.equal(value.log.events.length, count, "repeated snapshots must not duplicate inputs");
    });

it("appends multiple steers without rebuilding and keeps an in-flight tool's result", () => {
  const row = thread([user("opening"), command("first-tool", "inProgress")]);
  const value = view(row);
  const before = [...value.log.events];
  const turn = defined(row.turns[0]);
  turn.items.push(user("steer-1"));
  value.update(structuredClone(row));
  assert.deepEqual(value.log.events.slice(0, before.length), before);
  assert.deepEqual(order(value), ["opening", "first-tool", "steer-1"]);
  defined(turn.items[1]).status = "completed";
  turn.items.push(command("second-tool"), user("steer-2"), {
    id: "answer",
    type: "agentMessage",
    text: "All done",
    phase: "final_answer",
  });
  turn.status = "completed";
  row.status = { type: "idle" };
  value.update(structuredClone(row));
  value.update(structuredClone(row));
  assert.deepEqual(order(value), ["opening", "first-tool", "steer-1", "second-tool", "steer-2"]);
  assert.equal(users(value).length, 3);
  assert.equal(value.log.events.filter((event) => event.type === "turn/start").length, 1);
  assert.equal(value.log.events.filter((event) => event.type === "turn/end").length, 1);
  assert.equal(value.log.events.filter((event) => event.type === "tool/result").length, 2);
  const end = value.log.events.find((event) => event.type === "turn/end");
  assert.equal(typeof (end?.data as { finalAssistantStep?: number }).finalAssistantStep, "number");
});

it("preserves a steer first observed in the terminal snapshot", () => {
  const row = thread([user("opening"), command("first-tool")]);
  const value = view(row);
  const turn = defined(row.turns[0]);
  turn.items.push(user("steer"), command("last-tool"));
  turn.status = "completed";
  value.update(structuredClone(row));
  assert.deepEqual(order(value), ["opening", "first-tool", "steer", "last-tool"]);
  assert.equal(users(value)[1]?.source.rpcId, "request-steer");
});

it("projects attachments per message rather than combining them into the opening prompt", () => {
  const calls: unknown[][] = [];
  const row = thread([user("opening"), command("tool"), user("steer")]);
  const value = view(row, "custom", (input) => {
    calls.push(input);
    return [...input, { type: "image", id: calls.length }];
  });
  assert.deepEqual(calls, [[{ type: "text", text: "opening" }], [{ type: "text", text: "steer" }]]);
  assert.equal(users(value)[0]?.content.length, 2);
  assert.equal(users(value)[1]?.content.length, 2);
});

it("does not borrow another input's clientId when the opening input has none", () => {
  const opening = { ...user("opening"), clientId: null };
  const value = view(thread([opening, command("tool"), user("steer")]));
  assert.equal(users(value)[0]?.source.rpcId, undefined);
  assert.equal(users(value)[1]?.source.rpcId, "request-steer");
});

it("keeps identical text submissions separate by identity", () => {
  const value = view(thread([user("opening", "same text"), user("steer", "same text")]));
  assert.deepEqual(
    users(value).map((entry) => entry.source.rpcId),
    ["request-opening", "request-steer"],
  );
  assert.deepEqual(order(value), ["same text", "same text"]);
});

it("keeps autonomous output before later input without a synthetic empty user bubble", () => {
  const row = thread([command("tool")]);
  const value = view(row);
  assert.equal(users(value).length, 0);
  defined(row.turns[0]).items.push(user("steer"));
  value.update(structuredClone(row));
  assert.deepEqual(order(value), ["tool", "steer"]);
  assert.deepEqual(order(view(row)), ["tool", "steer"]);
});

it("accepts initial input arriving before any output", () => {
  const row = thread([]);
  const value = view(row);
  defined(row.turns[0]).items.push(user("opening"), command("tool"));
  value.update(structuredClone(row));
  assert.deepEqual(order(value), ["opening", "tool"]);
  assert.equal(users(value).length, 1);
});

for (const mutation of [
  "replace",
  "remove",
  "reorder",
  "move-across-output",
  "identity",
  "late-insert",
] as const)
  it(`requests a history rebuild for ${mutation} rather than silently changing displayed input`, () => {
    const row = thread([user("opening"), command("tool"), user("steer")]);
    const value = view(row);
    const items = defined(row.turns[0]).items;
    if (mutation === "replace") items[2] = user("steer", "edited");
    if (mutation === "remove") items.pop();
    if (mutation === "reorder") [items[0], items[2]] = [defined(items[2]), defined(items[0])];
    if (mutation === "move-across-output")
      [items[1], items[2]] = [defined(items[2]), defined(items[1])];
    if (mutation === "identity") defined(items[2]).clientId = "another-request";
    if (mutation === "late-insert") items.splice(1, 0, user("late"));
    const count = value.log.events.length;
    assert.throws(() => value.update(structuredClone(row)), { code: "host/items-replaced" });
    assert.equal(value.log.events.length, count, "rejected update must not partially publish");
    const rebuilt = view(row);
    assert.deepEqual(
      users(rebuilt).map((entry) => entry.source.rpcId),
      items.filter((item) => item.type === "userMessage").map((item) => item.clientId),
    );
  });

it("rebuilds when the opening input arrives behind already displayed output", () => {
  const row = thread([command("tool")]);
  const value = view(row);
  defined(row.turns[0]).items.unshift(user("opening"));
  assert.throws(() => value.update(structuredClone(row)), { code: "host/items-replaced" });
  assert.deepEqual(order(view(row)), ["opening", "tool"]);
});

it("rebuilds when a completed Turn gains an input instead of dropping it", () => {
  const row = thread([user("opening")], "completed");
  const value = view(row);
  defined(row.turns[0]).items.push(user("steer"));
  assert.throws(() => value.update(structuredClone(row)), { code: "host/items-replaced" });
  assert.equal(users(view(row)).length, 2);
});

it("preserves steered inputs when prepending history and keeps the loaded tail stable", () => {
  const value = view(thread([user("latest")], "completed"));
  const tail = [...value.log.events];
  value.prepend([
    { id: "older", status: "completed", items: [user("old"), command("tool"), user("steer")] },
  ]);
  assert.deepEqual(order(value), ["old", "tool", "steer", "latest"]);
  assert.deepEqual(value.log.events.slice(-tail.length), tail);
});

it("rebuilds immediately when a late command belongs before an already displayed steer", () => {
  const row = thread([user("opening"), user("steer")]);
  const value = view(row, "codex");
  defined(row.turns[0]).items.splice(1, 0, command("late-tool"));
  const count = value.log.events.length;
  assert.throws(() => value.update(structuredClone(row)), { code: "host/items-replaced" });
  assert.equal(value.log.events.length, count);
  assert.deepEqual(order(view(row, "codex")), ["opening", "late-tool", "steer"]);
});

it("rebuilds when a command is first reported after its Turn completed", () => {
  const row = thread([user("opening")], "completed");
  const value = view(row, "codex");
  defined(row.turns[0]).items.push(command("late-tool"));
  assert.throws(() => value.update(structuredClone(row)), { code: "host/items-replaced" });
  assert.deepEqual(order(view(row, "codex")), ["opening", "late-tool"]);
});

it("rebuilds for actual command completion after an interrupted Turn", () => {
  const row = thread([user("opening"), command("tool", "inProgress")], "interrupted");
  const value = view(row, "codex");
  defined(defined(row.turns[0]).items[1]).status = "completed";
  assert.throws(() => value.update(structuredClone(row)), { code: "host/items-replaced" });
  const rebuilt = view(row, "codex");
  const count = rebuilt.log.events.length;
  rebuilt.update(structuredClone(row));
  assert.equal(rebuilt.log.events.length, count);
});

it("keeps stop-then-start and queued follow-ups in separate Turns", () => {
  const row = thread([user("opening"), command("tool")], "interrupted");
  row.turns.push({ id: "replacement", status: "completed", items: [user("replacement")] });
  row.turns.push({ id: "queued", status: "completed", items: [user("queued")] });
  const value = view(row, "pi");
  assert.deepEqual(order(value), ["opening", "tool", "replacement", "queued"]);
  assert.equal(value.log.events.filter((event) => event.type === "turn/start").length, 3);
});
