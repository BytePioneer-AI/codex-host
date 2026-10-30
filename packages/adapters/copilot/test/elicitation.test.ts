import { describe, expect, it } from "vitest";
import { elicitationForm } from "../src/elicitation.js";
import { CopilotInteractions } from "../src/interactions.js";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
const context = {
  sessionId: "native-session",
  message: "Form",
  requestedSchema: {
    type: "object" as const,
    properties: {
      count: { type: "integer" as const, minimum: 1, maximum: 3 },
      choice: {
        type: "array" as const,
        items: { type: "string" as const, enum: ["Alpha", "Beta"] },
        minItems: 1,
        maxItems: 2,
      },
    },
    required: ["count", "choice"],
  },
};
describe("Copilot native primitive forms", () => {
  it("preserves numbers and multi-select values and enforces native bounds", () => {
    const form = elicitationForm(context);
    expect(form.questions[1]).toMatchObject({ type: "choice", multiple: true, allowOther: false });
    expect(
      form.decode({ type: "question", answers: { count: ["2"], choice: ["Alpha", "Beta"] } }),
    ).toEqual({ action: "accept", content: { count: 2, choice: ["Alpha", "Beta"] } });
    expect(() =>
      form.decode({ type: "question", answers: { count: ["4"], choice: ["Alpha"] } }),
    ).toThrow(/limits/);
    expect(form.decode({ type: "question", answers: {}, cancelled: true })).toEqual({
      action: "cancel",
    });
  });
  it("keeps an invalid form response pending, then cancels exactly once", async () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new CopilotInteractions((output) => outputs.push(output));
    const response = interactions.elicitation(hostTurnIdSchema.parse("turn"), context);
    const opened = outputs[0];
    if (opened?.kind !== "interaction") throw new Error("Missing form");
    expect(
      interactions.respond({
        type: "interaction.respond",
        interactionId: opened.interaction.interactionId,
        response: { type: "question", answers: { count: ["4"], choice: ["Alpha"] } },
      }).ok,
    ).toBe(false);
    interactions.cancel();
    interactions.cancel();
    expect(await response).toEqual({ action: "cancel" });
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "interaction.closed"),
    ).toHaveLength(1);
  });
  it("does not pretend a URL flow is a form", () => {
    expect(() => elicitationForm({ ...context, mode: "url", url: "https://example.com/" })).toThrow(
      /supported primitive form/,
    );
  });
});
