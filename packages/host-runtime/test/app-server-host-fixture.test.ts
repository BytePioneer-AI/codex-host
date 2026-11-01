import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLineCollector, requestId } from "./app-server-host-fixture.js";

const timeoutMs = process.platform === "win32" ? 10_000 : 2_000;

afterEach(() => vi.useRealTimers());

describe("JsonLineCollector", () => {
  it("accepts output before the platform-specific deadline and clears the timer", async () => {
    vi.useFakeTimers();
    const output = new PassThrough();
    const collector = new JsonLineCollector(output);
    const response = collector.waitFor((message) => requestId(message, 34));

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    output.write(`${JSON.stringify({ id: 34, result: {} })}\n`);

    await expect(response).resolves.toEqual({ id: 34, result: {} });
    expect(vi.getTimerCount()).toBe(0);
    await expect(collector.waitFor((message) => requestId(message, 34))).resolves.toEqual({
      id: 34,
      result: {},
    });
    output.end();
  });

  it("still rejects missing output at the platform-specific deadline", async () => {
    vi.useFakeTimers();
    const output = new PassThrough();
    const collector = new JsonLineCollector(output);
    const response = collector.waitFor((message) => requestId(message, 34));
    const rejection = expect(response).rejects.toThrow("Timed out waiting for Host output");

    await vi.advanceTimersByTimeAsync(timeoutMs);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    output.end();
  });
});
