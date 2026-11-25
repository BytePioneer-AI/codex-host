import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostChoiceQuestion } from "@codexhost/harness-adapter";
import {
  THREAD_QUESTIONS_LIST_METHOD,
  THREAD_QUESTION_RESPOND_METHOD,
  hostItemIdSchema,
  hostTurnIdSchema,
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
  turnEvent,
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
async function setup(
  options: { detachedOwner?: boolean; expiresInMs?: number; native?: boolean } = {},
) {
  const fixture = createFixture();
  fixtures.push(fixture);
  const threadId = await startPiThread(fixture);
  const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
  const session = fixture.adapter.sessions[0];
  if (!session) throw new Error("Expected fake Session");
  const detachedOwner = options.detachedOwner
    ? hostItemIdSchema.parse("detached-question-owner")
    : undefined;
  if (detachedOwner) {
    session.emitEvent({
      type: "item.started",
      turnId,
      item: {
        type: "toolExecution",
        itemId: detachedOwner,
        namespace: "codexhost",
        toolName: "ask_question",
        arguments: {},
      },
    });
    session.emitEvent({ type: "item.detached", turnId, itemId: detachedOwner });
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === detachedOwner,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  let id = 100;
  const rpc = async (method: string, params: JsonObject) => {
    const request = id++;
    writeRequest(fixture.desktopInput, { id: request, method, params });
    return fixture.collector.waitFor((message) => requestId(message, request));
  };
  const interactionId = session.askQuestion(
    { ...choice, multiple: !options.native },
    {
      ...(detachedOwner ? { itemId: detachedOwner } : {}),
      ...(options.expiresInMs === undefined
        ? {}
        : { expiresAt: new Date(Date.now() + options.expiresInMs).toISOString() }),
    },
  );
  const list = async () =>
    threadQuestionsResultSchema.parse(
      (await rpc(THREAD_QUESTIONS_LIST_METHOD, { threadId })).result,
    ).questions;
  const nativeRequest = options.native
    ? await fixture.collector.waitFor((message) => method(message, "item/tool/requestUserInput"))
    : undefined;
  if (!nativeRequest) await vi.waitFor(async () => expect(await list()).toHaveLength(1));
  const respond = (overrides: JsonObject = {}) =>
    rpc(THREAD_QUESTION_RESPOND_METHOD, {
      threadId,
      turnId,
      interactionId,
      answers: { platform: ["mac", "win"] },
      ...overrides,
    });
  const completeTurn = async (status: "succeeded" | "failed" | "cancelled" = "succeeded") => {
    const nativeRef = session.state.nativeRef;
    if (!nativeRef) throw new Error("Expected fake native Session identity");
    session.appendText("foreground complete");
    const foregroundDelta = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/agentMessage/delta") &&
        turnEvent(message, "item/agentMessage/delta", turnId),
    );
    const foregroundItemId = hostItemIdSchema.parse(
      ((foregroundDelta.params as JsonObject).itemId ?? "") as string,
    );
    session.emitEvent({
      type: "item.completed",
      turnId,
      snapshot: {
        item: {
          type: "agentMessage",
          itemId: foregroundItemId,
          text: "foreground complete",
        },
        outcome: { status: "succeeded" },
      },
    });
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === foregroundItemId,
    );
    session.emitEvent({
      type: "turn.completed",
      turnId,
      nativeTurnRef: { ...nativeRef, nativeTurnKey: `question-${status}` },
      outcome:
        status === "succeeded"
          ? { status }
          : status === "failed"
            ? { status, error: { code: "nativeFailure", message: "failed", retryable: false } }
            : { status, reason: "cancelled" },
    });
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
  };
  return {
    fixture,
    session,
    threadId,
    turnId,
    interactionId,
    detachedOwner,
    nativeRequest,
    rpc,
    list,
    respond,
    completeTurn,
  };
}

describe("shared multi-select Questions", () => {
  it("keeps a detached-owner Question answerable after its Turn succeeds", async () => {
    const question = await setup({ detachedOwner: true });
    await question.completeTurn();
    expect(await question.list()).toHaveLength(1);
    expect(await question.respond()).toMatchObject({ result: { accepted: true } });
    await vi.waitFor(async () => expect(await question.list()).toEqual([]));
    expect(question.session.interactionResponses).toHaveLength(1);
  });

  it("keeps a detached-owner native Question answerable after its Turn succeeds", async () => {
    const question = await setup({ detachedOwner: true, native: true });
    const requestId = question.nativeRequest?.id;
    if (typeof requestId !== "number") throw new Error("Expected native Question request");
    await question.completeTurn();
    writeRequest(question.fixture.desktopInput, {
      id: requestId,
      result: { answers: { platform: { answers: ["macOS"] } } },
    });
    await vi.waitFor(() => expect(question.session.interactionResponses).toHaveLength(1));
    expect(question.session.interactionResponses[0]?.response).toMatchObject({
      answers: { platform: ["mac"] },
    });
  });

  it("retires a detached-owner Question when the Turn identity cannot be persisted", async () => {
    const question = await setup({ detachedOwner: true });
    vi.spyOn(question.fixture.mappingStore, "upsertTurnMappings").mockRejectedValueOnce(
      new Error("Disk write failed"),
    );
    await question.completeTurn();
    // The Harness reported success; the Host must not project the Turn as succeeded.
    expect(
      question.fixture.collector.messages.find((message) =>
        turnEvent(message, "turn/completed", question.turnId),
      ),
    ).toMatchObject({ params: { turn: { status: "failed" } } });
    await vi.waitFor(async () => expect(await question.list()).toEqual([]));
    expect(await question.respond()).toHaveProperty("error");
    expect(question.session.interactionResponses).toHaveLength(0);
  });

  it.each(["failed", "cancelled"] as const)(
    "retires an unowned Question after a %s Turn",
    async (status) => {
      const question = await setup();
      await question.completeTurn(status);
      await vi.waitFor(async () => expect(await question.list()).toEqual([]));
      expect(await question.respond()).toHaveProperty("error");
      expect(question.session.interactionResponses).toHaveLength(0);
    },
  );

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
