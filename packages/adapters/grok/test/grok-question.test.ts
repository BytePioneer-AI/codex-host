import { describe, expect, it } from "vitest";

import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  GROK_ACP_CLIENT_CAPABILITIES,
  GROK_ASK_USER_QUESTION_METHODS,
  createGrokQuestionInteraction,
  grokAskUserQuestionResponse,
  grokSkipInterviewResponse,
  parseGrokAskUserQuestionParams,
} from "../src/grok-question.js";

describe("Grok ask_user_question ACP envelope", () => {
  it("accepts both underscore-prefixed and bare wire methods", () => {
    expect(GROK_ASK_USER_QUESTION_METHODS).toEqual([
      "_x.ai/ask_user_question",
      "x.ai/ask_user_question",
    ]);
  });

  it("advertises Grok question RPCs without ACP elicitation.form", () => {
    expect(GROK_ACP_CLIENT_CAPABILITIES).toEqual({
      _meta: {
        "x.ai/ask_user_question": true,
        "x.ai/exit_plan_mode": true,
      },
    });
    expect(GROK_ACP_CLIENT_CAPABILITIES).not.toHaveProperty("elicitation");
  });

  it("parses camelCase and snake_case question payloads", () => {
    expect(
      parseGrokAskUserQuestionParams({
        sessionId: "session",
        timeoutMs: 30_000,
        questions: [
          {
            question: "Which path?",
            header: "Path",
            multiSelect: false,
            options: [
              { label: "Alpha", description: "First" },
              { label: "Beta", preview: "Second preview" },
            ],
          },
        ],
      }),
    ).toEqual({
      sessionId: "session",
      timeoutMs: 30_000,
      questions: [
        {
          question: "Which path?",
          header: "Path",
          multiSelect: false,
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second preview" },
          ],
        },
      ],
    });
    expect(
      parseGrokAskUserQuestionParams({
        session_id: "session",
        timeout_secs: 12,
        questions: [
          {
            question: "Which features?",
            multi_select: true,
            options: [{ label: "Search" }, { label: "Edit" }],
          },
        ],
      }),
    ).toMatchObject({
      sessionId: "session",
      timeoutMs: 12_000,
      questions: [{ question: "Which features?", multiSelect: true }],
    });
  });

  it("rejects empty, duplicate, or option-less questions", () => {
    expect(parseGrokAskUserQuestionParams({})).toBeNull();
    expect(parseGrokAskUserQuestionParams({ questions: [] })).toBeNull();
    expect(
      parseGrokAskUserQuestionParams({
        questions: [{ question: "Choose", options: [{ label: "A" }, { label: "A" }] }],
      }),
    ).toBeNull();
    expect(
      parseGrokAskUserQuestionParams({
        questions: [{ question: "Choose", options: [] }],
      }),
    ).toBeNull();
  });

  it("projects a Host Question and maps answers back to the native envelope", () => {
    const request = parseGrokAskUserQuestionParams({
      questions: [
        {
          question: "Which path?",
          options: [{ label: "Alpha" }, { label: "Beta" }],
        },
        {
          question: "Which features?",
          multiSelect: true,
          options: [{ label: "Search" }, { label: "Edit" }],
        },
      ],
    });
    if (!request) throw new Error("Expected a parsed Grok Question");
    const interaction = createGrokQuestionInteraction(
      request,
      hostInteractionIdSchema.parse("q-1"),
      hostTurnIdSchema.parse("turn-1"),
      1_000,
    );
    expect(interaction).toMatchObject({
      type: "question",
      title: "Grok",
      questions: [
        { id: "question-1", prompt: "Which path?", multiple: false, allowOther: true },
        { id: "question-2", prompt: "Which features?", multiple: true },
      ],
    });
    expect(
      grokAskUserQuestionResponse(request, {
        type: "question",
        answers: { "question-1": ["Alpha"], "question-2": ["Search", "Custom"] },
      }),
    ).toEqual({
      outcome: "accepted",
      answers: {
        "Which path?": "Alpha",
        "Which features?": ["Search", "Custom"],
      },
      annotations: {},
    });
    expect(
      grokAskUserQuestionResponse(request, { type: "question", answers: {}, cancelled: true }),
    ).toEqual(grokSkipInterviewResponse());
    expect(grokSkipInterviewResponse()).toEqual({ outcome: "skip_interview" });
  });
});
