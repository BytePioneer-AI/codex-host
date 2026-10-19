import { describe, expect, it, vi } from "vitest";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { ExternalVoiceResults, speakableFromProjectedTurn } from "../src/external-voice-results.js";

const threadId = "thread-1";
const turnId = hostTurnIdSchema.parse("11111111-1111-4111-8111-111111111111");
const itemId = hostItemIdSchema.parse("22222222-2222-4222-8222-222222222222");

describe("external voice results", () => {
  it("forwards completed commentary once while withholding the final answer", async () => {
    const progress = vi.fn();
    const results = new ExternalVoiceResults(progress);
    const pending = results.watch(threadId, turnId, new AbortController().signal);
    const item = {
      type: "agentMessage" as const,
      itemId,
      text: "Checking the findings.",
      phase: "commentary" as const,
    };
    results.observe(threadId, { type: "item.started", turnId, item });
    expect(progress).not.toHaveBeenCalled();
    const completed = {
      type: "item.completed" as const,
      turnId,
      snapshot: { item, outcome: { status: "succeeded" as const } },
    };
    results.observe("unrelated-thread", completed);
    expect(progress).not.toHaveBeenCalled();
    results.observe(threadId, completed);
    results.observe(threadId, completed);
    expect(progress.mock.calls).toEqual([[threadId, item.text]]);
    results.observe(
      threadId,
      { type: "turn.completed", turnId, outcome: { status: "succeeded" } },
      { items: [{ type: "agentMessage", text: "Audit complete.", phase: "final_answer" }] },
    );
    await expect(pending).resolves.toBe("Audit complete.");
  });

  it("recognizes unphased progress only after later work starts, without repeating it as a final", async () => {
    const progress = vi.fn();
    const results = new ExternalVoiceResults(progress);
    const pending = results.watch(threadId, turnId, new AbortController().signal);
    const item = { type: "agentMessage" as const, itemId, text: "Both scouts have returned." };
    results.observe(threadId, { type: "item.started", turnId, item });
    const completed = {
      type: "item.completed" as const,
      turnId,
      snapshot: { item, outcome: { status: "succeeded" as const } },
    };
    results.observe(threadId, completed);
    expect(progress).not.toHaveBeenCalled();
    const nextItemId = hostItemIdSchema.parse("33333333-3333-4333-8333-333333333333");
    const next = {
      type: "item.started" as const,
      turnId,
      item: { type: "agentMessage" as const, itemId: nextItemId, text: "Audit complete." },
    };
    results.observe(threadId, next);
    expect(progress.mock.calls).toEqual([[threadId, item.text]]);
    results.observe(threadId, completed);
    results.observe(threadId, {
      type: "item.completed",
      turnId,
      snapshot: { item: next.item, outcome: { status: "succeeded" } },
    });
    expect(progress).toHaveBeenCalledTimes(1);
    results.observe(threadId, { type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    await expect(pending).resolves.toBe("Audit complete.");
  });

  it("rejects failed work and session faults instead of reporting successful completion", async () => {
    const results = new ExternalVoiceResults();
    const controller = new AbortController();
    const failed = results.watch(threadId, turnId, controller.signal);
    const failedCheck = expect(failed).rejects.toThrow("did not complete");
    results.observe(threadId, { type: "turn.completed", turnId, outcome: { status: "cancelled" } });
    await failedCheck;
    const faulted = results.watch(threadId, turnId, controller.signal);
    const faultCheck = expect(faulted).rejects.toThrow("session failed");
    results.observe(threadId, {
      type: "session.faulted",
      error: { code: "internalError", message: "Session unavailable", retryable: false },
    });
    await faultCheck;
    expect(results.has(threadId, turnId)).toBe(false);
  });

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
