import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { DelegationControlApi, DelegationPendingQuestion } from "../src/delegation-types.js";
import {
  createFixture,
  method,
  readJsonLine,
  requiredMessageId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const threadId = "native-thread";
const turnId = "native-turn";
const questions = [
  { title: "Format?", options: ["Markdown", "JSON"] },
  { title: "Anything else?", options: [] },
];

async function fixture(status = "inProgress", externalOnly = false) {
  let api!: DelegationControlApi;
  const f = createFixture({
    externalOnly,
    onDelegationApi: (value) => {
      api = value;
      return undefined;
    },
  });
  const item: JsonObject = {
    type: "agentMessage",
    id: "async-item",
    delivery: "async",
    text: "",
    questions,
  };
  const turns: JsonObject[] = [{ id: turnId, status, items: [item] }];
  const thread = () => ({
    id: threadId,
    cwd: "/synthetic",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: turns.at(-1)?.status === "inProgress" ? "active" : "idle" },
    turns,
  });
  const respond = (request: JsonObject, result: JsonObject) =>
    writeRequest(f.official.stdout, { id: requiredMessageId(request), result });
  const next = async () => {
    let request = await readJsonLine(f.official.stdin);
    while (request.method === "initialize" || request.method === "initialized") {
      if (request.id !== undefined) respond(request, {});
      request = await readJsonLine(f.official.stdin);
    }
    return request;
  };
  const page = (request: JsonObject) => {
    expect(request.method).toBe("thread/turns/list");
    expect(request.params).toMatchObject({ threadId, limit: 5, sortDirection: "desc" });
    respond(request, { data: [...turns].reverse(), nextCursor: null });
  };
  const read = async (wait = false) => {
    const reading = wait
      ? api.wait({ threadId, view: "result", timeoutMs: 1000 })
      : api.read({ threadId, view: "result" });
    const request = await next();
    expect(request.method).toBe("thread/read");
    respond(request, { thread: thread() });
    return reading;
  };
  if (externalOnly) {
    await vi.waitFor(() => expect(api).toBeDefined());
    await vi.waitFor(async () => expect(await f.mappingStore.listThreads()).toEqual([]));
    const initial = read();
    await f.ready;
    await initial;
  } else await f.ready;
  const publish = async (value: JsonObject, name = "item/completed") => {
    writeRequest(f.official.stdout, { method: name, params: { threadId, turnId, item: value } });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await publish(item, "item/started");
  const pending = (await read()).pendingQuestions ?? [];
  const first = pending[0];
  if (!first) throw new Error("Missing async Question");
  const nextAnswer = async () => {
    page(await next());
    let request = await next();
    if (request.method === "thread/resume") {
      expect(request.params).toMatchObject({ threadId, excludeTurns: true });
      respond(request, { thread: thread() });
      request = await next();
    }
    return request;
  };
  const webSnapshot = async () => {
    const reading = f.host.clientSnapshot(threadId);
    let request = await next();
    if (request.method === "thread/resume") {
      respond(request, { thread: thread() });
      request = await next();
    }
    expect(request.method).toBe("thread/read");
    respond(request, { thread: thread() });
    page(await next());
    const queue = await next();
    expect(queue.method).toBe("thread/queue/list");
    respond(queue, { data: [], nextCursor: null });
    return reading;
  };
  return {
    f,
    api,
    read,
    pending,
    first,
    publish,
    nextAnswer,
    next,
    respond,
    page,
    webSnapshot,
    turns,
    item,
  };
}

function desktopReply(question: DelegationPendingQuestion): JsonObject {
  return {
    id: 900,
    method: "turn/steer",
    params: {
      threadId,
      expectedTurnId: turnId,
      input: [
        {
          type: "text",
          text: `<send_user_message_question_reply>\n${JSON.stringify([
            {
              questionItemId: question.request.questionItemId,
              question: question.request.title,
              answer: "Markdown",
            },
          ])}\n</send_user_message_question_reply>`,
        },
      ],
    },
  };
}

function answer(first: DelegationPendingQuestion) {
  return { threadId, interactionId: first.interactionId, result: { answer: "Markdown" } };
}

describe("Native asynchronous questions through delegation", () => {
  it("reads native questions, answers through the upstream protocol, and preserves siblings", async () => {
    const t = await fixture();
    try {
      expect(t.pending).toHaveLength(2);
      expect(t.pending[1]?.request).toMatchObject({ options: [] });
      expect(t.first).toMatchObject({
        kind: "requestUserInputAsync",
        turnId,
        request: {
          ...questions[0],
          itemId: "async-item",
          questionItemId: JSON.stringify(["request_user_input_async", "async-item", 0]),
        },
      });
      await expect(
        t.api.answer({ ...answer(t.first), result: { answer: " " } }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      const answering = t.api.answer(answer(t.first));
      const sent = await t.nextAnswer();
      expect(sent.method).toBe("turn/steer");
      expect(sent.params).toMatchObject({
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text_elements: [] }],
      });
      const text = ((sent.params as JsonObject).input as JsonObject[])[0]?.text as string;
      expect(
        JSON.parse(text.replace(/<\/?send_user_message_question_reply>/gu, "").trim()),
      ).toEqual([
        { questionItemId: t.first.request.questionItemId, question: "Format?", answer: "Markdown" },
      ]);
      t.respond(sent, { turnId });
      await expect(answering).resolves.toMatchObject({ turnId, status: "running" });
      await t.publish(t.item);
      expect((await t.read()).pendingQuestions).toEqual([t.pending[1]]);
      await expect(t.api.answer(answer(t.first))).rejects.toMatchObject({
        code: "QUESTION_NOT_PENDING",
      });
      expect(t.f.collector.messages.filter((m) => method(m, "serverRequest/resolved"))).toEqual([]);
    } finally {
      await stopFixture(t.f);
    }
  });

  it("wait returns pending questions while the native Turn keeps running", async () => {
    const t = await fixture();
    try {
      await expect(t.read(true)).resolves.toMatchObject({
        status: "running",
        timedOut: false,
        pendingQuestions: t.pending,
      });
    } finally {
      await stopFixture(t.f);
    }
  });

  it.each(["inProgress", "completed"])(
    "preserves the upstream answer policy for a %s Turn",
    async (status) => {
      const t = await fixture(status);
      try {
        const answering = t.api.answer(answer(t.first));
        const sent = await t.nextAnswer();
        expect(sent.method).toBe(status === "inProgress" ? "turn/steer" : "turn/start");
        t.respond(
          sent,
          status === "inProgress" ? { turnId } : { turn: { id: "new-turn", status: "inProgress" } },
        );
        await expect(answering).resolves.toMatchObject({
          turnId,
          interactionId: t.first.interactionId,
        });
      } finally {
        await stopFixture(t.f);
      }
    },
  );

  it("releases a native validation refusal for an explicit retry", async () => {
    const t = await fixture();
    try {
      const rejected = expect(t.api.answer(answer(t.first))).rejects.toThrow("Explicitly rejected");
      const sent = await t.nextAnswer();
      writeRequest(t.f.official.stdout, {
        id: requiredMessageId(sent),
        error: { code: -32600, message: "Explicitly rejected" },
      });
      await rejected;
      expect((await t.read()).pendingQuestions).toEqual(t.pending);
      const retried = t.api.answer(answer(t.first));
      t.respond(await t.nextAnswer(), { turnId });
      await retried;
      expect((await t.read()).pendingQuestions).toEqual([t.pending[1]]);
    } finally {
      await stopFixture(t.f);
    }
  });

  it("retains an unknown result instead of resending the answer", async () => {
    const t = await fixture();
    try {
      const rejected = expect(t.api.answer(answer(t.first))).rejects.toThrow("Unknown delivery");
      const sent = await t.nextAnswer();
      writeRequest(t.f.official.stdout, {
        id: requiredMessageId(sent),
        error: { code: -32093, message: "Unknown delivery" },
      });
      await rejected;
      expect((await t.read()).pendingQuestions).toEqual([t.pending[1]]);
      await expect(t.api.answer(answer(t.first))).rejects.toMatchObject({
        code: "QUESTION_NOT_PENDING",
      });
      expect(t.f.official.stdin.read()).toBeNull();
    } finally {
      await stopFixture(t.f);
    }
  });

  it("keeps Desktop input native and withdraws its observed answer", async () => {
    const t = await fixture();
    try {
      const request = desktopReply(t.first);
      writeRequest(t.f.desktopInput, request);
      expect(await t.next()).toEqual(request);
      t.respond(request, { turnId });
      await t.f.collector.waitFor((m) => m.id === 900);
      await t.publish({
        type: "userMessage",
        id: "desktop-answer",
        content: (request.params as JsonObject).input ?? [],
      });
      await t.publish(t.item);
      expect((await t.read()).pendingQuestions).toEqual([t.pending[1]]);
      await expect(t.api.answer(answer(t.first))).rejects.toMatchObject({
        code: "QUESTION_NOT_PENDING",
      });
    } finally {
      await stopFixture(t.f);
    }
  });

  it("shares native synchronous requests with the existing Web response path", async () => {
    const t = await fixture("inProgress", true);
    try {
      writeRequest(t.f.official.stdout, {
        id: 71,
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "sync-item",
          questions: [{ id: "sync", question: "Continue?", options: [{ label: "Continue" }] }],
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const snapshot = await t.webSnapshot();
      const pending = (await t.read()).pendingQuestions?.find(
        (question) => question.kind === "requestUserInput",
      );
      const web = snapshot.interactions.find(
        (question) => question.request.method === "item/tool/requestUserInput",
      );
      if (!pending || !web) throw new Error("Missing synchronous question");
      expect(pending.interactionId).toBe(web.requestId);
      const result = { answers: { sync: { answers: ["Continue"] } } };
      const answering = t.api.answer({ threadId, interactionId: pending.interactionId, result });
      expect(await t.next()).toEqual({ id: 71, result });
      await expect(answering).resolves.toMatchObject({ turnId });
      await t.f.host.respondClient({
        epoch: t.f.host.clientEvents.epoch,
        requestId: web.requestId,
        threadId,
        result,
      });
      expect(t.f.official.stdin.read()).toBeNull();
      expect(
        (await t.read()).pendingQuestions?.every(
          (question) => question.kind === "requestUserInputAsync",
        ),
      ).toBe(true);
    } finally {
      await stopFixture(t.f);
    }
  });

  it.each(["completed", "interrupted", "thread-closed"])(
    "invalidates a shared native synchronous question after %s without delivering an old answer",
    async (ending) => {
      const t = await fixture("inProgress", true);
      try {
        writeRequest(t.f.official.stdout, {
          id: 71,
          method: "item/tool/requestUserInput",
          params: {
            threadId,
            turnId,
            itemId: "sync-item",
            questions: [{ id: "sync", question: "Continue?" }],
          },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const pending = (await t.read()).pendingQuestions?.find(
          (q) => q.kind === "requestUserInput",
        );
        if (!pending) throw new Error("Missing synchronous question");
        const turn = t.turns[0];
        if (!turn) throw new Error("Missing native Turn");
        turn.status = ending === "thread-closed" ? "interrupted" : ending;
        writeRequest(
          t.f.official.stdout,
          ending === "thread-closed"
            ? { method: "thread/closed", params: { threadId } }
            : {
                method: "turn/completed",
                params: { threadId, turn: { id: turnId, status: ending } },
              },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        const snapshot = await t.read();
        expect(
          snapshot.pendingQuestions?.some((q) => q.interactionId === pending.interactionId),
        ).toBe(false);
        if (ending !== "thread-closed")
          expect(
            snapshot.pendingQuestions?.filter((q) => q.kind === "requestUserInputAsync"),
          ).toHaveLength(2);
        await expect(
          t.api.answer({
            threadId,
            interactionId: pending.interactionId,
            result: { answers: { sync: { answers: ["Continue"] } } },
          }),
        ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
        expect(t.f.official.stdin.read()).toBeNull();
      } finally {
        await stopFixture(t.f);
      }
    },
  );

  it("shares one claim between the production Web and delegation entry points", async () => {
    const t = await fixture("inProgress", true);
    try {
      const snapshot = await t.webSnapshot();
      const web = snapshot.interactions[0];
      if (!web) throw new Error("Missing Web question");
      const cliAnswer = t.api.answer(answer(t.first));
      const webAnswer = t.f.host.respondClient({
        epoch: t.f.host.clientEvents.epoch,
        requestId: web.requestId,
        threadId,
        result: { answers: { [t.first.request.questionItemId as string]: { answers: ["JSON"] } } },
      });
      const answers = Promise.allSettled([cliAnswer, webAnswer]);
      t.page(await t.next());
      t.page(await t.next());
      const sent = await t.next();
      expect(sent.method).toBe("turn/steer");
      t.respond(sent, { turnId });
      const results = await answers;
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({ code: "QUESTION_NOT_PENDING" });
      expect(t.f.official.stdin.read()).toBeNull();
      expect((await t.read()).pendingQuestions).toEqual([t.pending[1]]);
      expect((await t.webSnapshot()).interactions).toHaveLength(1);
    } finally {
      await stopFixture(t.f);
    }
  });
});
