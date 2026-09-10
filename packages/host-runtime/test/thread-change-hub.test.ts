import { afterEach, expect, it, vi } from "vitest";
import { ThreadChangeHub } from "../src/thread-change-hub.js";

afterEach(() => vi.useRealTimers());

it("cancels losing waits without retaining their timers", async () => {
  vi.useFakeTimers();
  const hub = new ThreadChangeHub();
  const controller = new AbortController();
  const pending = hub.wait(0, 60_000, controller.signal);
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  await expect(pending).resolves.toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(hub.bump()).toBe(1);
});

it("observes a revision published before subscription", async () => {
  const hub = new ThreadChangeHub();
  const collected = hub.revision;
  hub.bump();
  await expect(hub.wait(collected, 60_000)).resolves.toBe(1);
  hub.close();
});
