import { describe, expect, it } from "vitest";
import type { HostQuestionInteraction } from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import { projectCodexQuestionRequest } from "../src/index.js";

const interaction = (
  overrides: Partial<HostQuestionInteraction> = {},
): HostQuestionInteraction => ({
  type: "question",
  interactionId: hostInteractionIdSchema.parse("interaction-1"),
  turnId: hostTurnIdSchema.parse("turn-1"),
  itemId: hostItemIdSchema.parse("tool-1"),
  title: "Decision",
  questions: [
    {
      id: "decision",
      type: "choice",
      prompt: "Choose a path",
      options: [
        { value: "continue-value", label: "Continue", description: "Keep running" },
        { value: "stop-value", label: "Stop" },
      ],
      multiple: false,
      allowOther: false,
      optional: false,
    },
  ],
  expiresAt: "2026-07-29T08:00:10.000Z",
  ...overrides,
});

describe("Codex Question wire projection", () => {
  it("projects the reviewed requestUserInput shape and decodes labels to Host values", () => {
    const projected = projectCodexQuestionRequest({
      threadId: "thread-1",
      interaction: interaction(),
      itemId: "tool-1",
      emittedAtMs: Date.parse("2026-07-29T08:00:00.000Z"),
    });

    expect(projected.request).toEqual({
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "decision",
            header: "Decision",
            question: "Choose a path",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Continue", description: "Keep running" },
              { label: "Stop", description: "" },
            ],
          },
        ],
        isBlocking: true,
        autoResolutionMs: 10_000,
      },
    });
    expect(projected.parseResponse({ answers: { decision: { answers: ["Continue"] } } })).toEqual({
      type: "question",
      answers: { decision: ["continue-value"] },
    });
  });

  it("projects multiline editor semantics as the honest free-text shape", () => {
    const textInteraction = interaction({
      questions: [
        {
          id: "editor",
          type: "text",
          prompt: "Edit the value",
          multiline: true,
          secret: false,
          optional: false,
          prefill: "synthetic prefill",
        },
      ],
    });
    delete textInteraction.expiresAt;
    const projected = projectCodexQuestionRequest({
      threadId: "thread-1",
      interaction: textInteraction,
      itemId: "tool-1",
    });

    expect(projected.request).toMatchObject({
      params: {
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "editor",
            question: "Edit the value",
            isSecret: false,
            options: null,
          },
        ],
      },
    });
    expect(
      projected.parseResponse({ answers: { editor: { answers: ["line 1\nline 2"] } } }),
    ).toEqual({ type: "question", answers: { editor: ["line 1\nline 2"] } });
  });

  it("fails closed instead of rendering secret input as visible text", () => {
    const secretInteraction = interaction({
      questions: [
        {
          id: "secret",
          type: "text",
          prompt: "Secret value",
          multiline: false,
          secret: true,
          optional: false,
        },
      ],
    });
    expect(() =>
      projectCodexQuestionRequest({
        threadId: "thread-1",
        interaction: secretInteraction,
        itemId: "tool-1",
      }),
    ).toThrow("does not safely render secret Question input");
  });

  it("maps an empty Desktop answer set to explicit cancellation", () => {
    const projected = projectCodexQuestionRequest({
      threadId: "thread-1",
      interaction: interaction(),
      itemId: "tool-1",
    });
    expect(projected.parseResponse({ answers: {} })).toEqual({
      type: "question",
      answers: {},
      cancelled: true,
    });
  });

  it("rejects malformed, unknown, and undeclared Desktop answers", () => {
    const projected = projectCodexQuestionRequest({
      threadId: "thread-1",
      interaction: interaction(),
      itemId: "tool-1",
    });
    expect(() => projected.parseResponse({})).toThrow("missing answers object");
    expect(() =>
      projected.parseResponse({ answers: { unknown: { answers: ["Continue"] } } }),
    ).toThrow("unknown Question ID");
    expect(() =>
      projected.parseResponse({ answers: { decision: { answers: ["Other"] } } }),
    ).toThrow("undeclared choice");
    expect(() =>
      projected.parseResponse({ answers: { decision: { answers: ["Continue", "Stop"] } } }),
    ).toThrow("multiple answers");
  });
});
