import { afterEach, describe, expect, it, vi } from "vitest";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HostQuestionResponse } from "@codexhost/harness-adapter";
import { QuestionInteractions } from "../src/question-interactions.js";
import { DelegationControlError } from "../src/delegation-types.js";

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
  const respond = vi.fn<(answer: HostQuestionResponse) => Promise<void>>(async () => undefined);
  questions.register({
    requestId: -1,
    threadId: "thread",
    harnessId: "pi",
    interaction: {
      type: "question",
      interactionId: hostInteractionIdSchema.parse("question"),
      turnId: hostTurnIdSchema.parse("turn"),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      questions: [
        {
          id: "value",
          type: "text",
          prompt: "Value?",
          multiline: false,
          optional: false,
          secret: false,
        },
      ],
    },
    parseResponse: () => ({ type: "question", answers: { value: ["desktop"] } }),
    respond,
  });
  const interactionId = questions.read("thread")[0]?.interactionId;
  if (!interactionId) throw new Error("Missing registered Question");
  const answer = () =>
    questions.answer({
      threadId: "thread",
      interactionId,
      answers: { value: ["cli"] },
    });
  return { questions, respond, answer, effects, interactionId };
}

afterEach(() => vi.useRealTimers());

describe("Question settlement across asynchronous boundaries", () => {
  it("does not reuse answer identities when the Host instance is rebuilt", async () => {
    const old = fixture();
    await old.questions.close(-1);
    const current = fixture();
    expect(current.interactionId).not.toBe(old.interactionId);
    for (const interactionId of [old.interactionId, "question"]) {
      await expect(
        current.questions.answer({
          threadId: "thread",
          interactionId,
          answers: { value: ["stale"] },
        }),
      ).rejects.toMatchObject({ code: "QUESTION_NOT_PENDING" });
    }
    expect(current.respond).not.toHaveBeenCalled();
    await current.answer();
    expect(current.respond).toHaveBeenCalledOnce();
  });

  it("keeps a rejected in-flight answer correctable despite a concurrent Desktop reply", async () => {
    const f = fixture();
    const delivering = Promise.withResolvers<undefined>();
    f.respond.mockImplementationOnce(() => delivering.promise);
    const rejected = expect(f.answer()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await f.questions.handleDesktopResponse({ id: -1, result: {} });
    expect(f.respond).toHaveBeenCalledTimes(1);
    delivering.reject(new DelegationControlError("INVALID_ARGUMENT", "Native answer rejected"));
    await rejected;
    expect(f.questions.read("thread")).toHaveLength(1);
    await f.answer();
    expect(f.respond).toHaveBeenCalledTimes(2);
    expect(f.questions.read("thread")).toEqual([]);
    expect(f.effects.resolved).toHaveBeenCalledTimes(1);
  });

  it("rejects an answer that expired while waiting for Host admission", async () => {
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
    expect(f.respond).toHaveBeenCalledExactlyOnceWith({
      type: "question",
      answers: {},
      cancelled: true,
    });
    expect(f.effects.resolved).toHaveBeenCalledTimes(1);
  });

  it("does not cancel or close twice when a timely answer settles after its deadline", async () => {
    vi.useFakeTimers();
    const f = fixture({ expiresAt: new Date(Date.now() + 1000).toISOString() });
    const delivering = Promise.withResolvers<undefined>();
    f.respond.mockImplementationOnce(() => delivering.promise);
    const answered = f.answer();
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.respond).toHaveBeenCalledTimes(1);
    // The Harness's close event may arrive before respond() acknowledges it.
    await f.questions.close(-1);
    delivering.resolve(undefined);
    await answered;
    expect(f.effects.resolved).toHaveBeenCalledTimes(1);
    expect(f.respond).toHaveBeenCalledTimes(1);
  });
});
