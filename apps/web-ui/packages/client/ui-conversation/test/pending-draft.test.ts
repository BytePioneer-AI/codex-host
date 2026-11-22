import { describe, expect, it } from "vitest";
import { PendingDraftBuffer } from "../src/client/input/pending-draft.ts";

describe("PendingDraftBuffer", () => {
  it("preserves typed text across retries and workspace switches, and clears on cancel or handoff", () => {
    const buffer = new PendingDraftBuffer();
    try {
      buffer.syncCreation({ state: "creating", token: 1 });
      buffer.paste("hello while creating");
      expect(buffer.text.getSnapshot()).toBe("hello while creating");

      // Failure and retry keep the same token and preserve typed text.
      buffer.syncCreation({ state: "error", token: 1 });
      buffer.syncCreation({ state: "creating", token: 1 });
      expect(buffer.text.getSnapshot()).toBe("hello while creating");

      // Successful handoff returns the draft and clears the buffer.
      expect(buffer.take()).toEqual({ text: "hello while creating", modified: true });
      expect(buffer.text.getSnapshot()).toBe("");
      expect(buffer.take()).toBeUndefined();

      // Navigating away resets to idle and discards unsent pending text.
      buffer.syncCreation({ state: "creating", token: 2 });
      buffer.paste("discard me");
      buffer.syncCreation({ state: "idle" });
      expect(buffer.text.getSnapshot()).toBe("");
      expect(buffer.take()).toBeUndefined();
    } finally {
      buffer.dispose();
    }
  });

  it("seeds initialPrompt without marking it modified until the user edits", () => {
    const buffer = new PendingDraftBuffer();
    try {
      buffer.syncCreation({ state: "creating", token: 3, initialPrompt: "seed prompt" });
      expect(buffer.text.getSnapshot()).toBe("seed prompt");
      expect(buffer.take()).toEqual({ text: "seed prompt", modified: false });

      buffer.syncCreation({ state: "creating", token: 4, initialPrompt: "seed prompt" });
      buffer.paste(" + edit");
      expect(buffer.take()).toEqual({ text: "seed prompt + edit", modified: true });
    } finally {
      buffer.dispose();
    }
  });
});
