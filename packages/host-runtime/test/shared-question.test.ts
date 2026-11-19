import { describe, expect, it } from "vitest";
import type { HostQuestionInteraction } from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import {
  sharedQuestion,
  usesSharedQuestionCard,
  validateSharedQuestionResponse,
} from "../src/shared-question.js";

function interaction(): HostQuestionInteraction {
  return {
    type: "question",
    interactionId: hostInteractionIdSchema.parse("ask-1"),
    turnId: hostTurnIdSchema.parse("turn-1"),
    questions: [
      {
        id: "pick",
        type: "choice",
        prompt: "Pick",
        multiple: true,
        allowOther: true,
        optional: false,
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ],
      },
      { id: "text", type: "text", prompt: "Notes", multiline: true, secret: false, optional: true },
    ],
  };
}

describe("shared Question contract", () => {
  it("keeps mixed groups together and exposes only browser-safe public fields", () => {
    const input = interaction();
    expect(usesSharedQuestionCard(input)).toBe(true);
    expect(sharedQuestion(input)).toEqual({
      interactionId: "ask-1",
      turnId: "turn-1",
      questions: input.questions,
    });
    expect(() =>
      validateSharedQuestionResponse(input, {
        type: "question",
        answers: { pick: ["a", "b", "other"], text: ["note"] },
      }),
    ).not.toThrow();
  });
  it("leaves single-choice Other, plain text and native approvals alone", () => {
    const input = interaction();
    const choice = input.questions[0];
    if (choice?.type !== "choice") throw Error("expected choice");
    choice.multiple = false;
    expect(usesSharedQuestionCard(input)).toBe(false);
    expect(() => sharedQuestion(input)).toThrow();
  });
  it("refuses a secret field even when another field is multi-select", () => {
    const input = interaction();
    const text = input.questions[1];
    if (text?.type !== "text") throw Error("expected text");
    text.secret = true;
    expect(() => sharedQuestion(input)).toThrow();
  });
  it("validates every field of a mixed group and cancellation separately", () => {
    const input = interaction();
    for (const answers of [
      { pick: ["a", "a"] },
      { pick: ["a"], text: ["one", "two"] },
      { pick: ["a"], extra: ["b"] },
    ]) {
      expect(() => validateSharedQuestionResponse(input, { type: "question", answers })).toThrow();
    }
    expect(() =>
      validateSharedQuestionResponse(input, { type: "question", answers: {}, cancelled: true }),
    ).not.toThrow();
    expect(() =>
      validateSharedQuestionResponse(input, {
        type: "question",
        answers: { pick: ["a"] },
        cancelled: true,
      }),
    ).toThrow();
  });
});
