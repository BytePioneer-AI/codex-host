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
