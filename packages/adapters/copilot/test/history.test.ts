import { describe, expect, it, vi } from "vitest";
import type { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { readPersistedEvents } from "../src/history.js";
const entry = (id: string) =>
  ({
    id,
    type: "user.message",
    parentId: null,
    timestamp: "2026-10-22T00:00:00Z",
    data: { messageId: id, content: "test" },
  }) as SessionEvent;
describe("Copilot complete native history reads", () => {
  it("discards an expired partial generation and retries from the beginning", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        events: [entry("old")],
        cursor: "old-cursor",
        cursorStatus: "ok",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        events: [],
        cursor: "expired",
        cursorStatus: "expired",
        hasMore: false,
      })
      .mockResolvedValueOnce({
        events: [entry("new")],
        cursor: "new-cursor",
        cursorStatus: "ok",
        hasMore: false,
      });
    const client = { rpc: { sessions: { readPersistedEvents: read } } } as unknown as CopilotClient;
    expect((await readPersistedEvents(client, "session")).map((e) => e.id)).toEqual(["new"]);
    expect(read.mock.calls[2]?.[0]).not.toHaveProperty("cursor");
  });
  it("fails after bounded expiry rather than returning an empty success", async () => {
    const read = vi.fn().mockResolvedValue({
      events: [],
      cursor: "expired",
      cursorStatus: "expired",
      hasMore: false,
    });
    const client = { rpc: { sessions: { readPersistedEvents: read } } } as unknown as CopilotClient;
    await expect(readPersistedEvents(client, "session")).rejects.toThrow(/completely/);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
