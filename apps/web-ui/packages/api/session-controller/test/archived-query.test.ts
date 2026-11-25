import { expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace/types";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { SessionListRequest, SessionListValue, SessionSummary } from "../src/types.ts";
import { SessionManager } from "../src/client/sessions/manager.ts";
import type { SessionRemotes } from "../src/client/sessions/remotes.ts";
import { TYPERT_REMOTE } from "../generated/remote.js";

// The browser export is a loader bundle. Load the same Gateway source in Node.
vi.mock("@deepseek-ai/dsh-api-gateway/client", () => import("../../gateway/src/client/index.ts"));

const ordinary = SessionId("ordinary");
const archived = SessionId("archived");
const deleted = SessionId("deleted");
const row = (sessionId: SessionId, running = false): SessionSummary => ({
  sessionId,
  agentAvailable: true,
  updatedAt: 1,
  running,
  blank: false,
});
const ok = (
  items: readonly SessionSummary[],
  archivedSessionIds?: readonly SessionId[],
): RemoteResult<SessionListValue> => ({
  ok: true,
  value: { items, ...(archivedSessionIds === undefined ? {} : { archivedSessionIds }) },
});
const ids = (manager: SessionManager) =>
  manager.getListSnapshot().items.map((summary) => summary.sessionId);

function fixture() {
  const list = vi.fn<(request: SessionListRequest) => Promise<RemoteResult<SessionListValue>>>(
    async () => ok([row(ordinary)]),
  );
  const manager = new SessionManager({ session: { list } } as unknown as SessionRemotes);
  return { manager, list };
}

it("keeps the optional archive fields through the generated wire codecs", () => {
  const descriptor = TYPERT_REMOTE.descriptors.find(
    (item) => item.namespace === "session" && item.method === "list",
  );
  const request = descriptor?.parameters[0]?.codec;
  const response = descriptor?.result;
  expect(request?.mode).toBe("strict");
  expect(response?.mode).toBe("strict");
  if (request?.mode !== "strict" || response?.mode !== "strict") throw new Error("missing codec");
  expect(request.create().parse({})).toEqual({});
  expect(request.create().parse({ includeArchived: true })).toEqual({ includeArchived: true });
  expect(request.create().parse({ includeArchived: false })).toEqual({ includeArchived: false });
  expect(response.create().parse({ items: [], archivedSessionIds: [archived] })).toEqual({
    items: [],
    archivedSessionIds: [archived],
  });
  expect(response.create().parse({ items: [] })).toEqual({ items: [] });
  expect(response.create().parse({ items: [], nextCursor: "native-next" })).toEqual({
    items: [],
    nextCursor: "native-next",
  });
  expect(request.create().parse({ sessionId: ordinary, cursor: "native-next" })).toEqual({
    sessionId: ordinary,
    cursor: "native-next",
  });
});

it("defaults to active-only and reuses only same-scope in-flight refreshes", async () => {
  const { manager, list } = fixture();
  const gate = Promise.withResolvers<RemoteResult<SessionListValue>>();
  list.mockReturnValueOnce(gate.promise);
  const first = manager.refreshList();
  expect(manager.refreshList()).toBe(first);
  expect(list).toHaveBeenCalledExactlyOnceWith({ includeArchived: false });
  gate.resolve(ok([row(ordinary)]));
  await first;
  await manager.setIncludeArchived(true);
  await manager.setIncludeArchived(true);
  expect(list).toHaveBeenCalledTimes(2);
  await manager.refreshList();
  expect(list).toHaveBeenLastCalledWith({ includeArchived: true });
  await manager.setIncludeArchived(false);
  expect(list).toHaveBeenLastCalledWith({ includeArchived: false });
  await manager.dispose();
});

it("loads the new scope while an old scope is in flight and fences both stale responses", async () => {
  const { manager, list } = fixture();
  const first = Promise.withResolvers<RemoteResult<SessionListValue>>();
  const second = Promise.withResolvers<RemoteResult<SessionListValue>>();
  list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const activePull = manager.refreshList();
  const archivePull = manager.setIncludeArchived(true);
  expect(list.mock.calls.map(([request]) => request.includeArchived)).toEqual([false, true]);
  await manager.setIncludeArchived(false);
  expect(list).toHaveBeenCalledTimes(3);
  manager.handleSessionAdded(row(SessionId("live")));
  second.resolve(ok([row(archived)], [archived]));
  first.resolve(ok([row(deleted)]));
  await Promise.all([activePull, archivePull]);
  expect(ids(manager)).toEqual([SessionId("live"), ordinary]);
  expect(manager.getListSnapshot().state).toBe("idle");
  await manager.dispose();
});

it("preserves loaded known archives and resident/running state, but drops missing ordinary rows", async () => {
  const { manager, list } = fixture();
  list.mockResolvedValueOnce(ok([row(ordinary), row(archived, true), row(deleted)], [archived]));
  await manager.setIncludeArchived(true);
  const resident = manager.get(archived);
  const before = resident.getSnapshot();
  list.mockResolvedValueOnce(ok([row(ordinary)], [archived]));
  await manager.setIncludeArchived(false);
  expect(ids(manager)).toEqual([ordinary, archived]);
  expect(manager.get(archived)).toBe(resident);
  expect(resident.getSnapshot()).toBe(before);
  expect(resident.getSnapshot().running).toBe(true);
  expect(resident.getSnapshot().removed).toBe(false);
  manager.resolveTarget(archived);
  // An inclusive list is authoritative for deletion, even for a formerly archived row.
  list.mockResolvedValueOnce(ok([row(ordinary)]));
  await manager.setIncludeArchived(true);
  expect(ids(manager)).toEqual([ordinary]);
  await manager.dispose();
});

const paged = (
  items: readonly SessionSummary[],
  nextCursor: string | null,
  archivedSessionIds: readonly SessionId[] = [],
): RemoteResult<SessionListValue> => ({
  ok: true,
  value: { items, nextCursor, archivedSessionIds },
});

it("merges native pages, deduplicates reordering and keeps an independent continuation across head refreshes", async () => {
  const { manager, list } = fixture();
  list.mockResolvedValueOnce(paged([row(ordinary)], "20"));
  await manager.refreshList();
  expect(manager.getListSnapshot().hasMore).toBe(true);
  list.mockResolvedValueOnce(paged([row(ordinary), row(archived)], "40"));
  await manager.loadMore();
  expect(list).toHaveBeenLastCalledWith({ includeArchived: false, cursor: "20" });
  expect(ids(manager)).toEqual([ordinary, archived]);
  list.mockResolvedValueOnce(paged([{ ...row(archived), updatedAt: 100 }], "20"));
  await manager.refreshList();
  expect(ids(manager)).toEqual([ordinary, archived]);
  list.mockResolvedValueOnce(paged([row(deleted)], null));
  await manager.loadMore();
  expect(list).toHaveBeenLastCalledWith({ includeArchived: false, cursor: "40" });
  expect(new Set(ids(manager)).size).toBe(3);
  const count = list.mock.calls.length;
  await manager.loadMore();
  expect(list).toHaveBeenCalledTimes(count);
  expect(manager.getListSnapshot().hasMore).toBe(false);
  await manager.dispose();
});

it("does not let another browser or an old archive-scope page overwrite the current continuation", async () => {
  const a = fixture(),
    b = fixture();
  a.list.mockResolvedValueOnce(paged([row(ordinary)], "a20"));
  b.list.mockResolvedValueOnce(paged([row(ordinary)], "b20"));
  await Promise.all([a.manager.refreshList(), b.manager.refreshList()]);
  const old = Promise.withResolvers<RemoteResult<SessionListValue>>();
  a.list.mockReturnValueOnce(old.promise);
  const page = a.manager.loadMore();
  a.list.mockResolvedValueOnce(paged([row(archived)], "archive20", [archived]));
  await a.manager.setIncludeArchived(true);
  old.resolve(paged([row(deleted)], null));
  await page;
  expect(ids(a.manager)).not.toContain(deleted);
  expect(a.manager.getListSnapshot().hasMore).toBe(true);
  a.list.mockResolvedValueOnce(paged([row(archived)], null, [archived]));
  await a.manager.loadMore();
  expect(a.list).toHaveBeenLastCalledWith({ includeArchived: true, cursor: "archive20" });
  b.list.mockResolvedValueOnce(paged([row(deleted)], null));
  await b.manager.loadMore();
  expect(b.list).toHaveBeenLastCalledWith({ includeArchived: false, cursor: "b20" });
  await Promise.all([a.manager.dispose(), b.manager.dispose()]);
});

it("keeps the page cursor on errors, replays explicit removals, and resolves direct links without scanning", async () => {
  const { manager, list } = fixture();
  list.mockResolvedValueOnce(paged([row(ordinary)], "20"));
  await manager.refreshList();
  list.mockResolvedValueOnce({
    ok: false,
    error: { code: "test/offline", message: "offline" },
  } as RemoteResult<SessionListValue>);
  // A failed project page names its project, so a retry reads on to that project again.
  const project = "project" as WorkspaceId;
  await manager.loadMore(project);
  expect(list).toHaveBeenLastCalledWith({
    includeArchived: false,
    cursor: "20",
    workspaceId: project,
  });
  expect(manager.getListSnapshot()).toMatchObject({
    state: "error",
    errorPage: "more",
    errorWorkspaceId: project,
    hasMore: true,
  });
  expect(ids(manager)).toEqual([ordinary]);
  const gate = Promise.withResolvers<RemoteResult<SessionListValue>>();
  list.mockReturnValueOnce(gate.promise);
  const page = manager.loadMore();
  manager.handleSessionRemoved(ordinary);
  gate.resolve(paged([row(ordinary), row(deleted)], null));
  await page;
  expect(ids(manager)).toEqual([deleted]);
  expect(manager.getListSnapshot().errorWorkspaceId).toBeNull();
  list.mockResolvedValueOnce(ok([row(archived)]));
  await manager.loadSummary(archived);
  expect(list).toHaveBeenLastCalledWith({ sessionId: archived });
  manager.resolveTarget(archived);
  await manager.dispose();
});

it("restores a retained Session when the Host adds the same identity again", async () => {
  const { manager } = fixture();
  manager.handleSessionAdded(row(ordinary));
  const resident = manager.get(ordinary);
  manager.handleSessionRemoved(ordinary);
  expect(resident.getSnapshot().removed).toBe(true);
  manager.handleSessionAdded(row(ordinary));
  expect(manager.get(ordinary)).toBe(resident);
  expect(resident.getSnapshot().removed).toBe(false);
  await manager.dispose();
});

it("does not infer archives from omission and replays real removals during a scoped refresh", async () => {
  const { manager, list } = fixture();
  list.mockResolvedValueOnce(ok([row(ordinary), row(archived)]));
  await manager.setIncludeArchived(true);
  list.mockResolvedValueOnce(ok([row(ordinary)]));
  await manager.setIncludeArchived(false);
  expect(ids(manager)).toEqual([ordinary]);
  manager.handleSessionAdded(row(archived));
  const gate = Promise.withResolvers<RemoteResult<SessionListValue>>();
  list.mockReturnValueOnce(gate.promise);
  const pull = manager.refreshList();
  manager.handleSessionRemoved(archived);
  gate.resolve(ok([row(ordinary)], [archived]));
  await pull;
  expect(ids(manager)).toEqual([ordinary]);
  await manager.dispose();
});

it("keeps each browser's choice through reconnect and ignores a previous generation's completion", async () => {
  const a = fixture();
  const b = fixture();
  await a.manager.setIncludeArchived(true);
  await b.manager.refreshList();
  const old = Promise.withResolvers<RemoteResult<SessionListValue>>();
  a.list.mockReturnValueOnce(old.promise);
  const oldPull = a.manager.refreshList();
  a.manager.handleConnected();
  b.manager.handleConnected();
  await Promise.all([a.manager.refreshList(), b.manager.refreshList()]);
  expect(a.list).toHaveBeenLastCalledWith({ includeArchived: true });
  expect(b.list).toHaveBeenLastCalledWith({ includeArchived: false });
  old.resolve(ok([row(deleted)]));
  await oldPull;
  expect(ids(a.manager)).toEqual([ordinary]);
  expect(ids(b.manager)).toEqual([ordinary]);
  await Promise.all([a.manager.dispose(), b.manager.dispose()]);
});

it("filters chat-only projections, drops no-op updates, and coalesces live stream updates per animation frame", async () => {
  const { manager } = fixture();
  await manager.refreshList();
  const notifications = vi.fn();
  const unsubscribe = manager.subscribe(notifications);

  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  // Chat-only projections update the store without notifying list subscribers.
  manager.handleControlFrame({
    type: "projection",
    sessionId: ordinary,
    key: "codexhostToolOutput",
    value: { lines: ["hello"] },
    seq: 1,
  });
  manager.handleControlFrame({
    type: "projection",
    sessionId: ordinary,
    key: "codexhostUsage",
    value: { total: 10 },
    seq: 1,
  });
  await flushMicrotasks();
  expect(notifications).not.toHaveBeenCalled();
  expect(manager.projectionValues(ordinary)?.codexhostToolOutput).toEqual({ lines: ["hello"] });

  // No-op upsert and status updates do not notify list subscribers.
  manager.handleSessionAdded(row(ordinary));
  manager.handleSessionStatus(ordinary, false);
  await flushMicrotasks();
  expect(notifications).not.toHaveBeenCalled();

  // Identical control projection values do not notify a second time.
  manager.handleControlFrame({
    type: "projection",
    sessionId: ordinary,
    key: "title",
    value: "Stable Title",
    seq: 2,
  });
  await flushMicrotasks();
  expect(notifications).toHaveBeenCalledTimes(1);
  manager.handleControlFrame({
    type: "projection",
    sessionId: ordinary,
    key: "title",
    value: "Stable Title",
    seq: 3,
  });
  await flushMicrotasks();
  expect(notifications).toHaveBeenCalledTimes(1);

  // When requestAnimationFrame exists, burst live stream updates coalesce into one flush.
  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof globalThis.requestAnimationFrame;
  try {
    notifications.mockClear();
    manager.handleSessionStatus(ordinary, true);
    manager.handleSessionActivity(ordinary, 999);
    manager.handleControlFrame({
      type: "projection",
      sessionId: ordinary,
      key: "title",
      value: "Next Title",
      seq: 4,
    });
    await flushMicrotasks();
    expect(notifications).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames[0]!(16);
    expect(notifications).toHaveBeenCalledTimes(1);
    const snapshot = manager.getListSnapshot();
    expect(snapshot.items[0]?.title).toBe("Next Title");
    expect(snapshot.items[0]?.running).toBe(true);
    expect(snapshot.items[0]?.updatedAt).toBe(999);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    unsubscribe();
    await manager.dispose();
  }
});

it("notifies on summaryOnly clearance, projection-only removal, subagent status flips, and fences stale null projection reads across same-value frames", async () => {
  const direct = SessionId("direct-only");
  const projectionOnly = SessionId("projection-only");
  const subagent = SessionId("subagent-only");
  const projectionsGate = Promise.withResolvers<RemoteResult<null>>();
  const list = vi.fn<(request: SessionListRequest) => Promise<RemoteResult<SessionListValue>>>(
    async (request) => (request.sessionId === direct ? ok([row(direct)]) : ok([row(ordinary)])),
  );
  const projections = vi.fn(async () => projectionsGate.promise);
  const manager = new SessionManager({
    session: { list, projections },
  } as unknown as SessionRemotes);

  await manager.refreshList();
  const notifications = vi.fn();
  const unsubscribe = manager.subscribe(notifications);
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  try {
    // 1. Direct loadSummary followed by identical catalog handleSessionAdded must clear summaryOnlyIds.
    await manager.loadSummary(direct);
    await flushMicrotasks();
    expect(manager.getListSnapshot().summaryOnlyIds).toContain(direct);
    notifications.mockClear();
    manager.handleSessionAdded(row(direct));
    await flushMicrotasks();
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(manager.getListSnapshot().summaryOnlyIds).not.toContain(direct);

    // 2. Removing a session that has only a control projection must invalidate projectionsBySession.
    manager.handleControlFrame({
      type: "projection",
      sessionId: projectionOnly,
      key: "title",
      value: "Ghost",
      seq: 1,
    });
    await flushMicrotasks();
    expect(manager.getListSnapshot().projectionsBySession[projectionOnly]?.values.title).toBe(
      "Ghost",
    );
    notifications.mockClear();
    manager.handleSessionRemoved(projectionOnly);
    await flushMicrotasks();
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(manager.getListSnapshot().projectionsBySession[projectionOnly]).toBeUndefined();
    // Repeated removal of an already-absent id remains a no-op.
    notifications.mockClear();
    manager.handleSessionRemoved(projectionOnly);
    await flushMicrotasks();
    expect(notifications).not.toHaveBeenCalled();

    // 3. A resident subagent absent from summaries still notifies list consumers when running flips.
    const residentChild = manager.get(subagent);
    expect(residentChild.getSnapshot().running).toBe(false);
    notifications.mockClear();
    manager.handleSessionStatus(subagent, true);
    await flushMicrotasks();
    expect(residentChild.getSnapshot().running).toBe(true);
    expect(notifications).toHaveBeenCalledTimes(1);
    notifications.mockClear();
    manager.handleSessionStatus(subagent, false);
    await flushMicrotasks();
    expect(residentChild.getSnapshot().running).toBe(false);
    expect(notifications).toHaveBeenCalledTimes(1);
    notifications.mockClear();
    manager.handleSessionStatus(subagent, false);
    await flushMicrotasks();
    expect(notifications).not.toHaveBeenCalled();

    // 4. Same-value live frame during in-flight refreshProjections prevents stale null from clearing the store.
    manager.handleControlFrame({
      type: "projection",
      sessionId: ordinary,
      key: "title",
      value: "Confirmed",
      seq: 1,
    });
    await flushMicrotasks();
    const refresh = manager.refreshProjections(ordinary);
    manager.handleControlFrame({
      type: "projection",
      sessionId: ordinary,
      key: "title",
      value: "Confirmed",
      seq: 2,
    });
    projectionsGate.resolve({ ok: true, value: null });
    await refresh;
    expect(manager.projectionValues(ordinary)?.title).toBe("Confirmed");
  } finally {
    unsubscribe();
    await manager.dispose();
  }
});
