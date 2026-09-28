import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import { compactDelegationOutput } from "../src/delegation-cli-output.js";
import type { DelegationControlApi, DelegationControlError } from "../src/delegation-types.js";
import {
  createFixture,
  method,
  startPiThread,
  startExternalThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

/** A fixture that also exposes the Host's delegation API once it is ready. */
function questionFixture(): {
  fixture: Fixture;
  ready(): Promise<DelegationControlApi>;
} {
  let api: DelegationControlApi | undefined;
  const fixture = createFixture({
    onDelegationApi: (value) => {
      api = value;
      return undefined;
    },
  });
  return {
    fixture,
    ready: async () => {
      await fixture.ready;
      if (!api) throw new Error("Delegation API was not registered");
      return api;
    },
  };
}

async function pendingQuestionId(api: DelegationControlApi, threadId: string): Promise<string> {
  let id: string | undefined;
  await vi.waitFor(async () => {
    id = (await api.read({ threadId, view: "result" })).pendingQuestions?.[0]?.interactionId;
    expect(id).toBeTypeOf("string");
  });
  if (!id) throw new Error("Question was not exposed by read");
  return id;
}

/** Frames the fake native process received, parsed per line. */
function officialRequests(fixture: Fixture): JsonObject[] {
  const requests: JsonObject[] = [];
  fixture.official.stdin.setEncoding("utf8");
  fixture.official.stdin.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) requests.push(JSON.parse(line) as JsonObject);
    }
  });
  return requests;
}

function emitOfficial(fixture: Fixture, value: JsonObject): void {
  fixture.official.stdout.write(`${JSON.stringify(value)}\n`);
}

function officialQuestion(nativeId: number, threadId: string, turnId: string): JsonObject {
  return {
    id: nativeId,
    method: "item/tool/requestUserInput",
    params: {
      threadId,
      turnId,
      itemId: `item-${nativeId}`,
      isBlocking: true,
      questions: [
        {
          id: "decision",
          header: "Decision",
          question: `Continue in ${turnId}?`,
          isOther: false,
          isSecret: false,
          options: [
            { label: "Continue", description: "Keep going" },
            { label: "Stop", description: "" },
          ],
        },
      ],
    },
  };
}

/**
 * Emits one native Question and returns the request ID the Desktop client saw,
 * which is also the interaction ID `thread read` reports.
 */
async function emitOfficialQuestion(
  fixture: Fixture,
  input: { nativeId: number; threadId: string; turnId: string },
  api: DelegationControlApi,
  readThread: (threadId: string) => Promise<void>,
): Promise<{ requestId: string; interactionId: string }> {
  emitOfficial(fixture, officialQuestion(input.nativeId, input.threadId, input.turnId));
  const request = await fixture.collector.waitFor(
    (message) =>
      method(message, "item/tool/requestUserInput") &&
      (message.params as JsonObject).turnId === input.turnId,
  );
  if (typeof request.id !== "string") {
    throw new Error("Native Question was not forwarded with a Host request ID");
  }
  const reading = api.read({ threadId: input.threadId, view: "result" });
  await readThread(input.threadId);
  const question = (await reading).pendingQuestions?.find(({ turnId }) => turnId === input.turnId);
  if (!question) throw new Error("Native Question was not exposed by read");
  return { requestId: request.id, interactionId: question.interactionId };
}

/** Answers every `thread/read` the delegation API asks the native process for. */
function officialThreadReader(fixture: Fixture, requests: JsonObject[]) {
  const answered = new Set<unknown>();
  const pending = (): JsonObject | undefined =>
    requests.find(
      (request) =>
        request.method === "thread/read" &&
        typeof (request.params as JsonObject | undefined)?.threadId === "string" &&
        !answered.has(request.id),
    );
  return async (threadId: string): Promise<void> => {
    await vi.waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.method === "thread/read" &&
            (request.params as JsonObject | undefined)?.threadId === threadId &&
            !answered.has(request.id),
        ),
      ).toBe(true);
    });
    const read = pending();
    if (!read || read.id === undefined) throw new Error("Native read request has no ID");
    answered.add(read.id);
    emitOfficial(fixture, {
      id: read.id,
      result: {
        thread: {
          id: threadId,
          status: { type: "active" },
          turns: [{ id: "official-turn", status: "inProgress", items: [] }],
        },
      },
    });
  };
}

async function waitForRequest(
  requests: JsonObject[],
  predicate: (request: JsonObject) => boolean,
): Promise<JsonObject> {
  await vi.waitFor(() => {
    expect(requests.some(predicate)).toBe(true);
  });
  const request = requests.find(predicate);
  if (!request) throw new Error("Expected official request was not sent");
  return request;
}

function resolvedRequests(fixture: Fixture): JsonObject[] {
  return fixture.collector.messages.filter((message) => method(message, "serverRequest/resolved"));
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("AppServerHost pending Questions", () => {
  it.each(["answer", "close"] as const)(
    "scopes %s to its Thread when interaction IDs collide",
    async (operation) => {
      const { fixture, ready } = questionFixture();
      try {
        const api = await ready();
        const firstThread = await startExternalThread(fixture, "codexhost/pi-native", 1);
        await startPiTurn(fixture, firstThread, 2);
        const secondThread = await startExternalThread(fixture, "codexhost/pi-native", 3);
        await startPiTurn(fixture, secondThread, 4);
        const [first, second] = fixture.adapter.sessions;
        if (!first || !second) throw new Error("Fake Pi Sessions were not opened");
        const question = {
          id: "value",
          type: "text" as const,
          prompt: "Value?",
          multiline: false,
          optional: false,
          secret: false,
        };
        const nativeInteractionId = first.askQuestion(question);
        expect(second.askQuestion(question)).toBe(nativeInteractionId);
        for (const threadId of [firstThread, secondThread]) {
          await fixture.collector.waitFor(
            (message) =>
              method(message, "item/tool/requestUserInput") &&
              (message.params as JsonObject).threadId === threadId,
          );
        }
        const firstId = await pendingQuestionId(api, firstThread);
        const secondId = await pendingQuestionId(api, secondThread);
        expect(secondId).not.toBe(firstId);
        if (operation === "answer") {
          await expect(
            api.answer({
              threadId: secondThread,
              interactionId: secondId,
              answers: { value: ["second"] },
            }),
          ).resolves.toMatchObject({ threadId: secondThread });
          expect(second.interactionResponses).toHaveLength(1);
        } else {
          second.expireQuestion(nativeInteractionId);
        }
        await vi.waitFor(async () => {
          expect(
            (await api.read({ threadId: secondThread, view: "result" })).pendingQuestions,
          ).toEqual([]);
        });
        expect(first.interactionResponses).toEqual([]);
        expect(
          (await api.read({ threadId: firstThread, view: "result" })).pendingQuestions,
        ).toMatchObject([{ interactionId: firstId }]);
        await expect(
          api.answer({
            threadId: firstThread,
            interactionId: firstId,
            answers: { value: ["first"] },
          }),
        ).resolves.toMatchObject({ threadId: firstThread });
        expect(first.interactionResponses).toHaveLength(1);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("answers a pending external Question once through the delegation API", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.askQuestion({
        id: "decision",
        type: "choice",
        prompt: "Continue?",
        options: [
          { value: "continue", label: "Continue" },
          { value: "stop", label: "Stop" },
        ],
        multiple: false,
        allowOther: false,
        optional: false,
      });
      const interactionId = await pendingQuestionId(api, threadId);
      const request = await fixture.collector.waitFor((message) =>
        method(message, "item/tool/requestUserInput"),
      );
      if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");

      const snapshot = await api.read({ threadId, view: "result" });
      expect(snapshot.pendingQuestions).toEqual([
        {
          interactionId,
          turnId: expect.any(String),
          questions: [
            {
              id: "decision",
              type: "choice",
              prompt: "Continue?",
              options: [
                { value: "continue", label: "Continue" },
                { value: "stop", label: "Stop" },
              ],
              multiple: false,
              allowOther: false,
              optional: false,
            },
          ],
        },
      ]);
      expect(compactDelegationOutput("thread read", snapshot)).toMatchObject({
        status: "running",
        pendingQuestions: [{ interactionId, questions: [{ id: "decision" }] }],
      });

      await expect(
        api.answer({ threadId, interactionId, answers: { decision: ["continue"] } }),
      ).resolves.toMatchObject({
        threadId,
        interactionId,
        harnessId: "pi",
        status: "running",
      });
      await vi.waitFor(() => {
        expect(session.interactionResponses.at(-1)).toMatchObject({
          response: { type: "question", answers: { decision: ["continue"] } },
        });
      });
      // Answering from the CLI closes the same Question in Desktop.
      await expect(
        fixture.collector.waitFor((message) => method(message, "serverRequest/resolved")),
      ).resolves.toMatchObject({ params: { threadId, requestId: request.id } });
      await expect(api.read({ threadId, view: "result" })).resolves.toMatchObject({
        pendingQuestions: [],
      });
      await expect(
        api.answer({ threadId, interactionId, answers: { decision: ["continue"] } }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });

      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps an invalid answer from consuming the Question", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.askQuestion({
        id: "decision",
        type: "choice",
        prompt: "Continue?",
        options: [{ value: "continue", label: "Continue" }],
        multiple: false,
        allowOther: false,
        optional: false,
      });
      const interactionId = await pendingQuestionId(api, threadId);
      await fixture.collector.waitFor((message) => method(message, "item/tool/requestUserInput"));

      for (const answers of [
        { decision: ["undeclared"] },
        { decision: [] },
        { missing: ["continue"] },
        { decision: "continue" as unknown as string[] },
      ]) {
        await expect(api.answer({ threadId, interactionId, answers })).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      }
      await expect(
        api.answer({ threadId, interactionId: "unknown", answers: {} }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
      await expect(
        api.answer({
          threadId: "another-thread",
          interactionId,
          answers: { decision: ["continue"] },
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(session.interactionResponses).toHaveLength(0);
      await expect(api.read({ threadId, view: "result" })).resolves.toMatchObject({
        pendingQuestions: [expect.objectContaining({ interactionId })],
      });

      await expect(
        api.answer({ threadId, interactionId, answers: { decision: ["continue"] } }),
      ).resolves.toMatchObject({ status: "running" });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("accepts skipping an optional Question and rejects skipping a required one", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.askQuestion({
        id: "note",
        type: "text",
        prompt: "Note",
        multiline: false,
        secret: false,
        optional: true,
      });
      const optionalId = await pendingQuestionId(api, threadId);
      await fixture.collector.waitFor((message) => method(message, "item/tool/requestUserInput"));
      // Every Question may be skipped when none of them is required.
      await expect(
        api.answer({ threadId, interactionId: optionalId, answers: {} }),
      ).resolves.toMatchObject({ interactionId: optionalId, status: "running" });
      await vi.waitFor(() => {
        expect(session.interactionResponses.at(-1)).toMatchObject({
          response: { type: "question", answers: {} },
        });
      });

      session.askQuestion({
        id: "value",
        type: "text",
        prompt: "Value",
        multiline: false,
        secret: false,
        optional: false,
      });
      const requiredId = await pendingQuestionId(api, threadId);
      await vi.waitFor(async () => {
        expect((await api.read({ threadId, view: "result" })).pendingQuestions).toEqual([
          expect.objectContaining({ interactionId: requiredId }),
        ]);
      });
      await expect(
        api.answer({ threadId, interactionId: requiredId, answers: { value: [] } }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(session.interactionResponses).toHaveLength(1);
      await expect(api.read({ threadId, view: "result" })).resolves.toMatchObject({
        pendingQuestions: [expect.objectContaining({ interactionId: requiredId })],
      });

      await expect(
        api.answer({ threadId, interactionId: requiredId, answers: { value: ["typed"] } }),
      ).resolves.toMatchObject({ status: "running" });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("settles only one of two concurrent answers to the same Question", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.askQuestion({
        id: "decision",
        type: "choice",
        prompt: "Continue?",
        options: [{ value: "continue", label: "Continue" }],
        multiple: false,
        allowOther: false,
        optional: false,
      });
      const interactionId = await pendingQuestionId(api, threadId);
      const request = await fixture.collector.waitFor((message) =>
        method(message, "item/tool/requestUserInput"),
      );
      if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");

      // Both entries answer in the same tick, without waiting for either.
      const answered = api
        .answer({ threadId, interactionId, answers: { decision: ["continue"] } })
        .then(
          () => "answered" as const,
          (error: DelegationControlError) => error,
        );
      writeRequest(fixture.desktopInput, {
        id: request.id,
        result: { answers: { decision: { answers: ["Continue"] } } },
      });

      const outcome = await answered;
      if (outcome !== "answered") expect(outcome).toMatchObject({ code: "QUESTION_NOT_PENDING" });
      await vi.waitFor(() => {
        expect(session.interactionResponses).toHaveLength(1);
      });
      await expect(api.read({ threadId, view: "result" })).resolves.toMatchObject({
        pendingQuestions: [],
      });

      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects an answer for a Question the Harness closed or expired", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      const nativeInteractionId = session.askQuestion({
        id: "value",
        type: "text",
        prompt: "Value",
        multiline: false,
        secret: false,
        optional: false,
      });
      const interactionId = await pendingQuestionId(api, threadId);
      const request = await fixture.collector.waitFor((message) =>
        method(message, "item/tool/requestUserInput"),
      );
      if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");

      session.expireQuestion(nativeInteractionId);
      await expect(
        fixture.collector.waitFor(
          (message) =>
            method(message, "serverRequest/resolved") &&
            (message.params as JsonObject).requestId === request.id,
        ),
      ).resolves.toMatchObject({ params: { threadId, requestId: request.id } });
      await expect(
        api.answer({ threadId, interactionId, answers: { value: ["late"] } }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
      await expect(api.read({ threadId, view: "result" })).resolves.toMatchObject({
        pendingQuestions: [],
      });

      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("retires the Turn's Questions when that Turn ends", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.askQuestion({
        id: "value",
        type: "text",
        prompt: "Value",
        multiline: false,
        secret: false,
        optional: false,
      });
      const interactionId = await pendingQuestionId(api, threadId);
      await fixture.collector.waitFor((message) => method(message, "item/tool/requestUserInput"));

      session.failTurn({ code: "nativeFailure", message: "process exited", retryable: false });
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
      await expect(api.read({ threadId, view: "result" })).resolves.toMatchObject({
        pendingQuestions: [],
      });
      await expect(
        api.answer({ threadId, interactionId, answers: { value: ["late"] } }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("answers a native Question, closes it once, and drops the later native resolution", async () => {
    const { fixture, ready } = questionFixture();
    const requests = officialRequests(fixture);
    const readThread = officialThreadReader(fixture, requests);
    try {
      const api = await ready();
      const threadId = "official-thread";
      const { requestId, interactionId } = await emitOfficialQuestion(
        fixture,
        {
          nativeId: 7,
          threadId,
          turnId: "official-turn",
        },
        api,
        readThread,
      );

      const reading = api.read({ threadId, view: "result" });
      await readThread(threadId);
      await expect(reading).resolves.toMatchObject({
        status: "running",
        pendingQuestions: [
          {
            interactionId,
            turnId: "official-turn",
            questions: [
              {
                id: "decision",
                type: "choice",
                prompt: "Continue in official-turn?",
                options: [
                  { value: "Continue", label: "Continue", description: "Keep going" },
                  { value: "Stop", label: "Stop" },
                ],
                allowOther: false,
                optional: false,
              },
            ],
          },
        ],
      });

      await expect(
        api.answer({ threadId, interactionId, answers: { decision: ["Continue"] } }),
      ).resolves.toMatchObject({ threadId, interactionId, harnessId: "codex", status: "running" });
      // The answer reaches the native request with its own ID and answer shape.
      await waitForRequest(requests, (request) => request.id === 7);
      expect(requests.find((request) => request.id === 7)).toEqual({
        id: 7,
        result: { answers: { decision: { answers: ["Continue"] } } },
      });
      expect(resolvedRequests(fixture)).toEqual([
        expect.objectContaining({ params: { threadId, requestId } }),
      ]);

      // The resolution that follows the answer cannot be named by an ID the
      // Desktop saw, so it is dropped: exactly one close, no native ID leak.
      emitOfficial(fixture, {
        method: "serverRequest/resolved",
        params: { threadId, requestId: 7 },
      });
      await nextTick();
      expect(resolvedRequests(fixture)).toHaveLength(1);
      expect(JSON.stringify(fixture.collector.messages)).not.toContain('"requestId":7');

      // The retired reply route no longer accepts a late Desktop reply.
      writeRequest(fixture.desktopInput, {
        id: requestId,
        result: { answers: { decision: { answers: ["Stop"] } } },
      });
      await nextTick();
      expect(requests.filter((request) => request.id === 7)).toHaveLength(1);

      await expect(
        api.answer({ threadId, interactionId, answers: { decision: ["Continue"] } }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("retires only the ended Turn's native Questions and keeps other replies forwarding", async () => {
    const { fixture, ready } = questionFixture();
    const requests = officialRequests(fixture);
    const readThread = officialThreadReader(fixture, requests);
    try {
      const api = await ready();
      const threadId = "official-thread";
      const firstTurn = await emitOfficialQuestion(
        fixture,
        {
          nativeId: 11,
          threadId,
          turnId: "turn-one",
        },
        api,
        readThread,
      );
      const secondTurn = await emitOfficialQuestion(
        fixture,
        {
          nativeId: 12,
          threadId,
          turnId: "turn-two",
        },
        api,
        readThread,
      );

      // A server request that is not a Question keeps the ordinary reply path.
      emitOfficial(fixture, {
        id: 21,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId: "turn-two" },
      });
      const approval = await fixture.collector.waitFor(
        (message) =>
          method(message, "item/commandExecution/requestApproval") &&
          (message.params as JsonObject).threadId === threadId,
      );
      if (approval.id === undefined) throw new Error("Native approval request has no ID");
      writeRequest(fixture.desktopInput, { id: approval.id, result: { decision: "approved" } });
      await waitForRequest(requests, (request) => request.id === 21);
      expect(requests.find((request) => request.id === 21)).toEqual({
        id: 21,
        result: { decision: "approved" },
      });

      emitOfficial(fixture, {
        method: "turn/completed",
        params: { threadId, turn: { id: "turn-one", status: "completed" } },
      });
      await vi.waitFor(() => {
        expect(resolvedRequests(fixture)).toEqual([
          expect.objectContaining({ params: { threadId, requestId: firstTurn.requestId } }),
        ]);
      });
      // The other Turn's Question is untouched and still answerable.
      const reading = api.read({ threadId, view: "result" });
      await readThread(threadId);
      await expect(reading).resolves.toMatchObject({
        pendingQuestions: [expect.objectContaining({ interactionId: secondTurn.interactionId })],
      });
      await expect(
        api.answer({
          threadId,
          interactionId: firstTurn.interactionId,
          answers: { decision: ["Continue"] },
        }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
      await expect(
        api.answer({
          threadId,
          interactionId: secondTurn.interactionId,
          answers: { decision: ["Continue"] },
        }),
      ).resolves.toMatchObject({ interactionId: secondTurn.interactionId, status: "running" });
      await waitForRequest(requests, (request) => request.id === 12);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("settles a Desktop answer to a native Question and rejects an invalid one", async () => {
    const { fixture, ready } = questionFixture();
    const requests = officialRequests(fixture);
    const readThread = officialThreadReader(fixture, requests);
    try {
      const api = await ready();
      const threadId = "official-thread";
      const { requestId, interactionId } = await emitOfficialQuestion(
        fixture,
        {
          nativeId: 9,
          threadId,
          turnId: "official-turn",
        },
        api,
        readThread,
      );

      // An undeclared option, an unknown Question ID, and a malformed answer
      // shape are not delivered and do not consume the Question.
      for (const answers of [
        { decision: { answers: ["Undeclared"] } },
        { missing: { answers: ["Continue"] } },
        { decision: "not-an-answer-array" },
      ]) {
        writeRequest(fixture.desktopInput, { id: requestId, result: { answers } });
        await nextTick();
        expect(requests.some((request) => request.id === 9)).toBe(false);
      }
      const reading = api.read({ threadId, view: "result" });
      await readThread(threadId);
      await expect(reading).resolves.toMatchObject({
        pendingQuestions: [expect.objectContaining({ interactionId })],
      });

      writeRequest(fixture.desktopInput, {
        id: requestId,
        result: { answers: { decision: { answers: ["Continue"] } } },
      });
      await waitForRequest(requests, (request) => request.id === 9);
      expect(requests.find((request) => request.id === 9)).toEqual({
        id: 9,
        result: { answers: { decision: { answers: ["Continue"] } } },
      });
      await expect(
        api.answer({ threadId, interactionId, answers: { decision: ["Continue"] } }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("settles only one of two concurrent answers to a native Question", async () => {
    const { fixture, ready } = questionFixture();
    const requests = officialRequests(fixture);
    const readThread = officialThreadReader(fixture, requests);
    try {
      const api = await ready();
      const threadId = "official-thread";
      const { requestId, interactionId } = await emitOfficialQuestion(
        fixture,
        {
          nativeId: 7,
          threadId,
          turnId: "official-turn",
        },
        api,
        readThread,
      );

      const answered = api
        .answer({ threadId, interactionId, answers: { decision: ["Continue"] } })
        .then(
          () => "answered" as const,
          (error: DelegationControlError) => error,
        );
      writeRequest(fixture.desktopInput, {
        id: requestId,
        result: { answers: { decision: { answers: ["Continue"] } } },
      });

      const outcome = await answered;
      if (outcome !== "answered") expect(outcome).toMatchObject({ code: "QUESTION_NOT_PENDING" });
      await vi.waitFor(() => {
        expect(requests.filter((request) => request.id === 7)).toHaveLength(1);
      });
      const reading = api.read({ threadId, view: "result" });
      await readThread(threadId);
      await expect(reading).resolves.toMatchObject({ pendingQuestions: [] });
    } finally {
      await stopFixture(fixture);
    }
  });
});
