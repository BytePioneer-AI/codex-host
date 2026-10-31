import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput, HostQuestionInteraction } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { QuestionInteractions } from "../src/questions.js";

const plan = {
  id: "plan",
  reply_to_message_id: "native-user",
  confirm_info: {
    confirm_status: "unconfirmed",
    auto_confirm: false,
    interaction_instance_id: "native-instance",
  },
  tool_call_info: {
    name: "AskUserQuestion",
    params: {
      questions: [
        {
          header: "验收",
          question: "是否继续？",
          options: [{ label: "继续" }, { label: "停止" }],
          multiSelect: false,
        },
      ],
      answers: [{ selected_options: ["继续"] }],
    },
  },
};

function setup() {
  const outputs: HarnessOutput[] = [];
  const call = vi.fn<(method: string, input?: Record<string, unknown>) => Promise<unknown>>(
    async () => ({ accepted: true }),
  );
  const interactions = new QuestionInteractions(
    {
      sessionId: "native-session",
      messageId: "native-user",
      turnId: hostTurnIdSchema.parse("host-turn"),
    },
    { call },
    (output) => outputs.push(output),
  );
  const question = (): HostQuestionInteraction => {
    const output = outputs.find((entry) => entry.kind === "interaction");
    if (output?.kind !== "interaction" || output.interaction.type !== "question")
      throw new Error("Question was not emitted");
    return output.interaction;
  };
  return { interactions, outputs, call, question };
}

describe("TRAE CN public question interactions", () => {
  it("publishes each instance once without treating native prefilled answers as user input", async () => {
    const test = setup();
    test.interactions.observe(plan);
    test.interactions.observe(plan);
    expect(test.outputs).toHaveLength(1);
    const question = test.question();
    expect(question).toMatchObject({
      type: "question",
      turnId: "host-turn",
      questions: [
        {
          id: "question-0",
          prompt: "验收\n是否继续？",
          options: [{ value: "继续" }, { value: "停止" }],
          multiple: false,
          allowOther: true,
          optional: false,
        },
      ],
    });
    expect(test.call).not.toHaveBeenCalled();
    expect(
      await test.interactions.respond({
        type: "interaction.respond",
        interactionId: question.interactionId,
        response: { type: "question", answers: { "question-0": ["停止"] } },
      }),
    ).toEqual({ ok: true, value: { accepted: true } });
    expect(test.call).toHaveBeenCalledExactlyOnceWith("respond", {
      kind: "question",
      sessionId: "native-session",
      messageId: "native-user",
      planItemId: "plan",
      interactionId: "native-instance",
      answers: [["停止"]],
    });
    test.interactions.observe(plan);
    expect(test.outputs.filter((entry) => entry.kind === "interaction")).toHaveLength(1);
    test.interactions.observe({
      ...plan,
      confirm_info: { ...plan.confirm_info, confirm_status: "confirmed" },
    });
    test.interactions.close("expired");
    expect(test.outputs.filter((entry) => entry.kind === "event")).toEqual([
      {
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: question.interactionId,
          turnId: "host-turn",
          reason: "responded",
        },
      },
    ]);
  });

  it("closes superseded instances and rejects stale or invalid responses before RPC", async () => {
    const test = setup();
    test.interactions.observe(plan);
    const old = test.question();
    test.interactions.observe({
      ...plan,
      confirm_info: { ...plan.confirm_info, interaction_instance_id: "replacement" },
    });
    expect(
      await test.interactions.respond({
        type: "interaction.respond",
        interactionId: old.interactionId,
        response: { type: "question", answers: { "question-0": ["停止"] } },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
    const current = test.outputs.at(-1);
    if (current?.kind !== "interaction") throw new Error("Missing replacement question");
    expect(
      await test.interactions.respond({
        type: "interaction.respond",
        interactionId: current.interaction.interactionId,
        response: { type: "question", answers: {} },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(test.call).not.toHaveBeenCalled();
  });

  it("maps an explicit skip without sending any answers", async () => {
    const test = setup();
    test.interactions.observe(plan);
    await test.interactions.respond({
      type: "interaction.respond",
      interactionId: test.question().interactionId,
      response: { type: "question", cancelled: true, answers: {} },
    });
    expect(test.call.mock.calls[0]?.[1]).toMatchObject({ cancelled: true });
    expect(test.call.mock.calls[0]?.[1]).not.toHaveProperty("answers");
    expect(test.outputs.at(-1)).toMatchObject({
      event: { type: "interaction.closed", reason: "cancelled" },
    });
  });

  it("preserves native multi-select questions and all explicit choices", async () => {
    const test = setup();
    test.interactions.observe({
      ...plan,
      tool_call_info: {
        ...plan.tool_call_info,
        params: {
          questions: [
            {
              header: "多选",
              question: "请选择",
              options: [{ label: "A" }, { label: "B" }],
              multiSelect: true,
            },
          ],
        },
      },
    });
    const question = test.question();
    expect(question.questions[0]).toMatchObject({ multiple: true });
    expect(
      await test.interactions.respond({
        type: "interaction.respond",
        interactionId: question.interactionId,
        response: { type: "question", answers: { "question-0": ["A", "B"] } },
      }),
    ).toMatchObject({ ok: true });
    expect(test.call.mock.calls[0]?.[1]).toMatchObject({ answers: [["A", "B"]] });
  });

  it("serializes responses and does not cancel native work when its UI owner closes", async () => {
    const test = setup();
    test.interactions.observe(plan);
    let complete!: (value: unknown) => void;
    test.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const command = {
      type: "interaction.respond" as const,
      interactionId: test.question().interactionId,
      response: { type: "question" as const, answers: { "question-0": ["停止"] } },
    };
    const first = test.interactions.respond(command);
    expect(await test.interactions.respond(command)).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    test.interactions.close("superseded");
    complete({ accepted: true });
    await first;
    expect(test.call).toHaveBeenCalledOnce();
    expect(test.outputs.filter((entry) => entry.kind === "event")).toHaveLength(1);
  });

  it("rejects foreign ownership and changes to an already published question definition", () => {
    const test = setup();
    expect(() => test.interactions.observe({ ...plan, reply_to_message_id: "foreign" })).toThrow(
      "another Turn",
    );
    test.interactions.observe(plan);
    expect(() =>
      test.interactions.observe({
        ...plan,
        tool_call_info: { ...plan.tool_call_info, params: { questions: [] } },
      }),
    ).toThrow("no questions");
  });
});
