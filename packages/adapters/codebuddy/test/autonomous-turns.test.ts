import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate as tick } from "node:timers/promises";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { fixture } from "./fixtures.js";

type Native = ReturnType<typeof fixture>;
type FakeClient = Native["clients"][number];
type HostEvent = Extract<HarnessOutput, { kind: "event" }>["event"];

const adapters: CodeBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

function adapterFor(native: Native, readHistory?: Native["readHistory"]): CodeBuddyAdapter {
  const adapter = new CodeBuddyAdapter({ ...native, ...(readHistory ? { readHistory } : {}) });
  adapters.push(adapter);
  return adapter;
}
async function create(adapter: CodeBuddyAdapter) {
  const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
  if (!opened.ok) throw Error(opened.error.message);
  return opened.value;
}
function setup(readHistory?: Native["readHistory"]) {
  const native = fixture();
  return { native, adapter: adapterFor(native, readHistory) };
}
function collect(session: HarnessSession) {
  const outputs: HarnessOutput[] = [];
  const closed = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  const events = () => outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
  return {
    outputs,
    closed,
    events,
    completed: async (count = 1) => {
      await vi.waitFor(
        () =>
          expect(events().filter((event) => event.type === "turn.completed")).toHaveLength(count),
        { timeout: 3000 },
      );
      return events().filter((event) => event.type === "turn.completed");
    },
    autonomousTurnIds: () =>
      events().flatMap((event) => (event.type === "turn.autonomous.started" ? [event.turnId] : [])),
    faults: () => events().filter((event) => event.type === "session.faulted"),
  };
}
const turn = (id: string, input = "hello") => ({
  type: "turn.start" as const,
  turnId: hostTurnIdSchema.parse(id),
  input: [{ type: "text" as const, text: input }],
});

/** Native drain Turn rows: hidden meta input rows and the agent's answer. */
function persistDrain(
  native: Native,
  key: string,
  reply = key,
  timestamp = Date.now(),
  extraRows = 0,
) {
  let parent = native.history.at(-1)?.id;
  for (let index = 0; index <= extraRows; index += 1) {
    const id = extraRows ? `${key}-user-${index}` : `${key}-user`;
    native.history.push({
      type: "message",
      role: "user",
      id,
      ...(parent === undefined ? {} : { parentId: parent }),
      timestamp,
      providerData: { isMeta: true },
      content: [
        {
          type: "input_text",
          text: `<task-notification>background task ${index} completed</task-notification>`,
        },
      ],
    });
    parent = id;
  }
  native.history.push({
    type: "message",
    role: "assistant",
    id: `${key}-answer`,
    parentId: parent,
    status: "completed",
    timestamp,
    content: [{ type: "output_text", text: reply }],
  });
}
function announce(client: FakeClient, requestId: string) {
  client.update({
    sessionUpdate: "session_info_update",
    _meta: {
      "codebuddy.ai/unsolicitedTurn": { requestId, reason: "background_drain" },
      "codebuddy.ai/requestId": requestId,
    },
  });
}
function autonomousText(client: FakeClient, requestId: string, messageId: string, text: string) {
  client.update({
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
    _meta: { "codebuddy.ai/requestId": requestId },
  });
}
function endAutonomous(client: FakeClient, requestId: string) {
  client.update({
    sessionUpdate: "session_end",
    stopReason: "end_turn",
    _meta: { "codebuddy.ai/requestId": requestId },
  });
}
function itemsFor(events: HostEvent[], turnId: string) {
  return events.flatMap((event) =>
    event.type === "item.started" && event.turnId === turnId ? [event.item] : [],
  );
}

/** Blocks one readHistory call so a native frame can be delivered at a deterministic point. */
function gatedHistory(native: Native, call: number) {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let calls = 0;
  let blocked = false;
  return {
    entered: entered.promise,
    release: () => release.resolve(undefined),
    readHistory: (async (...args: Parameters<Native["readHistory"]>) => {
      // A fresh Session may have no native history yet; the gate cares about the position.
      const contents = await native.readHistory(...args).catch(() => "");
      calls += 1;
      if (!blocked && calls === call) {
        blocked = true;
        entered.resolve(undefined);
        await release.promise;
      }
      return contents;
    }) satisfies Native["readHistory"],
  };
}

describe("CodeBuddy native autonomous Turns", () => {
  it("projects an idle unsolicited drain as one autonomous Turn with no input", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "drain-request");
    autonomousText(client, "drain-request", "drain-answer", "the answer");
    persistDrain(native, "drain", "the answer");
    endAutonomous(client, "drain-request");

    const completed = await events.completed();
    const [turnId] = events.autonomousTurnIds();
    if (!turnId) throw Error("No autonomous Turn started");
    expect(events.events()).toContainEqual({ type: "turn.started", turnId });
    expect(events.autonomousTurnIds()).toHaveLength(1);
    expect(completed).toMatchObject([
      {
        turnId,
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: "drain-user" },
      },
    ]);
    expect(itemsFor(events.events(), turnId)).toMatchObject([{ type: "agentMessage", text: "" }]);
    expect(
      events.events().filter((event) => event.type === "item.updated" && event.turnId === turnId),
    ).toMatchObject([{ update: { type: "text.append", text: "the answer" } }]);
    await session.close();
  });

  it("associates a completed drain whose native timestamp precedes Host receipt", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    persistDrain(native, "delayed", "delayed", Date.now() - 10);
    announce(client, "delayed");
    autonomousText(client, "delayed", "delayed-answer", "delayed");
    endAutonomous(client, "delayed");

    expect(await events.completed()).toMatchObject([
      {
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: "delayed-user" },
      },
    ]);
    await session.close();
  });

  it("keeps a Host Turn's identity when a drain is persisted before its terminal snapshot", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    await session.execute(turn("host", "hold"));
    client.finishPending();
    announce(client, "next");
    autonomousText(client, "next", "next-answer", "next");
    persistDrain(native, "next", "next");
    endAutonomous(client, "next");

    const completed = await events.completed(2);
    expect(completed[0]).toMatchObject({
      turnId: "host",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: "user-1" },
    });
    expect(completed[1]).toMatchObject({
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: "next-user" },
    });
    expect(itemsFor(events.events(), "host")).toMatchObject([{ type: "agentMessage", text: "" }]);
    expect(itemsFor(events.events(), "host")).not.toContainEqual(
      expect.objectContaining({ text: "next" }),
    );
  });

  it("rejects a Host Turn that raced a drain announced during admission", async () => {
    const native = fixture();
    const gate = gatedHistory(native, 1);
    const adapter = adapterFor(native, gate.readHistory);
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    const starting = session.execute(turn("host"));
    await gate.entered;
    announce(client, "arrived");
    persistDrain(native, "arrived");
    gate.release();
    expect(await starting).toMatchObject({ error: { code: "sessionBusy" } });
    expect(
      events.events().filter((event) => event.type === "turn.started" && event.turnId === "host"),
    ).toHaveLength(0);

    endAutonomous(client, "arrived");
    await events.completed();
    await session.close();
  });

  it("queues serial native rounds while the first terminal history read is pending", async () => {
    const native = fixture();
    const gate = gatedHistory(native, 1);
    const adapter = adapterFor(native, gate.readHistory);
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "one");
    persistDrain(native, "one");
    endAutonomous(client, "one");
    await gate.entered;
    for (const requestId of ["two", "three"]) {
      announce(client, requestId);
      persistDrain(native, requestId);
      endAutonomous(client, requestId);
    }
    gate.release();

    const completed = await events.completed(3);
    expect(events.faults()).toEqual([]);
    expect(events.autonomousTurnIds()).toHaveLength(3);
    expect(completed.map((event) => event.nativeTurnRef?.nativeTurnKey)).toEqual([
      "one-user",
      "two-user",
      "three-user",
    ]);
    await session.close();
  });

  it("faults a genuinely overlapping native start before the prior session_end", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "unfinished");
    announce(client, "overlapping");
    await vi.waitFor(() => expect(events.faults()).toHaveLength(1));
    expect(events.faults()[0]).toMatchObject({
      error: {
        code: "protocolError",
        message: expect.stringContaining("Native autonomous Turns overlapped"),
      },
    });
    await events.closed;
  });

  it("keeps consecutive drain rounds in separate autonomous Turns", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "round-1");
    autonomousText(client, "round-1", "round-1-answer", "first");
    persistDrain(native, "round-1", "first");
    endAutonomous(client, "round-1");
    await events.completed(1);

    announce(client, "round-2");
    autonomousText(client, "round-2", "round-2-answer", "second");
    persistDrain(native, "round-2", "second");
    endAutonomous(client, "round-2");
    const completed = await events.completed(2);

    expect(events.autonomousTurnIds()).toHaveLength(2);
    expect(new Set(events.autonomousTurnIds()).size).toBe(2);
    expect(
      completed.map((event) =>
        event.type === "turn.completed" ? event.nativeTurnRef?.nativeTurnKey : undefined,
      ),
    ).toEqual(["round-1-user", "round-2-user"]);
    await session.close();
  });

  it("uses adjacent hidden input rows from one native run as one Turn boundary", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    persistDrain(native, "grouped", "grouped", Date.now(), 2);
    announce(client, "grouped");
    autonomousText(client, "grouped", "grouped-answer", "grouped");
    endAutonomous(client, "grouped");

    const completed = await events.completed();
    expect(completed).toMatchObject([
      { outcome: { status: "succeeded" }, nativeTurnRef: { nativeTurnKey: "grouped-user-0" } },
    ]);
    await session.close();
  });

  it("buffers a drain that arrives while a Host Turn is still finishing", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    const accepted = await session.execute(turn("host", "hold"));
    expect(accepted.ok).toBe(true);
    announce(client, "buffered");
    autonomousText(client, "buffered", "buffered-answer", "buffered reply");
    client.finishPending();
    await events.completed(1);
    persistDrain(native, "buffered", "buffered reply");
    endAutonomous(client, "buffered");
    await events.completed(2);

    const order = events
      .events()
      .flatMap((event, index) =>
        event.type === "turn.completed" && event.turnId === "host"
          ? [`host-completed:${index}`]
          : event.type === "turn.autonomous.started"
            ? [`autonomous-started:${index}`]
            : [],
      );
    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/^host-completed:/u);
    expect(order[1]).toMatch(/^autonomous-started:/u);
    expect(itemsFor(events.events(), "host")).toMatchObject([{ type: "agentMessage", text: "" }]);
    expect(itemsFor(events.events(), "host")).not.toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("buffered reply") }),
    );
    const [autonomousTurnId] = events.autonomousTurnIds();
    if (!autonomousTurnId) throw Error("No autonomous Turn started");
    expect(itemsFor(events.events(), autonomousTurnId)).toMatchObject([{ type: "agentMessage" }]);
  });

  it("binds a buffered drain approval to the drain Turn instead of the Host Turn", async () => {
    const native = fixture();
    const gate = gatedHistory(native, 2);
    const adapter = adapterFor(native, gate.readHistory);
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    await session.execute(turn("host", "hold"));
    client.finishPending();
    await gate.entered;
    announce(client, "approval-drain");
    persistDrain(native, "approval");
    const answer = client.context.handlers.permission({
      sessionId: "native-session",
      toolCall: {
        toolCallId: "drain-call",
        rawInput: { file_path: "drain.txt" },
        _meta: { "codebuddy.ai/toolName": "Write" },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    gate.release();

    await vi.waitFor(() =>
      expect(events.outputs.some((output) => output.kind === "interaction")).toBe(true),
    );
    const interaction = events.outputs.find((output) => output.kind === "interaction");
    if (interaction?.kind !== "interaction") throw Error("No interaction");
    expect(interaction.interaction.turnId).not.toBe("host");
    expect(interaction.interaction.turnId).toBe(events.autonomousTurnIds()[0]);
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: interaction.interaction.interactionId,
        response: { type: "approval", actionId: "allow" },
      }),
    ).toMatchObject({ ok: true });
    await expect(answer).resolves.toMatchObject({ outcome: { outcome: "selected" } });
    endAutonomous(client, "approval-drain");
    await events.completed(2);
  });

  it("binds a buffered drain question to the drain Turn", async () => {
    const native = fixture();
    const gate = gatedHistory(native, 2);
    const adapter = adapterFor(native, gate.readHistory);
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    await session.execute(turn("host", "hold"));
    client.finishPending();
    await gate.entered;
    announce(client, "question-drain");
    persistDrain(native, "question");
    const answer = client.context.handlers.permission({
      sessionId: "native-session",
      toolCall: {
        toolCallId: "drain-question",
        rawInput: {
          questions: [{ question: "Choose?", options: [{ label: "Alpha" }, { label: "Beta" }] }],
        },
        _meta: { "codebuddy.ai/toolName": "AskUserQuestion" },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    gate.release();

    await vi.waitFor(() =>
      expect(events.outputs.some((output) => output.kind === "interaction")).toBe(true),
    );
    const interaction = events.outputs.find((output) => output.kind === "interaction");
    if (interaction?.kind !== "interaction") throw Error("No interaction");
    expect(interaction.interaction.type).toBe("question");
    expect(interaction.interaction.turnId).toBe(events.autonomousTurnIds()[0]);
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: interaction.interaction.interactionId,
        response: { type: "question", answers: { q_0: ["Alpha"] } },
      }),
    ).toMatchObject({ ok: true });
    await expect(answer).resolves.toMatchObject({ outcome: { outcome: "cancelled" } });
    endAutonomous(client, "question-drain");
    await events.completed(2);
  });

  it("rejects Host Turn starts while an autonomous Turn owns the Session", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "busy");
    const busy = await session.execute(turn("blocked"));
    expect(busy).toMatchObject({ error: { code: "sessionBusy" } });
    expect(
      events
        .events()
        .filter((event) => event.type === "turn.started" && event.turnId === "blocked"),
    ).toHaveLength(0);

    persistDrain(native, "busy", "done");
    autonomousText(client, "busy", "busy-answer", "done");
    endAutonomous(client, "busy");
    await events.completed(1);

    expect(await session.execute(turn("after"))).toMatchObject({ ok: true });
    await events.completed(2);
    await session.close();
  });

  it("cancels an autonomous Turn through the native cancel once", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "cancel-me");
    autonomousText(client, "cancel-me", "cancel-answer", "partial");
    await vi.waitFor(() => expect(events.autonomousTurnIds()).toHaveLength(1));
    const [turnId] = events.autonomousTurnIds();
    if (!turnId) throw Error("No autonomous Turn started");

    expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({ ok: true });
    expect(client.cancelPoisoned).toBe(true);
    persistDrain(native, "cancel", "partial");
    endAutonomous(client, "cancel-me");
    const completed = await events.completed();
    expect(completed).toMatchObject([{ turnId, outcome: { status: "cancelled" } }]);
    expect(native.clients).toHaveLength(2);
    expect(await session.execute(turn("after-cancel"))).toMatchObject({ ok: true });
    await events.completed(2);
  });

  it("terminates an active autonomous Turn when the Session closes", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "closing");
    autonomousText(client, "closing", "closing-answer", "partial");
    await vi.waitFor(() => expect(events.autonomousTurnIds()).toHaveLength(1));
    const [turnId] = events.autonomousTurnIds();
    if (!turnId) throw Error("No autonomous Turn started");
    await session.close();
    await events.closed;
    expect(events.events().filter((event) => event.type === "turn.completed")).toMatchObject([
      { turnId, outcome: { status: "cancelled" } },
    ]);
  });

  it("attributes an approval raised by an autonomous Turn to that Turn", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "approval");
    await vi.waitFor(() => expect(events.autonomousTurnIds()).toHaveLength(1));
    const [turnId] = events.autonomousTurnIds();
    if (!turnId) throw Error("No autonomous Turn started");
    const answer = client.context.handlers.permission({
      sessionId: "native-session",
      toolCall: {
        toolCallId: "autonomous-call",
        rawInput: { file_path: "autonomous.txt" },
        _meta: { "codebuddy.ai/toolName": "Write" },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    await vi.waitFor(() =>
      expect(events.outputs.some((output) => output.kind === "interaction")).toBe(true),
    );
    const interaction = events.outputs.find((output) => output.kind === "interaction");
    if (interaction?.kind !== "interaction") throw Error("No interaction");
    expect(interaction.interaction.turnId).toBe(turnId);
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: interaction.interaction.interactionId,
        response: { type: "approval", actionId: "allow" },
      }),
    ).toMatchObject({ ok: true });
    await expect(answer).resolves.toMatchObject({ outcome: { outcome: "selected" } });
    persistDrain(native, "approval", "approved");
    endAutonomous(client, "approval");
    await events.completed();
    await session.close();
  });

  it("replays a drain received while a cancellation rebuild opens the replacement client", async () => {
    const native = fixture();
    let inject = false;
    const adapter = new CodeBuddyAdapter({
      ...native,
      clientFactory: (options) => {
        const client = native.clientFactory(options);
        const open = client.open.bind(client);
        client.open = async (...args: Parameters<typeof open>) => {
          const result = await open(...args);
          if (!inject) return result;
          inject = false;
          announce(client, "reconnected");
          autonomousText(client, "reconnected", "reconnected-answer", "reconnected");
          persistDrain(native, "reconnected");
          endAutonomous(client, "reconnected");
          return result;
        };
        return client;
      },
    });
    adapters.push(adapter);
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    announce(client, "cancelled");
    persistDrain(native, "cancelled");
    await vi.waitFor(() => expect(events.autonomousTurnIds()).toHaveLength(1));
    const [turnId] = events.autonomousTurnIds();
    if (!turnId) throw Error("No autonomous Turn started");
    expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({ ok: true });
    inject = true;
    endAutonomous(client, "cancelled");
    const completed = await events.completed(2);
    expect(
      completed.map((event) => (event.type === "turn.completed" ? event.outcome.status : "")),
    ).toEqual(["cancelled", "succeeded"]);
    expect(events.autonomousTurnIds()).toHaveLength(2);
  });

  it("ignores a session_end that has no autonomous Turn", async () => {
    const { adapter, native } = setup();
    const session = await create(adapter);
    const events = collect(session);
    const client = native.clients[0];
    if (!client) throw Error("No native fixture");

    endAutonomous(client, "unmatched");
    await tick();
    expect(events.events().filter((event) => event.type.startsWith("turn."))).toEqual([]);
    await session.close();
  });
});
