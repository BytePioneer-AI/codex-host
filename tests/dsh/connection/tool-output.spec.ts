import { expect, it, vi } from "vitest";
import { RemoteError, type RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { ToolOutputCache } from "../../../apps/web-ui/packages/api/session-controller/src/client/tool-output.ts";

const reference = {
  sessionId: "s",
  epoch: "e",
  turn: 0,
  seq: 4,
  callId: "tool",
  part: 0,
  version: "v1",
};

it("shares Session Remote reads, caches successes including seeded views, and keys by content version", async () => {
  const gate = Promise.withResolvers<RemoteResult<{ text: string }>>();
  const remote = vi.fn(() => gate.promise);
  const cache = new ToolOutputCache(remote);
  const first = cache.read(reference);
  expect(cache.read(reference)).toBe(first);
  gate.resolve({ ok: true, value: { text: "complete projected text" } });
  expect(await first).toBe("complete projected text");
  expect(await cache.read(reference)).toBe("complete projected text");
  const restored = new ToolOutputCache(remote, cache.values);
  expect(await restored.read(reference)).toBe("complete projected text");
  expect(remote).toHaveBeenCalledExactlyOnceWith(reference);
  await cache.read({ ...reference, version: "v2" });
  expect(remote).toHaveBeenCalledTimes(2);
});

it("does not cache Remote failures and preserves stale errors for the refresh prompt", async () => {
  const error = new RemoteError("session/tool-output-stale", "Refresh", {});
  const remote = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error })
    .mockResolvedValueOnce({ ok: true, value: { text: "retried full output" } });
  const cache = new ToolOutputCache(remote);
  await expect(cache.read(reference)).rejects.toBe(error);
  expect(await cache.read(reference)).toBe("retried full output");
  expect(remote).toHaveBeenCalledTimes(2);
});
