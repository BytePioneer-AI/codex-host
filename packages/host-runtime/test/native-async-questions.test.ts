import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { NativeClientChannel, type NativeClientReply } from "../src/native-client-channel.js";

const threadId = "native-thread";
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing native test fixture value");
  return value;
}
const questionId = (index = 0) =>
  JSON.stringify(["request_user_input_async", "call-question", index]);
const question: JsonObject = {
  id: "call-question",
  type: "agentMessage",
  delivery: "async",
  text: "Choose a direction\n- Keep\n- Replace",
  questions: [{ title: "Choose a direction", options: ["Keep", "Replace"] }],
};

function reply(index = 0): JsonObject {
  return {
    id: `desktop-answer-${index}`,
    type: "userMessage",
    content: [
      {
        type: "text",
        text: `<send_user_message_question_reply>\n${JSON.stringify([
          { questionItemId: questionId(index), question: "Choose a direction", answer: "Keep" },
        ])}\n</send_user_message_question_reply>\n`,
      },
    ],
  };
}

function fixture(status = "inProgress") {
  const events = new ClientChannelEvents();
  const turns: JsonObject[] = [{ id: "turn-1", status, items: [structuredClone(question)] }];
  const request = vi.fn(async (method: string, params: JsonObject): Promise<NativeClientReply> => {
    if (method === "thread/resume" || method === "thread/read")
      return {
        result: {
          thread: {
            id: threadId,
            cwd: "/synthetic",
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 1,
            status: { type: status === "inProgress" ? "active" : "idle" },
          },
        },
      };
    if (method === "thread/turns/list")
      return { result: { data: structuredClone(turns), nextCursor: null } };
    if (method === "turn/steer") return { result: { turnId: params.expectedTurnId ?? null } };
    if (method === "turn/start")
      return { result: { turn: { id: "turn-2", status: "inProgress" } } };
    throw new Error(`Unexpected method ${method}`);
  });
  const respond = vi.fn(async () => undefined);
  const channel = new NativeClientChannel({ events, request, respond });
  const observe = (item: JsonObject, target = threadId) =>
    channel.observeMessage({
      method: "item/completed",
      params: { threadId: target, turnId: "turn-1", item },
    });
  const answer = { answers: { [questionId()]: { answers: ["My own direction"] } } };
  return { channel, request, respond, turns, observe, answer, events };
}

it("restores structured async questions from native history as answerable cards", async () => {
  const { channel } = fixture();
  const snapshot = await channel.snapshot(threadId, {});
  expect(snapshot.interactions).toHaveLength(1);
  expect(snapshot.interactions[0]).toMatchObject({
    threadId,
    kind: "question",
    interaction: {
      type: "question",
      questions: [
        {
          id: questionId(),
          prompt: "Choose a direction",
          type: "choice",
          multiple: false,
          allowOther: true,
          options: [
            { value: "Keep", label: "Keep" },
            { value: "Replace", label: "Replace" },
          ],
        },
      ],
    },
  });
  expect((await channel.snapshot(threadId, {})).interactions[0]?.requestId).toBe(
    snapshot.interactions[0]?.requestId,
  );
});

it("observes async questions live without changing the native message", () => {
  const { channel, observe, events } = fixture();
  const changed = vi.spyOn(events, "changed");
  const item = structuredClone(question);
  observe(item);
  observe(item);
  expect(channel.interactions(threadId)).toHaveLength(1);
  expect(item).toEqual(question);
  expect(
    changed.mock.calls.filter(([, method]) => method === "codexhost/thread/questions/updated"),
  ).toHaveLength(1);
});

it.each(["inProgress", "completed"])(
  "delivers an async answer while the Turn is %s",
  async (status) => {
    const { channel, request, respond, answer } = fixture(status);
    const snapshot = await channel.snapshot(threadId, {});
    const pending = defined(snapshot.interactions[0]);
    expect(pending).toBeDefined();
    await channel.respond(pending.requestId, threadId, answer);
    const method = status === "inProgress" ? "turn/steer" : "turn/start";
    const sent = request.mock.calls.find(([name]) => name === method)?.[1];
    expect(sent).toMatchObject({ threadId, input: [{ type: "text" }] });
    if (status === "inProgress") expect(sent?.expectedTurnId).toBe("turn-1");
    const text = (sent?.input as JsonObject[])[0]?.text as string;
    expect(JSON.parse(text.replace(/<\/?send_user_message_question_reply>/gu, "").trim())).toEqual([
      { questionItemId: questionId(), question: "Choose a direction", answer: "My own direction" },
    ]);
    expect(respond).not.toHaveBeenCalled();
    expect(channel.interactions(threadId)).toEqual([]);
    await channel.snapshot(threadId, {});
    await channel.respond(pending.requestId, threadId, answer);
    expect(request.mock.calls.filter(([name]) => name === method)).toHaveLength(1);
  },
);

it("withdraws Desktop answers and does not resurrect them from a late history page", async () => {
  const { channel, observe } = fixture();
  const pending = defined((await channel.snapshot(threadId, {})).interactions[0]);
  expect(pending).toBeDefined();
  observe(reply());
  expect(channel.interactions(threadId)).toEqual([]);
  expect((await channel.snapshot(threadId, {})).interactions).toEqual([]);
});

it.each(["inProgress", "completed"])(
  "skips a native async question locally while the Turn is %s",
  async (status) => {
    const { channel, request, respond, turns } = fixture(status);
    const pending = defined((await channel.snapshot(threadId, {})).interactions[0]);
    const original = structuredClone(turns);
    request.mockClear();
    await expect(
      channel.respond(pending.requestId, threadId, {
        answers: { [questionId()]: { answers: [] } },
      }),
    ).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect((await channel.snapshot(threadId, {})).interactions).toEqual([]);
    expect(turns).toEqual(original);
    channel.resetGeneration();
    expect((await channel.snapshot(threadId, {})).interactions).toHaveLength(1);
  },
);

it("checks native history before delivering an answer that Desktop already supplied", async () => {
  const { channel, request, turns, answer } = fixture();
  const pending = defined((await channel.snapshot(threadId, {})).interactions[0]);
  expect(pending).toBeDefined();
  (defined(turns[0]).items as JsonObject[]).push(reply());
  await channel.respond(pending.requestId, threadId, answer);
  expect(request.mock.calls.some(([method]) => method === "turn/steer")).toBe(false);
  expect(channel.interactions(threadId)).toEqual([]);
});

it("retains unanswered questions and their native indexes across descending history", async () => {
  const { channel, turns } = fixture();
  (defined(turns[0]).items as JsonObject[])[0] = {
    ...question,
    questions: [...(question.questions as JsonObject[]), { title: "Anything else?" }],
  };
  turns.unshift({ id: "turn-2", status: "completed", items: [reply()] });
  const snapshot = await channel.snapshot(threadId, {});
  expect(snapshot.interactions).toHaveLength(1);
  expect(snapshot.interactions[0]?.interaction).toMatchObject({
    questions: [{ id: questionId(1), type: "text", prompt: "Anything else?" }],
  });
});

it("rejects wrong-Thread and invalid answers without consuming the question", async () => {
  const { channel, request, answer } = fixture();
  const pending = defined((await channel.snapshot(threadId, {})).interactions[0]);
  expect(pending).toBeDefined();
  await expect(channel.respond(pending.requestId, "another-thread", answer)).rejects.toThrow(
    "does not belong",
  );
  await expect(channel.respond(pending.requestId, threadId, { answers: {} })).rejects.toThrow();
  await expect(
    channel.respond(pending.requestId, threadId, {
      answers: { [questionId()]: { answers: [" "] } },
    }),
  ).rejects.toThrow();
  expect(channel.interactions(threadId)).toHaveLength(1);
  expect(request.mock.calls.some(([method]) => method === "turn/steer")).toBe(false);
});

it("claims concurrent answers once and never resends an uncertain delivery", async () => {
  const { channel, request, answer } = fixture();
  const pending = defined((await channel.snapshot(threadId, {})).interactions[0]);
  expect(pending).toBeDefined();
  const original = defined(request.getMockImplementation());
  request.mockImplementation(async (method, params) => {
    if (method === "turn/steer") throw new Error("Synthetic transport failure");
    return original(method, params);
  });
  const results = await Promise.allSettled([
    channel.respond(pending.requestId, threadId, answer),
    channel.respond(pending.requestId, threadId, answer),
  ]);
  expect(results.some((result) => result.status === "rejected")).toBe(true);
  expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
  await channel.snapshot(threadId, {});
  await expect(channel.respond(pending.requestId, threadId, answer)).rejects.toThrow("unknown");
});

it("keeps a question answerable after an explicit native validation refusal", async () => {
  const { channel, request, answer } = fixture();
  const pending = defined((await channel.snapshot(threadId, {})).interactions[0]);
  const original = defined(request.getMockImplementation());
  request.mockImplementation(async (method, params) =>
    method === "turn/steer"
      ? { error: { code: -32600, message: "active Turn changed" } }
      : original(method, params),
  );
  await expect(channel.respond(pending.requestId, threadId, answer)).rejects.toThrow(
    "active Turn changed",
  );
  expect(channel.interactions(threadId)).toHaveLength(1);
  request.mockImplementation(original);
  await expect(channel.respond(pending.requestId, threadId, answer)).resolves.toBe(true);
});

it("does not deliver an answer after the Host resets during the native refresh", async () => {
  const { channel, request, answer } = fixture();
  const pending = defined((await channel.snapshot(threadId, {})).interactions[0]);
  const original = defined(request.getMockImplementation());
  request.mockImplementation(async (method, params) => {
    if (method === "thread/turns/list") channel.resetGeneration();
    return original(method, params);
  });
  await expect(channel.respond(pending.requestId, threadId, answer)).rejects.toThrow(
    "generation changed",
  );
  expect(request.mock.calls.some(([method]) => method === "turn/steer")).toBe(false);
});

it("ignores ordinary or malformed messages and invalidates IDs after a Host reset", async () => {
  const { channel, observe, answer } = fixture();
  observe({ ...question, delivery: "normal" });
  observe({ ...question, questions: [{ title: "Invalid", options: [1] }] });
  expect(channel.interactions(threadId)).toEqual([]);
  observe(question);
  const pending = defined(channel.interactions(threadId)[0]);
  expect(pending).toBeDefined();
  channel.resetGeneration();
  expect(channel.interactions(threadId)).toEqual([]);
  expect(channel.isStaleRequestId(pending.requestId)).toBe(true);
  expect(await channel.respond(pending.requestId, threadId, answer)).toBe(false);
  observe(question);
  expect(channel.interactions(threadId)[0]?.requestId).not.toBe(pending.requestId);
});
