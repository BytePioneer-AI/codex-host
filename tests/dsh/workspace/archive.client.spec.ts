import { expect, it, vi } from "vitest";
import { RemoteError, type RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceArchiveValue } from "@deepseek-ai/dsh-api-workspace-controller/types";
import {
  ClientWorkspaceModel,
  type WorkspaceRemote,
} from "@deepseek-ai/dsh-api-workspace-controller/src/client/model.ts";

const a = "a" as SessionId;
const b = "b" as SessionId;
const c = "c" as SessionId;
const success = (...ids: SessionId[]): RemoteResult<WorkspaceArchiveValue> => ({
  ok: true,
  value: { archivedSessionIds: ids },
});
function fixture() {
  const first = Promise.withResolvers<RemoteResult<WorkspaceArchiveValue>>();
  const second = Promise.withResolvers<RemoteResult<WorkspaceArchiveValue>>();
  const archiveSession = vi.fn((request: { sessionId: SessionId }) =>
    request.sessionId === a ? first.promise : second.promise,
  );
  const unarchiveSession = vi.fn(async () => success());
  const model = new ClientWorkspaceModel({
    archiveSession,
    unarchiveSession,
  } as unknown as WorkspaceRemote);
  model.replaceBaseline({ items: [], archivedSessionIds: [], pinnedSessionIds: [a, b] });
  return { model, first, second, archiveSession, unarchiveSession };
}

it("publishes archive and pin removal before the backend replies, sharing repeated clicks", async () => {
  const { model, first, archiveSession } = fixture();
  const listener = vi.fn();
  model.subscribe(listener);
  const pending = model.archiveSession(a);
  expect(model.archiveSession(a)).toBe(pending);
  expect(model.getSnapshot().archivedSessionIds).toEqual([a]);
  expect(model.getSnapshot().pinnedSessionIds).toEqual([b]);
  await Promise.resolve();
  expect(listener).toHaveBeenCalled();
  expect(archiveSession).toHaveBeenCalledExactlyOnceWith({ sessionId: a });
  first.resolve(success(a));
  await pending;
  expect(model.getSnapshot().archivedSessionIds).toEqual([a]);
  expect(model.getSnapshot().pinnedSessionIds).toEqual([b]);
});

it("rolls back only the failed archive against the newest Host state", async () => {
  const { model, first, second } = fixture();
  const pendingA = model.archiveSession(a);
  const pendingB = model.archiveSession(b);
  model.replaceArchived([c]);
  model.replacePinned([c, a, b]);
  first.resolve({ ok: false, error: new RemoteError("gateway/internal", "write refused", {}) });
  expect((await pendingA).ok).toBe(false);
  expect(model.getSnapshot().archivedSessionIds).toEqual([c, b]);
  expect(model.getSnapshot().pinnedSessionIds).toEqual([c, a]);
  second.resolve(success(c, b));
  await pendingB;
  expect(model.getSnapshot().archivedSessionIds).toEqual([c, b]);
});

it("restores a rejected archive and permits retry with stopActivity", async () => {
  const { model, first, archiveSession } = fixture();
  const pending = model.archiveSession(a);
  first.reject(new Error("transport assembly failed"));
  await expect(pending).rejects.toThrow("transport assembly failed");
  expect(model.getSnapshot().archivedSessionIds).toEqual([]);
  expect(model.getSnapshot().pinnedSessionIds).toEqual([a, b]);
  archiveSession.mockResolvedValueOnce(success(a));
  await model.archiveSession(a, { stopActivity: true });
  expect(archiveSession).toHaveBeenLastCalledWith({ sessionId: a, stopActivity: true });
});

it("restores an active Session while preserving the refusal for confirmation", async () => {
  const { model, first } = fixture();
  const pending = model.archiveSession(a);
  const error = new RemoteError("workspace/session-active", "Session is running", {
    sessionId: a,
    activity: [{ kind: "turn" }],
  });
  first.resolve({ ok: false, error });
  expect(await pending).toEqual({ ok: false, error });
  expect(model.getSnapshot().archivedSessionIds).toEqual([]);
  expect(model.getSnapshot().pinnedSessionIds).toEqual([a, b]);
});

it("keeps earlier successes when a later request returns a stale complete set", async () => {
  const { model, first, second } = fixture();
  const pendingA = model.archiveSession(a);
  const pendingB = model.archiveSession(b);
  first.resolve(success(a, b));
  await pendingA;
  second.resolve(success(b));
  await pendingB;
  expect(new Set(model.getSnapshot().archivedSessionIds)).toEqual(new Set([a, b]));
});

it("keeps both concurrent successes when replies arrive out of order", async () => {
  const { model, first, second } = fixture();
  const pendingA = model.archiveSession(a);
  const pendingB = model.archiveSession(b);
  second.resolve(success(b));
  await pendingB;
  expect(new Set(model.getSnapshot().archivedSessionIds)).toEqual(new Set([a, b]));
  first.resolve(success(a, b));
  await pendingA;
  expect(new Set(model.getSnapshot().archivedSessionIds)).toEqual(new Set([a, b]));
  expect(model.getSnapshot().pinnedSessionIds).toEqual([]);
});

it("does not restore a pending row when unrelated follow frames or baselines arrive", async () => {
  const { model, first } = fixture();
  const pending = model.archiveSession(a);
  model.replaceArchived([c]);
  expect(model.getSnapshot().archivedSessionIds).toEqual([c, a]);
  model.replaceBaseline({ items: [], archivedSessionIds: [c], pinnedSessionIds: [a, b] });
  expect(model.getSnapshot().archivedSessionIds).toEqual([c, a]);
  first.resolve(success(a));
  await pending;
  expect(model.getSnapshot().archivedSessionIds).toEqual([c, a]);
});

it("honors a pushed restoration after observing the archive despite a delayed unary reply", async () => {
  const { model, first } = fixture();
  const pending = model.archiveSession(a);
  model.replaceArchived([a]);
  model.replacePinned([b]);
  model.replaceArchived([]);
  model.replacePinned([a, b]);
  expect(model.getSnapshot().archivedSessionIds).toEqual([]);
  first.resolve(success(a));
  await pending;
  expect(model.getSnapshot().archivedSessionIds).toEqual([]);
  expect(model.getSnapshot().pinnedSessionIds).toEqual([a, b]);
});

it("does not undo a confirmed archive if its response is lost", async () => {
  const { model, first } = fixture();
  const pending = model.archiveSession(a);
  model.replaceArchived([a]);
  model.replacePinned([b]);
  first.resolve({ ok: false, error: new RemoteError("gateway/internal", "reply lost", {}) });
  await pending;
  expect(model.getSnapshot().archivedSessionIds).toEqual([a]);
  expect(model.getSnapshot().pinnedSessionIds).toEqual([b]);
});

it("lets a local unarchive supersede the pending archive", async () => {
  const { model, first } = fixture();
  const pending = model.archiveSession(a);
  await model.unarchiveSession(a);
  expect(model.getSnapshot().archivedSessionIds).toEqual([]);
  first.resolve(success(a));
  await pending;
  expect(model.getSnapshot().archivedSessionIds).toEqual([]);
});
