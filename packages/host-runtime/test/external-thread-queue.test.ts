import { expect, it } from "vitest";
import { ExternalThreadQueue } from "../src/external-thread-queue.js";

it("retains source identity across editing, reordering and pending starts without exposing it", () => {
  const queue = new ExternalThreadQueue();
  const input = [{ type: "text", text: "thread://target?hostId=remote" }];
  const first = queue.add("thread", input, "message-1", undefined, "remote");
  const second = queue.add("thread", input, "message-2", undefined, "other-host");
  const publicItem = ({ id, input, clientUserMessageId }: typeof first) => ({
    id,
    input: input.map((part) => ({ ...part, text_elements: [] })),
    clientUserMessageId,
  });
  queue.update("thread", first.id, input);
  expect(queue.reorder("thread", [second.id])).toBe(true);
  expect(queue.list("thread", {})).toEqual({
    data: [publicItem(second), publicItem(first)],
    nextCursor: null,
  });
  expect(queue.head("thread")?.sourceHostId).toBe("other-host");
  // A rejected native start leaves the entry, its position and its source intact.
  expect(queue.find("thread", second.id)?.sourceHostId).toBe("other-host");
  queue.delete("thread", second.id);
  expect(queue.head("thread")?.sourceHostId).toBe("remote");
  queue.delete("thread", first.id);
  queue.add("thread", input, "message-3");
  expect(queue.head("thread")?.sourceHostId).toBeNull();
});

it("paginates public queue entries and rejects invalid cursors", () => {
  const queue = new ExternalThreadQueue();
  const input = [{ type: "text", text: "follow-up" }];
  queue.add("thread", input, "message-1");
  const second = queue.add("thread", input, "message-2");
  expect(queue.list("thread", { limit: 1 }).nextCursor).toBe("1");
  expect(queue.list("thread", { cursor: "1", limit: 1 })).toEqual({
    data: [
      {
        id: second.id,
        input: [{ type: "text", text: "follow-up", text_elements: [] }],
        clientUserMessageId: "message-2",
      },
    ],
    nextCursor: null,
  });
  expect(() => queue.list("thread", { cursor: "invalid" })).toThrow("cursor");
});
