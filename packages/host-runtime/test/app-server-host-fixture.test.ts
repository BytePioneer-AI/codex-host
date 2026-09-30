import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLineCollector, requestId, writeRequest } from "./app-server-host-fixture.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("JsonLineCollector", () => {
  it.skipIf(process.platform !== "win32")(
    "allows Windows Host responses after the former two-second limit",
    async () => {
      vi.useFakeTimers();
      const stream = new PassThrough();
      const collector = new JsonLineCollector(stream);
      const response = { id: 42, result: { turn: { status: "inProgress" } } };
      const pending = collector
        .waitFor((message) => requestId(message, 42))
        .then(
          (message) => ({ message }),
          (error: unknown) => ({ error }),
        );

      // Disk-backed Host requests may outlast two seconds on Windows CI.
      await vi.advanceTimersByTimeAsync(2_500);
      writeRequest(stream, response);

      expect(await pending).toEqual({ message: response });
      expect(vi.getTimerCount()).toBe(0);
      stream.end();
    },
  );

  it("still rejects missing output and retains a later response", async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const collector = new JsonLineCollector(stream);
    const response = { id: 42, result: {} };
    const rejected = expect(collector.waitFor((message) => requestId(message, 42))).rejects.toThrow(
      "Timed out waiting for Host output",
    );

    await vi.runAllTimersAsync();
    await rejected;
    writeRequest(stream, response);

    await expect(collector.waitFor((message) => requestId(message, 42))).resolves.toEqual(response);
    expect(vi.getTimerCount()).toBe(0);
    stream.end();
  });
});
