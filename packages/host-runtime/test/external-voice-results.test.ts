import { describe, expect, it } from "vitest";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { ExternalVoiceResults, speakableFromProjectedTurn } from "../src/external-voice-results.js";

const threadId = "thread-1";
const turnId = hostTurnIdSchema.parse("11111111-1111-4111-8111-111111111111");
const itemId = hostItemIdSchema.parse("22222222-2222-4222-8222-222222222222");

describe("external voice results", () => {
  it("speaks the inferred final answer when live item completion is missing", async () => {
    const results = new ExternalVoiceResults();
    const controller = new AbortController();
    const pending = results.watch(threadId, turnId, controller.signal);
    results.observe(
      threadId,
      { type: "turn.completed", turnId, outcome: { status: "succeeded" } },
      {
        items: [
          { type: "commandExecution", command: "ls", status: "completed" },
          {
            type: "agentMessage",
            text: "Workspace has empty outputs/ and work/.",
            phase: "final_answer",
          },
        ],
      },
    );
    await expect(pending).resolves.toBe("Workspace has empty outputs/ and work/.");
  });

  it("accumulates streamed agent text before turn completion", async () => {
    const results = new ExternalVoiceResults();
    const controller = new AbortController();
    const pending = results.watch(threadId, turnId, controller.signal);
    results.observe(threadId, {
      type: "item.started",
      turnId,
      item: { type: "agentMessage", itemId, text: "" },
    });
    results.observe(threadId, {
      type: "item.updated",
      turnId,
      itemId,
      update: { type: "text.append", text: "The passphrase is blue moon." },
    });
    results.observe(threadId, {
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    await expect(pending).resolves.toBe("The passphrase is blue moon.");
  });

  it("prefers projected final_answer over commentary", () => {
    expect(
      speakableFromProjectedTurn({
        items: [
          { type: "agentMessage", text: "Checking files.", phase: "commentary" },
          { type: "agentMessage", text: "Only empty directories.", phase: "final_answer" },
        ],
      }),
    ).toBe("Only empty directories.");
  });
});
