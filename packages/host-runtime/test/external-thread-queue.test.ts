import { expect, it, vi } from "vitest";
import { ExternalThreadQueue } from "../src/external-thread-queue.js";

it("retains source identity across editing, reordering and failed starts without exposing it", async () => {
  let id = 0;
  const queue = new ExternalThreadQueue({
    notifyChanged: vi.fn(async () => {}),
    createId: () => String(++id),
  });
  const input = [{ type: "text", text: "thread://target?hostId=remote" }];
  const first = await queue.add("thread", input, "message-1", "remote");
  const second = await queue.add("thread", input, "message-2", "other-host");
  expect(first).toEqual({ id: "1", input, clientUserMessageId: "message-1" });
  expect(second).toEqual({ id: "2", input, clientUserMessageId: "message-2" });
  expect(await queue.update("thread", first.id, input)).toEqual(first);
  await queue.reorder("thread", [second.id]);
  expect(queue.list("thread", {})).toEqual({ data: [second, first], nextCursor: null });
  const taken = queue.take("thread");
  expect(taken.sourceHostId).toBe("other-host");
  queue.restore("thread", taken);
  expect(queue.take("thread").sourceHostId).toBe("other-host");
  expect(queue.take("thread").sourceHostId).toBe("remote");
  await queue.add("thread", input, "message-3");
  expect(queue.take("thread").sourceHostId).toBeUndefined();
});

it("reserves only the matching input and restores its position after rejected steering", async () => {
  let id = 0;
  const notify = vi.fn(async () => {});
  const queue = new ExternalThreadQueue({ notifyChanged: notify, createId: () => String(++id) });
  const before = await queue.add("thread", [{ type: "text", text: "before" }], "before");
  const target = await queue.add(
    "thread",
    [{ type: "text", text: "steer", text_elements: [] }],
    "target",
    "source",
  );
  const after = await queue.add("thread", [{ type: "text", text: "after" }], "after");
  expect(() => queue.takeSteered("thread", "target", [{ type: "text", text: "edited" }])).toThrow(
    "changed",
  );
  expect(
    queue.takeSteered("another-thread", "target", [{ type: "text", text: "steer" }]),
  ).toBeUndefined();
  const taken = queue.takeSteered("thread", "target", [{ type: "text", text: "steer" }]);
  expect(taken?.sourceHostId).toBe("source");
  expect(queue.list("thread", {})).toEqual({ data: [before, after], nextCursor: null });
  if (!taken) throw new Error("Steered queue entry was not reserved");
  queue.restore("thread", taken);
  expect(queue.list("thread", {})).toEqual({ data: [before, target, after], nextCursor: null });
});

it("acknowledges an accepted steer's delete without acknowledging another Thread or arbitrary id", async () => {
  const queue = new ExternalThreadQueue({ notifyChanged: async () => {} });
  const input = [{ type: "text", text: "steer" }];
  const item = await queue.add("thread", input, "message");
  const taken = queue.takeSteered("thread", "message", input);
  if (!taken) throw new Error("Steered queue entry was not reserved");
  await queue.acceptSteered("thread", taken);
  expect(await queue.delete("thread", item.id)).toBe(true);
  expect(await queue.delete("other", item.id)).toBe(false);
  expect(await queue.delete("thread", "unknown")).toBe(false);
  queue.forget("thread");
  expect(await queue.delete("thread", item.id)).toBe(false);
});

it("rejects an ambiguous client identity instead of taking an arbitrary queued message", async () => {
  const queue = new ExternalThreadQueue({ notifyChanged: async () => {} });
  const input = [{ type: "text", text: "same" }];
  await queue.add("thread", input, "same-message");
  await queue.add("thread", input, "same-message");
  expect(() => queue.takeSteered("thread", "same-message", input)).toThrow("changed");
  expect(queue.list("thread", {}).data).toHaveLength(2);
});
