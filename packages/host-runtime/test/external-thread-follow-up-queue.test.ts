import { describe, expect, it } from "vitest";

import {
  ExternalThreadFollowUpQueue,
  queuedSubmissionText,
} from "../src/external-thread-follow-up-queue.js";

describe("ExternalThreadFollowUpQueue", () => {
  it("adds, lists, starts, and restores a follow-up", () => {
    const queue = new ExternalThreadFollowUpQueue();
    const input = [{ type: "text", text: "next task" }];
    const added = queue.add("thread", input, "client-1");
    expect(added.input).toEqual([{ type: "text", text: "next task", text_elements: [] }]);
    expect(queue.list("thread").data).toEqual([added]);
    expect(queuedSubmissionText(added.input)).toBe("next task");
    expect(queue.peek("thread", "client-1")?.id).toBe(added.id);
    const taken = queue.take("thread", added.id);
    expect(taken).toEqual(added);
    expect(queue.list("thread").data).toEqual([]);
    queue.restore("thread", added);
    expect(queue.list("thread").data).toEqual([added]);
  });

  it("preserves existing text_elements on queued text items", () => {
    const queue = new ExternalThreadFollowUpQueue();
    const input = [
      {
        type: "text",
        text: "kept",
        text_elements: [{ byteRange: { start: 0, end: 4 }, placeholder: "x" }],
      },
    ];
    expect(queue.add("thread", input, "client-2").input).toEqual(input);
  });

  it("canonicalizes input_text queue items to type text with text_elements", () => {
    const queue = new ExternalThreadFollowUpQueue();
    const added = queue.add("thread", [{ type: "input_text", text: "from desktop" }], "client-3");
    expect(added.input).toEqual([{ type: "text", text: "from desktop", text_elements: [] }]);
    const updated = queue.update("thread", added.id, [{ type: "input_text", text: "rewritten" }]);
    expect(updated?.input).toEqual([{ type: "text", text: "rewritten", text_elements: [] }]);
    expect(queue.list("thread").data[0]?.input).toEqual(updated?.input);
  });
});
