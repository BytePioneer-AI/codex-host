import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostChoiceQuestion } from "@codexhost/harness-adapter";
import {
  THREAD_QUESTIONS_LIST_METHOD,
  THREAD_QUESTION_RESPOND_METHOD,
  threadQuestionsResultSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  method,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const choice: HostChoiceQuestion = {
  id: "platform",
  type: "choice",
  prompt: "Platforms?",
  multiple: true,
  allowOther: false,
  optional: false,
  options: [
    { value: "mac", label: "macOS" },
    { value: "win", label: "Windows" },
  ],
};
const fixtures: ReturnType<typeof createFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopFixture(fixture);
});
async function setup(options: { expiresInMs?: number } = {}) {
  const fixture = createFixture();
  fixtures.push(fixture);
  const threadId = await startPiThread(fixture);
  const turnId = await startPiTurn(fixture, threadId);
  const session = fixture.adapter.sessions[0];
  if (!session) throw new Error("Expected fake Session");
  let id = 100;
  const rpc = async (method: string, params: JsonObject) => {
    const request = id++;
    writeRequest(fixture.desktopInput, { id: request, method, params });
    return fixture.collector.waitFor((message) => requestId(message, request));
  };
  const interactionId = session.askQuestion(
    choice,
    options.expiresInMs === undefined
      ? {}
      : {
          expiresAt: new Date(Date.now() + options.expiresInMs).toISOString(),
        },
  );
  const list = async () =>
    threadQuestionsResultSchema.parse(
      (await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).result,
    ).questions;
  await vi.waitFor(async () => expect(await list()).toHaveLength(1));
  const respond = (overrides: JsonObject = {}) =>
    rpc(THREAD_QUESTION_RESPOND_METHOD, {
      threadId,
      turnId,
      interactionId,
      answers: { platform: ["mac", "win"] },
      ...overrides,
    });
  return { fixture, session, threadId, turnId, interactionId, rpc, list, respond };
}

describe("shared multi-select Questions", () => {
  it("returns Host values, avoids a duplicate native card, and rejects replay", async () => {
    const { fixture, session, list, respond, rpc, threadId } = await setup();
    expect(fixture.collector.messages.some((m) => method(m, "item/tool/requestUserInput"))).toBe(
      false,
    );
    expect((await list())[0]?.questions[0]).toEqual(choice);
    // A guessed legacy native response ID cannot consume a shared card.
    writeRequest(fixture.desktopInput, { id: -1, result: { answers: {} } });
    await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId });
    expect(session.interactionResponses).toHaveLength(0);
    expect(await respond()).toMatchObject({ result: { accepted: true } });
    expect(session.interactionResponses).toMatchObject([
      { response: { answers: { platform: ["mac", "win"] }, cancelled: false } },
    ]);
    expect(await list()).toEqual([]);
    expect(await respond()).toHaveProperty("error");
    expect(session.interactionResponses).toHaveLength(1);
  });

  it("rejects wrong owners, undeclared, missing and duplicate answers without consuming the card", async () => {
    const { respond, list, session } = await setup();
    for (const params of [
      { threadId: "other-thread" },
      { turnId: "other-turn" },
      { interactionId: "other-question" },
      { answers: {} },
      { answers: { platform: ["macOS"] } },
      { answers: { platform: ["mac", "mac"] } },
      { answers: { platform: [""] } },
      { cancelled: true },
      { answers: { unknown: ["mac"] } },
    ])
      expect(await respond(params)).toHaveProperty("error");
    expect(session.interactionResponses).toHaveLength(0);
    expect(await list()).toHaveLength(1);
    expect(await respond()).toMatchObject({ result: { accepted: true } });
  });

  it("cancels only with empty answers", async () => {
    const { respond, list, session } = await setup();
    expect(await respond({ answers: {}, cancelled: true })).toMatchObject({
      result: { accepted: true },
    });
    expect(session.interactionResponses.at(-1)?.response).toEqual({
      type: "question",
      answers: {},
      cancelled: true,
    });
    expect(await list()).toEqual([]);
  });

  it("serializes double submissions and rejects the duplicate after delivery", async () => {
    const { session, respond, rpc } = await setup();
    const execute = session.execute.bind(session);
    const gate = Promise.withResolvers<undefined>();
    const spy = vi.spyOn(session, "execute").mockImplementation(async (command) => {
      if ((command.type as string) === "interaction.respond") await gate.promise;
      return execute(command);
    });
    const first = respond();
    let second: ReturnType<typeof respond> | undefined;
    let duplicateSettled = false;
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      second = respond().then((result) => {
        duplicateSettled = true;
        return result;
      });
      await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId: "unrelated-thread" });
      expect(duplicateSettled).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve(undefined);
    }
    expect(await first).toMatchObject({ result: { accepted: true } });
    expect(await second).toHaveProperty("error");
    expect(session.interactionResponses).toHaveLength(1);
  });

  it("queues interruption behind answer delivery without blocking unrelated Threads", async () => {
    const { session, respond, rpc, threadId, turnId } = await setup();
    const execute = session.execute.bind(session);
    const gate = Promise.withResolvers<undefined>();
    const spy = vi.spyOn(session, "execute").mockImplementation(async (command) => {
      if ((command.type as string) === "interaction.respond") await gate.promise;
      return execute(command);
    });
    const answer = respond();
    let interruption: ReturnType<typeof rpc> | undefined;
    try {
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      interruption = rpc("turn/interrupt", { threadId, turnId });
      expect(
        await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId: "unrelated-thread" }),
      ).toMatchObject({ result: { questions: [] } });
      expect(spy.mock.calls.map(([command]) => command.type)).toEqual(["interaction.respond"]);
    } finally {
      gate.resolve(undefined);
    }
    expect(await answer).toMatchObject({ result: { accepted: true } });
    expect(await interruption).not.toHaveProperty("error");
    expect(spy.mock.calls.map(([command]) => command.type)).toEqual([
      "interaction.respond",
      "turn.cancel",
    ]);
  });

  it("withdraws native-closed questions and rejects late responses", async () => {
    const { session, interactionId, list, respond } = await setup();
    session.expireQuestion(interactionId);
    await vi.waitFor(async () => expect(await list()).toEqual([]));
    expect(await respond()).toHaveProperty("error");
    expect(session.interactionResponses).toHaveLength(0);
  });

  it("honors Host expiry without emitting a native server-request resolution", async () => {
    const { fixture, list, respond, session } = await setup({
      expiresInMs: 500,
    });
    await vi.waitFor(async () => expect(await list()).toEqual([]));
    await vi.waitFor(() => expect(session.interactionResponses).toHaveLength(1));
    expect(session.interactionResponses[0]?.response).toMatchObject({ cancelled: true });
    expect(await respond()).toHaveProperty("error");
    expect(fixture.collector.messages.some((m) => method(m, "serverRequest/resolved"))).toBe(false);
  });

  it("removes cards when the Session faults", async () => {
    const { session, list, respond } = await setup();
    // A fault must retire the card even when the Adapter omits interaction.closed.
    session.emitEvent({
      type: "session.faulted",
      error: { code: "nativeFailure", message: "failed", retryable: false },
    });
    await vi.waitFor(async () => expect(await list()).toEqual([]));
    expect(await respond()).toHaveProperty("error");
  });

  it("does not query or modify official Threads", async () => {
    const { fixture, rpc } = await setup();
    const forward = vi.fn();
    fixture.official.stdin.on("data", forward);
    expect(await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId: "official-thread" })).toMatchObject({
      result: { questions: [] },
    });
    expect(forward).not.toHaveBeenCalled();
  });
});
