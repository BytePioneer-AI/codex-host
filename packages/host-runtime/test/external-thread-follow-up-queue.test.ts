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
    expect(queue.list("thread").data).toEqual([added]);
    expect(queuedSubmissionText(added.input)).toBe("next task");
    expect(queue.peek("thread", "client-1")?.id).toBe(added.id);
    const taken = queue.take("thread", added.id);
    expect(taken).toEqual(added);
    expect(queue.list("thread").data).toEqual([]);
    queue.restore("thread", added);
    expect(queue.list("thread").data).toEqual([added]);
  });
});
