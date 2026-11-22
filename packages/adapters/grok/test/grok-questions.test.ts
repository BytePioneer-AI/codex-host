import { describe, expect, it } from "vitest";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type {
  HarnessOutput,
  HostQuestionInteraction,
  HostQuestionResponse,
} from "@codexhost/harness-adapter";
import { GrokQuestions, parseGrokQuestionRequest } from "../src/grok-questions.js";

const choice = {
  question: "Which platform?",
  multiSelect: true,
  options: [
    { id: "native-a", label: "Alpha", description: "First", preview: "Preview A" },
    { label: "Beta", description: "Second", preview: "Preview B" },
  ],
};
const request = { sessionId: "native", toolCallId: "ask", mode: "default", questions: [choice] };
function setup(value: unknown = request) {
  const outputs: HarnessOutput[] = [];
  let id = 0;
  const questions = new GrokQuestions(
    hostTurnIdSchema.parse("turn"),
    () => `ask-${++id}`,
    (output) => outputs.push(output),
  );
  const pending = questions.ask(parseGrokQuestionRequest(value));
  const output = outputs[0];
  if (output?.kind !== "interaction" || output.interaction.type !== "question")
    throw new Error("Missing question");
  const interaction: HostQuestionInteraction = output.interaction;
  const respond = (response: HostQuestionResponse) =>
    questions.respond({
      type: "interaction.respond",
      interactionId: interaction.interactionId,
      response,
    });
  return { questions, pending, interaction, outputs, respond };
}

describe("Grok native question mapping", () => {
  it("returns question text and every selected label, preserving previews and Other notes", async () => {
    const f = setup({
      ...request,
      mode: "plan",
      questions: [choice, { question: "Notes?", options: [] }],
    });
    expect(f.interaction).toMatchObject({
      questions: [
        {
          id: "q0",
          type: "choice",
          multiple: true,
          allowOther: true,
          optional: true,
          options: [{ value: "Alpha", description: "First\n\nPreview A" }, { value: "Beta" }],
        },
        { id: "q1", type: "text", secret: false, optional: true },
      ],
    });
    expect(
      f.respond({
        type: "question",
        answers: { q0: ["Alpha", "Beta", "Gamma, Delta"], q1: ["Notes"] },
      }),
    ).toMatchObject({ ok: true });
    await expect(f.pending).resolves.toEqual({
      outcome: "accepted",
      answers: {
        "Which platform?": ["Alpha", "Beta", "Other"],
        "Notes?": ["Other"],
      },
      annotations: {
        "Which platform?": { preview: "Preview A\n\nPreview B", notes: "Gamma, Delta" },
        "Notes?": { notes: "Notes" },
      },
    });
    expect(f.outputs.at(-1)).toMatchObject({
      kind: "event",
      event: { type: "interaction.closed", reason: "responded" },
    });
    expect(f.respond({ type: "question", answers: {} })).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });

  it("supports single-choice and omits unanswered optional questions", async () => {
    const f = setup({
      ...request,
      questions: [
        { ...choice, multiSelect: false },
        { question: "Notes?", options: [] },
      ],
    });
    expect(f.respond({ type: "question", answers: { q0: ["Alpha", "Beta"] } })).toMatchObject({
      ok: false,
    });
    expect(f.respond({ type: "question", answers: { q0: ["Beta"] } })).toMatchObject({ ok: true });
    await expect(f.pending).resolves.toEqual({
      outcome: "accepted",
      answers: { "Which platform?": ["Beta"] },
      annotations: { "Which platform?": { preview: "Preview B" } },
    });
  });

  it.each([
    { q0: ["Alpha", "Alpha"] },
    { q0: [" "] },
    { q0: ["Other 1", "Other 2"] },
    { missing: ["Alpha"] },
  ])("rejects invalid answers without consuming the pending request: %j", async (answers) => {
    const f = setup();
    expect(
      f.respond({ type: "question", answers: answers as Record<string, string[]> }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(f.questions.has(f.interaction.interactionId)).toBe(true);
    f.questions.cancel();
    await expect(f.pending).resolves.toEqual({ outcome: "cancelled" });
  });

  it("does not allow approval or foreign IDs to answer a question", async () => {
    const f = setup();
    for (const command of [
      {
        type: "interaction.respond" as const,
        interactionId: f.interaction.interactionId,
        response: { type: "approval" as const, actionId: "allow" },
      },
      {
        type: "interaction.respond" as const,
        interactionId: hostInteractionIdSchema.parse("foreign"),
        response: { type: "question" as const, answers: {} },
      },
    ])
      expect(f.questions.respond(command).ok).toBe(false);
    expect(f.respond({ type: "question", cancelled: true, answers: { q0: ["Alpha"] } }).ok).toBe(
      false,
    );
    expect(f.respond({ type: "question", cancelled: true, answers: {} }).ok).toBe(true);
    await expect(f.pending).resolves.toEqual({ outcome: "cancelled" });
  });

  it("cancels each pending request once and never reopens a closed Turn", async () => {
    const f = setup();
    await expect(f.questions.ask(parseGrokQuestionRequest(request))).resolves.toEqual({
      outcome: "cancelled",
    });
    const second = f.questions.ask(parseGrokQuestionRequest({ ...request, toolCallId: "second" }));
    f.questions.cancel();
    f.questions.cancel();
    f.questions.withdraw("ask");
    await expect(f.pending).resolves.toEqual({ outcome: "cancelled" });
    await expect(second).resolves.toEqual({ outcome: "cancelled" });
    await expect(
      f.questions.ask(parseGrokQuestionRequest({ ...request, toolCallId: "late" })),
    ).resolves.toEqual({ outcome: "cancelled" });
    expect(f.outputs.filter((output) => output.kind === "interaction")).toHaveLength(2);
    expect(f.outputs.filter((output) => output.kind === "event")).toHaveLength(2);
  });

  it("withdraws only matching pending questions; earlier permission resolution cannot suppress a later question", async () => {
    const f = setup();
    f.questions.withdraw("later");
    const second = f.questions.ask(parseGrokQuestionRequest({ ...request, toolCallId: "later" }));
    f.questions.withdraw("ask");
    expect(f.respond({ type: "question", answers: {} }).ok).toBe(false);
    await expect(f.pending).resolves.toEqual({ outcome: "cancelled" });
    expect(f.outputs.filter((output) => output.kind === "event")).toHaveLength(1);
    f.questions.cancel();
    await expect(second).resolves.toEqual({ outcome: "cancelled" });
  });

  it("preserves prototype-looking question text as a literal answer key", async () => {
    const f = setup({ ...request, questions: [{ question: "__proto__", options: [] }] });
    f.respond({ type: "question", answers: { q0: ["Literal"] } });
    const result = await f.pending;
    expect(result).toEqual({
      outcome: "accepted",
      answers: JSON.parse('{"__proto__":["Other"]}'),
      annotations: JSON.parse('{"__proto__":{"notes":"Literal"}}'),
    });
  });

  it("does not invent Host expiry or expose patched native timer metadata", async () => {
    const f = setup({
      ...request,
      timeout: { deadlineUnixMs: 1, action: "recommended", resetOnActivity: true },
    });
    expect(f.interaction).not.toHaveProperty("expiresAt");
    expect(f.interaction).not.toHaveProperty("autoResolution");
    f.questions.cancel();
    await f.pending;
  });
});

describe("Grok question protocol parsing", () => {
  it.each(["multiSelect", "multi_select"])("accepts %s without requiring opaque IDs", (flag) => {
    const base = { question: choice.question, options: choice.options };
    expect(
      parseGrokQuestionRequest({ ...request, questions: [{ ...base, [flag]: true }] }).questions[0]
        ?.multiple,
    ).toBe(true);
  });
  it.each([
    null,
    { ...request, sessionId: "" },
    { ...request, toolCallId: " " },
    { ...request, mode: "unknown" },
    { ...request, questions: [] },
    { ...request, questions: [choice, choice] },
    { ...request, questions: [{ ...choice, multi_select: false }] },
    { ...request, questions: [{ ...choice, multiSelect: "yes" }] },
    { ...request, questions: [{ ...choice, options: [choice.options[0], choice.options[0]] }] },
    { ...request, questions: [{ ...choice, options: [{ label: "A", description: 2 }] }] },
    {
      ...request,
      questions: [{ ...choice, options: [{ label: "A", description: "", preview: 2 }] }],
    },
  ])("rejects malformed native requests: %j", (value) => {
    expect(() => parseGrokQuestionRequest(value)).toThrow();
  });
});
