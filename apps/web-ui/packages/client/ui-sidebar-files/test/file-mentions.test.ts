import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { TranslateNS } from "@deepseek-ai/dsh-client-locale/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_MENTION_DEBOUNCE_MS, fileMentionSource } from "../src/client/file-mentions.ts";

const sessionId = "session-1" as SessionId;
const t = ((key: string) => key) as unknown as TranslateNS<"sidebarFiles">;

function makeRequest(query: string, signal: AbortSignal) {
  return {
    query,
    quoted: false,
    position: "inline" as const,
    drilled: false,
    signal,
  };
}

describe("fileMentionSource debounce and in-flight deduplication", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid queries and cancels earlier AbortSignals immediately without firing RPCs", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (_id: SessionId, query: string, _signal?: AbortSignal) => ({
      ok: true as const,
      value: [{ path: `src/${query}.ts`, kind: "file" as const }],
    }));
    const source = fileMentionSource({ fileReferences: { list } }, () => true, t);

    const c1 = new AbortController();
    const p1 = source.candidates({ sessionId }, makeRequest("a", c1.signal));
    await vi.advanceTimersByTimeAsync(FILE_MENTION_DEBOUNCE_MS - 30);
    expect(list).not.toHaveBeenCalled();

    c1.abort();
    await expect(p1).rejects.toThrow();

    const c2 = new AbortController();
    const p2 = source.candidates({ sessionId }, makeRequest("ab", c2.signal));
    await vi.advanceTimersByTimeAsync(FILE_MENTION_DEBOUNCE_MS);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[1]).toBe("ab");
    await expect(p2).resolves.toMatchObject([{ name: "src/ab.ts" }]);
  });

  it("deduplicates concurrent in-flight requests for the same query and aborts upstream once all waiters abort", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const deferred = Promise.withResolvers<{
      ok: true;
      value: Array<{ path: string; kind: "file" }>;
    }>();
    const list = vi.fn((_id: SessionId, _query: string, signal?: AbortSignal) => {
      capturedSignal = signal;
      return deferred.promise;
    });
    const source = fileMentionSource({ fileReferences: { list } }, () => true, t);

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = source.candidates({ sessionId }, makeRequest("app", c1.signal));
    await vi.advanceTimersByTimeAsync(FILE_MENTION_DEBOUNCE_MS);
    expect(list).toHaveBeenCalledTimes(1);

    // Second caller for the same query joins the in-flight RPC immediately.
    const p2 = source.candidates({ sessionId }, makeRequest("app", c2.signal));
    expect(list).toHaveBeenCalledTimes(1);

    // Aborting the first caller keeps the shared upstream RPC alive for the second.
    c1.abort();
    await expect(p1).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(false);

    // Aborting the last remaining caller cancels the upstream AbortSignal immediately.
    c2.abort();
    await expect(p2).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("resolves both deduplicated callers from a single in-flight RPC", async () => {
    vi.useFakeTimers();
    const deferred = Promise.withResolvers<{
      ok: true;
      value: Array<{ path: string; kind: "file" }>;
    }>();
    const list = vi.fn(() => deferred.promise);
    const source = fileMentionSource({ fileReferences: { list } }, () => true, t);

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = source.candidates({ sessionId }, makeRequest("readme", c1.signal));
    const p2 = source.candidates({ sessionId }, makeRequest("readme", c2.signal));
    await vi.advanceTimersByTimeAsync(FILE_MENTION_DEBOUNCE_MS);

    expect(list).toHaveBeenCalledTimes(1);
    deferred.resolve({ ok: true, value: [{ path: "README.md", kind: "file" }] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject([{ name: "README.md" }]);
    expect(r2).toMatchObject([{ name: "README.md" }]);
  });
});
