import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { DelegationControlApi } from "../src/delegation-types.js";
import {
  createFixture,
  method,
  readJsonLine,
  requiredMessageId,
  startPiThread,
  startExternalThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;
function questionFixture() {
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
async function pendingId(api: DelegationControlApi, threadId: string): Promise<string> {
  const id = (await api.read({ threadId, view: "result" })).pendingQuestions?.[0]?.interactionId;
  if (!id) throw new Error("Question was not exposed by read");
  return id;
}
async function nativeRead(api: DelegationControlApi, fixture: Fixture, threadId: string) {
  const reading = api.read({ threadId, view: "result" });
  const read = await readJsonLine(fixture.official.stdin);
  expect(read.method).toBe("thread/read");
  writeRequest(fixture.official.stdout, {
    id: requiredMessageId(read),
    result: {
      thread: {
        id: threadId,
        status: { type: "active" },
        turns: [{ id: "native-turn", status: "inProgress", items: [] }],
      },
    },
  });
  return reading;
}
async function nativeQuestion(
  fixture: Fixture,
  nativeId: number,
  threadId: string,
  turnId: string,
) {
  const params = {
    threadId,
    turnId,
    itemId: `item-${nativeId}`,
    isBlocking: true,
    questions: [
      {
        id: "decision",
        header: "Choose",
        question: "Continue?",
        isOther: false,
        isSecret: false,
        options: [{ label: "Continue", description: "Keep going" }],
      },
    ],
    nativeExtension: { preserve: true },
  };
  writeRequest(fixture.official.stdout, {
    id: nativeId,
    method: "item/tool/requestUserInput",
    params,
  });
  const request = await fixture.collector.waitFor(
    (m) =>
      method(m, "item/tool/requestUserInput") && (m.params as JsonObject).itemId === params.itemId,
  );
  return { request, params };
}
const reply = { answers: { decision: { answers: ["Continue"] } } };

describe("Delegation uses the existing Question request and reply", () => {
  it("exposes the same external request and uses the existing label-to-value reply mapping", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      const nativeId = session.askQuestion({
        id: "decision",
        type: "choice",
        prompt: "Continue?",
        options: [{ value: "continue-value", label: "Continue" }],
        multiple: false,
        allowOther: false,
        optional: false,
      });
      const request = await fixture.collector.waitFor((m) =>
        method(m, "item/tool/requestUserInput"),
      );
      const snapshot = await api.read({ threadId, view: "result" });
      const pending = snapshot.pendingQuestions?.[0];
      if (!pending) throw new Error("Missing Question");
      expect(pending.request).toEqual(request.params);
      await expect(
        api.answer({ threadId, interactionId: pending.interactionId, result: reply }),
      ).resolves.toMatchObject({ threadId });
      expect(session.interactionResponses).toMatchObject([
        {
          interactionId: nativeId,
          response: { type: "question", answers: { decision: ["continue-value"] } },
        },
      ]);
      await expect(
        fixture.collector.waitFor((m) => method(m, "serverRequest/resolved")),
      ).resolves.toMatchObject({ params: { threadId, requestId: request.id } });
      await expect(
        api.answer({ threadId, interactionId: pending.interactionId, result: reply }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["answer", "close"] as const)(
    "scopes %s when two Sessions reuse an interaction ID",
    async (operation) => {
      const { fixture, ready } = questionFixture();
      try {
        const api = await ready();
        const firstThread = await startExternalThread(fixture, "codexhost/pi-native", 1);
        await startPiTurn(fixture, firstThread, 2);
        const secondThread = await startExternalThread(fixture, "codexhost/pi-native", 3);
        await startPiTurn(fixture, secondThread, 4);
        const [first, second] = fixture.adapter.sessions;
        if (!first || !second) throw new Error("Missing Sessions");
        const question = {
          id: "value",
          type: "text" as const,
          prompt: "Value?",
          multiline: false,
          optional: false,
          secret: false,
        };
        const localId = first.askQuestion(question);
        expect(second.askQuestion(question)).toBe(localId);
        for (const threadId of [firstThread, secondThread]) {
          await fixture.collector.waitFor(
            (m) =>
              method(m, "item/tool/requestUserInput") &&
              (m.params as JsonObject).threadId === threadId,
          );
        }
        const firstId = await pendingId(api, firstThread);
        const secondId = await pendingId(api, secondThread);
        expect(secondId).not.toBe(firstId);
        await expect(
          api.answer({ threadId: secondThread, interactionId: firstId, result: reply }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        if (operation === "answer") {
          await api.answer({
            threadId: secondThread,
            interactionId: secondId,
            result: { answers: { value: { answers: ["second"] } } },
          });
        } else second.expireQuestion(localId);
        await vi.waitFor(async () =>
          expect(
            (await api.read({ threadId: secondThread, view: "result" })).pendingQuestions,
          ).toEqual([]),
        );
        expect(
          (await api.read({ threadId: firstThread, view: "result" })).pendingQuestions,
        ).toMatchObject([{ interactionId: firstId }]);
        expect(first.interactionResponses).toEqual([]);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("settles only one external reply when Desktop and the delegator answer together", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      session.askQuestion({
        id: "decision",
        type: "choice",
        prompt: "Continue?",
        options: [{ value: "continue", label: "Continue" }],
        multiple: false,
        allowOther: false,
        optional: false,
      });
      const request = await fixture.collector.waitFor((m) =>
        method(m, "item/tool/requestUserInput"),
      );
      const interactionId = await pendingId(api, threadId);
      const answering = api.answer({ threadId, interactionId, result: reply }).catch((error) => {
        expect(error).toMatchObject({ code: "QUESTION_NOT_PENDING" });
      });
      writeRequest(fixture.desktopInput, { id: requiredMessageId(request), result: reply });
      await answering;
      await vi.waitFor(() => expect(session.interactionResponses).toHaveLength(1));
      expect((await api.read({ threadId, view: "result" })).pendingQuestions).toEqual([]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it.each(["delegation", "desktop", "race"] as const)(
    "passes native request/reply data unchanged through %s",
    async (entry) => {
      const { fixture, ready } = questionFixture();
      try {
        const api = await ready();
        const threadId = "native-thread";
        const { request, params } = await nativeQuestion(fixture, 7, threadId, "native-turn");
        const snapshot = await nativeRead(api, fixture, threadId);
        const interactionId = snapshot.pendingQuestions?.[0]?.interactionId;
        if (!interactionId) throw new Error("Missing native Question");
        expect(snapshot.pendingQuestions?.[0]?.request).toEqual(params);
        const result = { ...reply, nativeExtension: ["preserved"] };
        let delegationWon = entry === "delegation";
        if (entry === "race") {
          const answering = api.answer({ threadId, interactionId, result }).then(
            () => true,
            (error) => {
              expect(error).toMatchObject({ code: "QUESTION_NOT_PENDING" });
              return false;
            },
          );
          writeRequest(fixture.desktopInput, { id: requiredMessageId(request), result });
          delegationWon = await answering;
        } else if (entry === "delegation") await api.answer({ threadId, interactionId, result });
        else writeRequest(fixture.desktopInput, { id: requiredMessageId(request), result });
        expect(await readJsonLine(fixture.official.stdin)).toEqual({ id: 7, result });
        await expect(api.answer({ threadId, interactionId, result })).rejects.toMatchObject({
          code: "QUESTION_NOT_PENDING",
        });
        const closedBefore = fixture.collector.messages.filter((m) =>
          method(m, "serverRequest/resolved"),
        ).length;
        expect(closedBefore).toBe(delegationWon ? 1 : 0);
        writeRequest(fixture.official.stdout, {
          method: "serverRequest/resolved",
          params: { threadId, requestId: 7 },
        });
        writeRequest(fixture.desktopInput, { id: requiredMessageId(request), result: {} });
        await new Promise((resolve) => setImmediate(resolve));
        expect(
          fixture.collector.messages.filter((m) => method(m, "serverRequest/resolved")),
        ).toHaveLength(closedBefore);
        expect(fixture.official.stdin.read()).toBeNull();
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("keeps native Desktop error and unrecognised answer payloads on their original path", async () => {
    const { fixture, ready } = questionFixture();
    try {
      await ready();
      for (const [index, replyBody] of [
        { result: { answers: { nativeFutureShape: "untouched" } } },
        { error: { code: -32800, message: "cancelled" } },
      ].entries()) {
        const nativeId = index + 10;
        const { request } = await nativeQuestion(
          fixture,
          nativeId,
          "native-thread",
          `turn-${index}`,
        );
        writeRequest(fixture.desktopInput, { id: requiredMessageId(request), ...replyBody });
        expect(await readJsonLine(fixture.official.stdin)).toEqual({ id: nativeId, ...replyBody });
      }
    } finally {
      await stopFixture(fixture);
    }
  });

  it("retires only the native Question belonging to the ended Turn", async () => {
    const { fixture, ready } = questionFixture();
    try {
      const api = await ready();
      const threadId = "native-thread";
      const first = await nativeQuestion(fixture, 11, threadId, "first-turn");
      await nativeQuestion(fixture, 12, threadId, "second-turn");
      const before = await nativeRead(api, fixture, threadId);
      const oldId = before.pendingQuestions?.find((q) => q.turnId === "first-turn")?.interactionId;
      if (!oldId) throw new Error("Missing first Question");
      writeRequest(fixture.official.stdout, {
        method: "turn/completed",
        params: { threadId, turn: { id: "first-turn", status: "completed" } },
      });
      await fixture.collector.waitFor(
        (m) =>
          method(m, "serverRequest/resolved") &&
          (m.params as JsonObject).requestId === first.request.id,
      );
      const after = await nativeRead(api, fixture, threadId);
      expect(after.pendingQuestions).toHaveLength(1);
      expect(after.pendingQuestions?.[0]?.turnId).toBe("second-turn");
      await expect(
        api.answer({ threadId, interactionId: oldId, result: reply }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
      const id = after.pendingQuestions?.[0]?.interactionId;
      if (!id) throw new Error("Missing second Question");
      await api.answer({ threadId, interactionId: id, result: reply });
      expect(await readJsonLine(fixture.official.stdin)).toEqual({ id: 12, result: reply });
    } finally {
      await stopFixture(fixture);
    }
  });
});
