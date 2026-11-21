import { describe, expect, it, vi } from "vitest";
import {
  reconcileRemoteSidebarThread,
  sidebarCatalogForWindow,
} from "../src/remote-sidebar-history.js";

const key = { hostId: "remote-ssh-discovered:test", threadId: "placeholder" };
const cwd = "/workspace";
const absent = { jsonRpcCode: -32600, message: `thread not loaded: ${key.threadId}` };
function fixture() {
  const entry = { ...key, cwd, displayTitle: cwd, modelProvider: "openai" };
  const state = {
    id: key.threadId,
    hostId: key.hostId,
    cwd,
    title: null,
    modelProvider: "openai",
    resumeState: "needs_resume",
    threadRuntimeStatus: { type: "notLoaded" },
    turns: [],
    requests: [],
  };
  const catalog = {
    readEntries: vi.fn<() => Promise<unknown>>().mockResolvedValue([entry]),
    notifyThread: vi.fn(),
  };
  const manager = {
    sendRequest: vi.fn().mockRejectedValue(absent),
    getConversation: vi.fn().mockResolvedValue(state),
    discardConversationFromCache: vi.fn(),
  };
  const current = vi.fn(() => true);
  const run = () => reconcileRemoteSidebarThread(manager, key, cwd, async () => catalog, current);
  return { catalog, manager, run, entry, state, current };
}
describe("remote sidebar history", () => {
  it("shares discovery and rediscovers a catalog that initially resolves to null", async () => {
    const { catalog } = fixture();
    const discover = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(catalog);
    const load = sidebarCatalogForWindow(discover);
    const initial = load();
    expect(load()).toBe(initial);
    await expect(initial).rejects.toThrow(/catalog/i);
    expect(await load()).toBe(catalog);
    expect(await load()).toBe(catalog);
    expect(discover).toHaveBeenCalledTimes(2);
  });
  it("finishes catalog eviction on retry without discarding the recent cache twice", async () => {
    const f = fixture();
    f.manager.getConversation.mockResolvedValueOnce(f.state).mockResolvedValue(null);
    f.catalog.notifyThread.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await expect(f.run()).rejects.toThrow("temporarily unavailable");
    await f.run();
    expect(f.manager.discardConversationFromCache).toHaveBeenCalledTimes(1);
    expect(f.catalog.notifyThread).toHaveBeenCalledTimes(2);
    expect(f.catalog.notifyThread).toHaveBeenLastCalledWith(key, "remove");
  });
  it("evicts the confirmed empty thread from the catalog and recent cache", async () => {
    const f = fixture();
    await f.run();
    expect(f.manager.sendRequest).toHaveBeenCalledWith("thread/read", {
      threadId: key.threadId,
      includeTurns: false,
    });
    expect(f.catalog.notifyThread).toHaveBeenCalledWith(key, "remove");
    expect(f.manager.discardConversationFromCache).toHaveBeenCalledWith(key.threadId);
  });
  it("removes an old catalog-only row without unsubscribing a thread", async () => {
    const f = fixture();
    f.manager.getConversation.mockResolvedValue(null);
    await f.run();
    expect(f.catalog.notifyThread).toHaveBeenCalledOnce();
    expect(f.manager.discardConversationFromCache).not.toHaveBeenCalled();
  });
  it("retains a persisted untitled thread or a live draft", async () => {
    const f = fixture();
    f.manager.sendRequest.mockResolvedValue({ thread: { id: key.threadId } });
    await f.run();
    expect(f.catalog.readEntries).not.toHaveBeenCalled();
  });
  it.each([new Error("Disconnected"), { ...absent, jsonRpcCode: -32000 }])(
    "reports an unavailable Host for bounded retry",
    async (error) => {
      const f = fixture();
      f.manager.sendRequest.mockRejectedValue(error);
      await expect(f.run()).rejects.toBe(error);
      expect(f.catalog.readEntries).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...absent, message: "thread not loaded: another" },
    { ...absent, message: "External Native Session is unavailable" },
  ])("keeps the catalog on an inconclusive read", async (error) => {
    const f = fixture();
    f.manager.sendRequest.mockRejectedValue(error);
    await f.run();
    expect(f.catalog.readEntries).not.toHaveBeenCalled();
  });
  it.each([
    { hostId: "another" },
    { threadId: "another" },
    { cwd: "/elsewhere" },
    { modelProvider: "codexhost" },
    { displayTitle: "User title" },
  ])("preserves a changed catalog entry", async (patch) => {
    const f = fixture();
    f.catalog.readEntries.mockResolvedValue([{ ...f.entry, ...patch }]);
    await f.run();
    expect(f.catalog.notifyThread).not.toHaveBeenCalled();
    expect(f.manager.discardConversationFromCache).not.toHaveBeenCalled();
  });
  it.each([
    { turns: [{}] },
    { requests: [{}] },
    { threadRuntimeStatus: { type: "active" } },
    { resumeState: "resumed" },
    { modelProvider: "codexhost" },
  ])("preserves a cached thread with evidence of work", async (patch) => {
    const f = fixture();
    f.manager.getConversation.mockResolvedValue({ ...f.state, ...patch });
    await f.run();
    expect(f.catalog.notifyThread).not.toHaveBeenCalled();
  });
  it("ignores a reply after reconnect", async () => {
    const f = fixture();
    f.catalog.readEntries.mockImplementation(async () => {
      f.current.mockReturnValue(false);
      return [f.entry];
    });
    await f.run();
    expect(f.catalog.notifyThread).not.toHaveBeenCalled();
    expect(f.manager.discardConversationFromCache).not.toHaveBeenCalled();
  });
  it("keeps the catalog entry if eviction of the recent cache fails", async () => {
    const f = fixture();
    f.manager.discardConversationFromCache.mockRejectedValue(new Error("Disconnected"));
    await expect(f.run()).rejects.toThrow("Disconnected");
    expect(f.catalog.notifyThread).not.toHaveBeenCalled();
  });
});
