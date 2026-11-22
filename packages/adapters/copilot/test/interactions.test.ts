import { describe, expect, it } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput, HostInteraction } from "@codexhost/harness-adapter";
import { CopilotInteractions } from "../src/interactions.js";
const turnId = hostTurnIdSchema.parse("turn");
const lastInteraction = (outputs: HarnessOutput[]): HostInteraction => {
  const result = outputs.find((output) => output.kind === "interaction");
  if (!result || result.kind !== "interaction") throw new Error("Missing interaction");
  return result.interaction;
};
describe("Copilot native callback ownership", () => {
  it("cancels only the requested Turn and leaves the next Turn's approval answerable", async () => {
    const outputs: HarnessOutput[] = [];
    const pending = new CopilotInteractions((output) => outputs.push(output));
    const next = hostTurnIdSchema.parse("next");
    const old = pending.question(turnId, { question: "Old" }).catch((error: unknown) => error);
    const approval = pending.permission(next, { kind: "read" } as Parameters<
      CopilotInteractions["permission"]
    >[1]);
    pending.cancel(turnId);
    pending.cancel(turnId);
    expect(await old).toBeInstanceOf(Error);
    const interaction = outputs.find(
      (o) => o.kind === "interaction" && o.interaction.turnId === next,
    );
    if (interaction?.kind !== "interaction") throw new Error("Missing approval");
    expect(
      pending.respond({
        type: "interaction.respond",
        interactionId: interaction.interaction.interactionId,
        response: { type: "approval", actionId: "allow" },
      }),
    ).toMatchObject({ ok: true });
    expect(await approval).toEqual({ kind: "approved" });
    pending.cancel();
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "interaction.closed"),
    ).toHaveLength(2);
  });
  it("offers only one-shot permission and validates the chosen action", async () => {
    const outputs: HarnessOutput[] = [];
    const pending = new CopilotInteractions((output) => outputs.push(output));
    const response = pending.permission(turnId, { kind: "read" } as Parameters<
      CopilotInteractions["permission"]
    >[1]);
    const interaction = lastInteraction(outputs);
    if (interaction.type !== "approval") throw new Error("Expected approval");
    expect(interaction.actions.map((action) => action.effect)).toEqual(["allowOnce", "deny"]);
    expect(
      pending.respond({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "approval", actionId: "allow-always" },
      }).ok,
    ).toBe(false);
    expect(
      pending.respond({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "approval", actionId: "allow" },
      }).ok,
    ).toBe(true);
    expect(await response).toEqual({ kind: "approved" });
  });
  it("validates answers, preserves freeform identity, and rejects duplicate responses", async () => {
    const outputs: HarnessOutput[] = [];
    const pending = new CopilotInteractions((output) => outputs.push(output));
    const response = pending.question(turnId, {
      question: "Choose",
      choices: ["A", "B"],
      allowFreeform: false,
    });
    const interaction = lastInteraction(outputs);
    expect(
      pending.respond({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { answer: ["C"] } },
      }).ok,
    ).toBe(false);
    const command = {
      type: "interaction.respond" as const,
      interactionId: interaction.interactionId,
      response: { type: "question" as const, answers: { answer: ["A"] } },
    };
    expect(pending.respond(command).ok).toBe(true);
    expect(await response).toEqual({ answer: "A", wasFreeform: false });
    expect(pending.respond(command).ok).toBe(false);
    pending.cancel();
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "interaction.closed"),
    ).toHaveLength(1);
  });
  it("cancels pending callbacks exactly once and rejects late replies", async () => {
    const outputs: HarnessOutput[] = [];
    const pending = new CopilotInteractions((output) => outputs.push(output));
    const response = pending.question(turnId, { question: "Answer" }).catch((error) => error);
    const interaction = lastInteraction(outputs);
    pending.cancel();
    pending.cancel();
    expect(await response).toBeInstanceOf(Error);
    expect(
      pending.respond({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { answer: ["late"] } },
      }).ok,
    ).toBe(false);
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "interaction.closed"),
    ).toHaveLength(1);
  });
});
