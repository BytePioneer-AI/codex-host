import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { QuestionInteractions } from "../src/question-interactions.js";

function fixture(options: { expiresAt?: string; gate?: Promise<void> } = {}) {
  const effects = {
    run: async <T>(_threadId: string, action: () => Promise<T>): Promise<T> => {
      if (options.gate) await options.gate;
      return action();
    },
    resolved: vi.fn(async () => undefined),
    diagnose: vi.fn(),
  };
  const questions = new QuestionInteractions(effects);
  const respond = vi.fn<(reply: JsonObject) => Promise<void>>(async () => undefined);
  const request = { questions: [{ id: "value", question: "Value?", options: null }] };
  questions.register({
    requestId: -1,
    threadId: "thread",
    turnId: "turn",
    harnessId: "pi",
    request,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    respond,
  });
  const interactionId = questions.read("thread")[0]?.interactionId;
  if (!interactionId) throw new Error("Missing registered Question");
  const result = { answers: { value: { answers: ["cli"] } }, nativeField: "untouched" };
  const answer = () => questions.answer({ threadId: "thread", interactionId, result });
  return { questions, respond, answer, effects, interactionId, result, request };
}

afterEach(() => vi.useRealTimers());

describe("Pending Question ownership", () => {
  it.each(["", " \t", undefined, null, 42])(
    "rejects an invalid Thread ID (%j) without consuming the request",
    async (threadId) => {
      const f = fixture();
      await expect(
        f.questions.answer({
          threadId: threadId as string,
          interactionId: f.interactionId,
          result: f.result,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: "Thread identifier is required",
      });
      expect(f.respond).not.toHaveBeenCalled();
      await f.answer();
      expect(f.respond).toHaveBeenCalledOnce();
    },
  );

  it("preserves request/reply data and rejects identities from a previous Host", async () => {
    const old = fixture();
    await old.questions.close(-1);
    const current = fixture();
    expect(current.interactionId).not.toBe(old.interactionId);
    expect(current.questions.read("thread")[0]?.request).toBe(current.request);
    await expect(
      current.questions.answer({
        threadId: "thread",
        interactionId: old.interactionId,
        result: current.result,
      }),
    ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    await current.answer();
    expect(current.respond).toHaveBeenCalledExactlyOnceWith({ result: current.result });
  });

  it("claims one reply across both entries and never retries an uncertain failure", async () => {
    const f = fixture();
    const delivering = Promise.withResolvers<undefined>();
    f.respond.mockImplementationOnce(() => delivering.promise);
    const rejected = expect(f.answer()).rejects.toThrow("lost reply acknowledgement");
    await f.questions.handleDesktopResponse({ id: -1, result: {} }, false);
    expect(f.respond).toHaveBeenCalledOnce();
    delivering.reject(new Error("lost reply acknowledgement"));
    await rejected;
    await expect(f.answer()).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    expect(f.respond).toHaveBeenCalledOnce();
    expect(f.effects.resolved).toHaveBeenCalledOnce();
  });

  it("does not reuse a public credential when a native request ID is registered again", async () => {
    const f = fixture();
    const native = {
      requestId: "native-item",
      threadId: "thread",
      turnId: "turn",
      harnessId: "codex" as const,
      request: { title: "Choose?" },
      respond: f.respond,
    };
    f.questions.register(native);
    const previous = f.questions
      .read("thread")
      .find((question) => question.request === native.request);
    if (!previous) throw new Error("Missing native Question");
    await f.questions.close(native.requestId);
    f.questions.register(native);
    await expect(
      f.questions.answer({
        threadId: "thread",
        interactionId: previous.interactionId,
        result: { answer: "Yes" },
      }),
    ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    expect(f.respond).not.toHaveBeenCalled();
  });

  it("dismisses a Desktop reply in other clients only when clients share Threads", async () => {
    const local = fixture();
    await local.questions.handleDesktopResponse({ id: -1, result: {} }, false);
    expect(local.respond).toHaveBeenCalledOnce();
    expect(local.effects.resolved).not.toHaveBeenCalled();

    const shared = fixture();
    await shared.questions.handleDesktopResponse({ id: -1, result: {} }, true);
    expect(shared.respond).toHaveBeenCalledOnce();
    expect(shared.effects.resolved).toHaveBeenCalledExactlyOnceWith("thread", -1);
  });

  it("expires before a queued answer can claim the request", async () => {
    vi.useFakeTimers();
    const admission = Promise.withResolvers<undefined>();
    const f = fixture({
      gate: admission.promise,
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    const rejected = expect(f.answer()).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.questions.read("thread")).toEqual([]);
    admission.resolve(undefined);
    await rejected;
    expect(f.respond).toHaveBeenCalledExactlyOnceWith({ result: { answers: {} } });
    expect(f.effects.resolved).toHaveBeenCalledOnce();
  });

  it("does not cancel an already claimed reply or resolve it twice", async () => {
    vi.useFakeTimers();
    const f = fixture({ expiresAt: new Date(Date.now() + 1000).toISOString() });
    const delivering = Promise.withResolvers<undefined>();
    f.respond.mockImplementationOnce(() => delivering.promise);
    const answered = f.answer();
    await vi.advanceTimersByTimeAsync(1001);
    await f.questions.close(-1);
    delivering.resolve(undefined);
    await answered;
    expect(f.effects.resolved).toHaveBeenCalledOnce();
    expect(f.respond).toHaveBeenCalledOnce();
  });
});
