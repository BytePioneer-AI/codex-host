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

it("reserves only the matching input and restores its position after rejected steering", () => {
  const queue = new ExternalThreadQueue();
  const before = queue.add("thread", [{ type: "text", text: "before" }], "before");
  const target = queue.add(
    "thread",
    [{ type: "text", text: "steer", text_elements: [] }],
    "target",
    [{ type: "text", text: "displayed steer" }],
    "source",
  );
  const after = queue.add("thread", [{ type: "text", text: "after" }], "after");
  expect(() => queue.takeSteered("thread", "target", [{ type: "text", text: "edited" }])).toThrow(
    "changed",
  );
  expect(
    queue.takeSteered("another-thread", "target", [{ type: "text", text: "steer" }]),
  ).toBeUndefined();
  const taken = queue.takeSteered("thread", "target", [{ type: "text", text: "steer" }]);
  expect(taken?.sourceHostId).toBe("source");
  expect(taken?.submission).toEqual(target);
  expect(queue.snapshot("thread").items).toEqual([before, after]);
  if (!taken) throw new Error("Steered queue entry was not reserved");
  queue.restore("thread", taken);
  queue.restore("thread", taken);
  expect(queue.snapshot("thread").items).toEqual([before, target, after]);
});

it("acknowledges an accepted steer's delete without acknowledging another Thread or arbitrary id", () => {
  const queue = new ExternalThreadQueue();
  const input = [{ type: "text", text: "steer" }];
  const item = queue.add("thread", input, "message");
  const taken = queue.takeSteered("thread", "message", input);
  if (!taken) throw new Error("Steered queue entry was not reserved");
  expect(queue.delete("thread", item.id)).toBe(false);
  queue.acceptSteered("thread", taken);
  expect(queue.delete("thread", item.id)).toBe(true);
  expect(queue.delete("other", item.id)).toBe(false);
  expect(queue.delete("thread", "unknown")).toBe(false);
  const remaining = queue.add("thread", input, "another-message");
  expect(queue.delete("thread", item.id)).toBe(true);
  expect(queue.snapshot("thread").items).toEqual([remaining]);
  queue.clear("thread");
  expect(queue.delete("thread", item.id)).toBe(false);
});

it("keeps add receipts idempotent while input is reserved and after steering accepts it", () => {
  const queue = new ExternalThreadQueue();
  const input = [{ type: "text", text: "same" }];
  const item = queue.add("thread", input, "message");
  expect(queue.add("thread", input, "message")).toEqual(item);
  const taken = queue.takeSteered("thread", "message", input);
  if (!taken) throw new Error("Steered queue entry was not reserved");
  expect(queue.add("thread", input, "message")).toEqual(item);
  expect(queue.has("thread")).toBe(false);
  queue.acceptSteered("thread", taken);
  expect(queue.add("thread", input, "message")).toEqual(item);
  expect(queue.has("thread")).toBe(false);
  expect(() => queue.add("thread", [{ type: "text", text: "changed" }], "message")).toThrow(
    "different input",
  );
});

it("restores a sole paused item after rejected steering", () => {
  const queue = new ExternalThreadQueue();
  const input = [{ type: "text", text: "steer" }];
  const item = queue.add("thread", input, "message");
  queue.pause("thread", "outcome-unknown");
  const taken = queue.takeSteered("thread", "message", input);
  if (!taken) throw new Error("Steered queue entry was not reserved");
  expect(taken.sourceHostId).toBeUndefined();
  expect(queue.has("thread")).toBe(false);
  queue.restore("thread", taken);
  expect(queue.snapshot("thread")).toEqual({ items: [item], pausedReason: "outcome-unknown" });
});

it("keeps later pause or resume decisions when rejected steering restores an item", () => {
  for (const action of ["pause", "resume"] as const) {
    const queue = new ExternalThreadQueue();
    const input = [{ type: "text", text: "steer" }];
    const item = queue.add("thread", input, "message");
    const other = queue.add("thread", input, "other-message");
    queue.pause("thread", "interrupted");
    const taken = queue.takeSteered("thread", "message", input);
    if (!taken) throw new Error("Steered queue entry was not reserved");
    if (action === "pause") queue.pause("thread", "failed");
    else queue.resume("thread");
    queue.restore("thread", taken);
    expect(queue.snapshot("thread")).toEqual({
      items: [item, other],
      pausedReason: action === "pause" ? "failed" : null,
    });
  }
});

it("rejects an ambiguous client identity after its add receipt expires", () => {
  const queue = new ExternalThreadQueue();
  const input = [{ type: "text", text: "same" }];
  queue.add("thread", input, "same-message");
  for (let i = 0; i < 256; i++) queue.add(`other-thread-${i}`, input, `message-${i}`);
  queue.add("thread", input, "same-message");
  expect(() => queue.takeSteered("thread", "same-message", input)).toThrow("changed");
  expect(queue.list("thread", {}).data).toHaveLength(2);
});
