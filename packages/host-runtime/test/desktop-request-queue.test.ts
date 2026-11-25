import { describe, expect, it } from "vitest";

import { DesktopRequestQueue } from "../src/desktop-request-queue.js";

describe("DesktopRequestQueue", () => {
  it("orders each Thread independently and drains admitted work", async () => {
    const queue = new DesktopRequestQueue();
    const release = Promise.withResolvers<undefined>();
    const calls: string[] = [];
    const first = queue.run("thread-a", async () => {
      calls.push("first");
      await release.promise;
    });
    const second = queue.run("thread-a", async () => {
      calls.push("second");
    });
    await Promise.all([
      queue.run("thread-b", async () => {
        calls.push("other");
      }),
      queue.run(undefined, async () => {
        calls.push("unkeyed");
      }),
    ]);
    expect(calls).toEqual(["first", "other", "unkeyed"]);
    let drained = false;
    const draining = queue.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve(undefined);
    await Promise.all([first, second, draining]);
    expect(calls).toEqual(["first", "other", "unkeyed", "second"]);
    expect(drained).toBe(true);
  });

  it("returns failures to the caller without poisoning subsequent routing or drain", async () => {
    const queue = new DesktopRequestQueue();
    const failure = new Error("routing failed");
    const failed = queue.run("thread", async () => {
      throw failure;
    });
    let ran = false;
    const next = queue.run("thread", async () => {
      ran = true;
    });
    await expect(failed).rejects.toBe(failure);
    await next;
    await queue.drain();
    expect(ran).toBe(true);
  });
});
