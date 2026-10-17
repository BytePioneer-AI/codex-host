import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostClientChannel } from "../src/host-client-channel.js";

afterEach(() => vi.unstubAllGlobals());
it("settles stream readiness when attachment aborts after headers but before its first baseline", async () => {
  const epoch = randomUUID();
  const abort = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: { signal?: AbortSignal }) => {
      if (String(url).includes("/v1/events"))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    type: "hello",
                    version: 1,
                    cursor: { epoch, sequence: 0 },
                    reset: true,
                  }) + "\n",
                ),
              );
              options.signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
        );
      abort.abort();
      return new Response(new ReadableStream(), { headers: { "x-codexhost-epoch": epoch } });
    }),
  );
  const directory = await mkdtemp(path.join(tmpdir(), "owner-stream-test-"));
  const descriptor = {
    version: 1 as const,
    owner: "service" as const,
    pid: process.pid,
    port: 12345,
    token: "a".repeat(64),
    startedAt: Date.now(),
    epoch,
  };
  await writeFile(
    path.join(directory, `host-${process.pid}-${epoch}.json`),
    JSON.stringify(descriptor),
    { mode: 0o600 },
  );
  const channel = new HostClientChannel(directory, descriptor);
  await channel.start();
  try {
    await expect(
      channel.webCodexStream(
        { epoch, address: { scope: `web-codex:${"a".repeat(64)}` }, stream: "control", input: {} },
        { signal: abort.signal, item: () => {}, fail: () => {} },
      ),
    ).rejects.toThrow("closed before baseline");
  } finally {
    channel.close();
    await rm(directory, { recursive: true, force: true });
  }
});
