import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RendererUpdateRequestTimeoutError,
  runBoundedRendererUpdateRequest,
} from "../../src/settings/update-request.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded renderer update requests", () => {
  it("returns the operation result and clears its timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    await expect(
      runBoundedRendererUpdateRequest(async () => "ready", controller.signal, 10),
    ).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a request that never responds", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = runBoundedRendererUpdateRequest(
      () => new Promise<never>(() => {}),
      controller.signal,
      10,
    );

    const assertion = expect(request).rejects.toBeInstanceOf(RendererUpdateRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("rejects when the settings page is disposed", async () => {
    const controller = new AbortController();
    const request = runBoundedRendererUpdateRequest(
      () => new Promise<never>(() => {}),
      controller.signal,
      10_000,
    );

    controller.abort();
    await expect(request).rejects.toThrow("aborted");
  });
});
