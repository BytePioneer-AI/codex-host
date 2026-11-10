// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { RemoteStream } from "@deepseek-ai/dsh-api-gateway/client";
import type {
  IWorkspaces,
  WorkspaceSnapshot,
} from "@deepseek-ai/dsh-api-workspace-controller/client";
import { ClientSessions } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/service.ts";
import type { SessionRemotes } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";
import type {
  SessionFollowFrame,
  SessionFollowRequest,
} from "../../../apps/web-ui/packages/api/session-controller/src/types.ts";
import { UiWorkspaceService } from "../../../apps/web-ui/packages/client/ui-workspace/src/client/navigation.ts";
import { LayoutController } from "../../../apps/web-ui/packages/client/ui-layout/src/client/service.ts";

const roots: Context[] = [];
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  localStorage.clear();
  vi.restoreAllMocks();
});
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const summary = (id: string, blank = false) => ({
  sessionId: SessionId(id),
  blank,
  running: false,
  agentAvailable: true,
  updatedAt: 1,
});
const success = (items: ReturnType<typeof summary>[]) => ({ ok: true as const, value: { items } });

function fixture(saved?: string) {
  if (saved) localStorage.setItem("dsh.sessions.current", JSON.stringify({ sessionId: saved }));
  const ctx = new Context();
  roots.push(ctx);
  const layout = new LayoutController(
    { selectPanel: vi.fn() } as never,
    () => true,
    createSnapshotStore({ activePanelId: null }),
  );
  const beginNavigation = vi.spyOn(layout, "beginNavigation");
  ctx.provide("layout", layout);
  ctx.provide("locale", { bind: () => (key: string) => key } as never);
  const generation = createSnapshotStore<{ id: number } | undefined>({ id: 1 });
  const requests: string[] = [];
  const head = Promise.withResolvers<ReturnType<typeof success>>();
  const reads = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<ReturnType<typeof success>>>
  >();
  const list = vi.fn(({ sessionId }: { sessionId?: string }) => {
    if (sessionId === undefined) return head.promise;
    let read = reads.get(sessionId);
    if (!read) {
      read = Promise.withResolvers<ReturnType<typeof success>>();
      reads.set(sessionId, read);
    }
    return read.promise;
  });
  const create = vi.fn(async () => success([]));
  const remote = {
    $stream: (options: ConstructorParameters<typeof RemoteStream>[1]) =>
      new RemoteStream({ generation } as never, options),
    session: {
      list,
      create,
      async *follow(request: SessionFollowRequest, signal: AbortSignal) {
        if (request.address.kind !== "session") throw new Error("unexpected child");
        const id = request.address.sessionId;
        requests.push(id);
        const stopped = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => stopped.resolve(), { once: true });
        yield {
          type: "snapshot",
          epoch: `epoch-${id}`,
          header: { version: 4, id, createdAt: 1, isSeeded: false },
          cursor: 0,
          records: [
            {
              type: "event",
              event: {
                type: "test/content",
                seq: 0,
                time: 1,
                data: { text: `recent-${id}` },
                ignorable: true,
              },
            },
          ],
          hasMore: false,
          projections: { asOfSeq: 0, values: {} },
          assistantStream: { revision: 0 },
        } as unknown as SessionFollowFrame;
        if (!signal.aborted) await stopped.promise;
      },
    },
  } as unknown as SessionRemotes;
  const sessions = new ClientSessions(ctx, remote);
  const workspace = createSnapshotStore<WorkspaceSnapshot>({
    phase: "pending",
    state: "idle",
    error: null,
    items: [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    canStartProjectless: true,
  });
  const notify = vi.fn();
  new UiWorkspaceService(
    ctx,
    {} as never,
    { list: workspace } as unknown as IWorkspaces,
    sessions,
    {} as never,
    notify,
  );
  // Production consumers access the Cordis-traced service, not the constructor instance.
  const ui = ctx.uiWorkspace;
  const read = (id: string) => reads.get(id)!;
  return {
    ctx,
    ui,
    sessions,
    workspace,
    requests,
    head,
    list,
    create,
    read,
    beginNavigation,
    notify,
  };
}

it("restores a saved ID and recent history while the head list and projects are still pending", async () => {
  const f = fixture("saved");
  void f.sessions.refresh();
  expect(f.list).toHaveBeenCalledWith({ sessionId: "saved" });
  expect(f.ui.opening.getSnapshot()).toMatchObject({ state: "loading", sessionId: "saved" });
  f.read("saved").resolve(success([summary("saved")]));
  await flush();
  expect(f.requests).toEqual(["saved"]);
  expect(f.sessions.binding(SessionId("saved"))?.session.getSnapshot().openState).toBe("open");
  expect(f.sessions.retainInfo(SessionId("saved")).getSnapshot().retainedBy.mainView).toBe(1);
  expect(f.sessions.list.getSnapshot().phase).toBe("pending");
  expect(f.workspace.getSnapshot().phase).toBe("pending");
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
  expect(f.create).not.toHaveBeenCalled();
});

it("opens a direct ID without a catalog, and a late startup ID cannot replace it", async () => {
  const f = fixture("saved");
  f.ui.openSession(SessionId("linked"));
  expect(f.list).toHaveBeenCalledWith({ sessionId: "linked" });
  f.read("linked").resolve(success([summary("linked")]));
  await flush();
  f.read("saved").resolve(success([summary("saved")]));
  await flush();
  expect(f.requests).toEqual(["linked"]);
  expect(f.sessions.retainInfo(SessionId("linked")).getSnapshot().retainedBy.mainView).toBe(1);
  expect(
    f.sessions.retainInfo(SessionId("saved")).getSnapshot().retainedBy.mainView,
  ).toBeUndefined();
});

it("a later known selection wins over a delayed direct link", async () => {
  const f = fixture();
  f.ui.openSession(SessionId("slow"));
  f.sessions.handleSessionAdded(summary("chosen"));
  f.ui.openSession(SessionId("chosen"));
  f.read("slow").resolve(success([summary("slow")]));
  await flush();
  expect(f.requests).toEqual(["chosen"]);
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
});

it("reports ID lookup failure locally, retries only that ID, and ignores stale failure", async () => {
  const f = fixture();
  f.ui.openSession(SessionId("failed"));
  f.read("failed").reject(new Error("lookup offline"));
  await flush();
  expect(f.ui.opening.getSnapshot()).toEqual({
    state: "error",
    sessionId: "failed",
    message: "lookup offline",
  });
  // The transport's next attempt gets a fresh response, not a cached failure.
  f.list.mockImplementationOnce(async () => success([summary("failed")]));
  f.ui.retryOpening();
  await flush();
  expect(f.requests).toEqual(["failed"]);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
  f.ui.openSession(SessionId("stale"));
  f.ui.openSession(SessionId("failed"));
  f.read("stale").reject(new Error("late error"));
  await flush();
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
});

it("keeps a failed saved ID retryable instead of replacing it with an empty home", async () => {
  const added = vi.spyOn(AbortSignal.prototype, "addEventListener");
  const f = fixture("saved");
  const [, listener] = added.mock.calls.at(-1)!;
  const signal = added.mock.contexts.at(-1)!;
  const removed = vi.spyOn(signal, "removeEventListener");
  f.read("saved").reject(new Error("saved lookup failed"));
  await flush();
  void f.sessions.refresh();
  f.head.resolve(success([]));
  f.workspace.update((s) => {
    s.phase = "ready";
  });
  await flush();
  expect(f.ui.opening.getSnapshot().state).toBe("error");
  expect(f.create).not.toHaveBeenCalled();
  // A failed lookup keeps one listener so a new navigation can dismiss its error.
  expect(removed).not.toHaveBeenCalled();
  f.list.mockImplementationOnce(async () => success([summary("saved")]));
  f.ui.retryOpening();
  expect(removed).toHaveBeenCalledWith("abort", listener);
  const [, retryListener] = added.mock.calls.at(-1)!;
  expect(added.mock.contexts.at(-1)).toBe(signal);
  await flush();
  expect(removed).toHaveBeenCalledWith("abort", retryListener);
  expect(f.requests).toEqual(["saved"]);
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
});

it("does not confuse an unresolved direct link with an empty home when lists finish first", async () => {
  const f = fixture();
  f.ui.openSession(SessionId("missing"));
  void f.sessions.refresh();
  f.head.resolve(success([]));
  f.workspace.update((s) => {
    s.phase = "ready";
  });
  await flush();
  expect(f.create).not.toHaveBeenCalled();
  expect(f.ui.opening.getSnapshot().state).toBe("loading");
  f.read("missing").resolve(success([]));
  await flush();
  expect(f.ui.opening.getSnapshot()).toMatchObject({ state: "error", sessionId: "missing" });
});

it.each([undefined, { prompt: "new draft" }])(
  "explicit New Session supersedes a pending ID even when its required project is not ready (%j)",
  async (options) => {
    const f = fixture();
    f.workspace.update((s) => {
      s.canStartProjectless = false;
    });
    f.ui.openSession(SessionId("old"));
    const navigations = f.beginNavigation.mock.calls.length;
    expect(f.ui.opening.getSnapshot().state).toBe("loading");
    f.ui.startSession(undefined, options);
    expect(f.ui.opening.getSnapshot().state).toBe("idle");
    expect(f.beginNavigation).toHaveBeenCalledTimes(navigations + 1);
    if (options)
      expect(f.notify).toHaveBeenCalledWith({
        kind: "createFailed",
        message: "draft.workspaceRequired",
      });
    f.read("old").resolve(success([summary("old")]));
    await flush();
    expect(f.requests).toEqual([]);
    expect(
      f.sessions.retainInfo(SessionId("old")).getSnapshot().retainedBy.mainView,
    ).toBeUndefined();
    expect(localStorage.getItem("dsh.sessions.current") ?? "").not.toContain("old");
    expect(f.create).not.toHaveBeenCalled();
    f.ui.retryOpening();
    expect(f.list).toHaveBeenCalledTimes(1);
  },
);

it("cancels a lookup and removes its abort listener before a late failure", async () => {
  const f = fixture();
  f.workspace.update((s) => {
    s.canStartProjectless = false;
  });
  const added = vi.spyOn(AbortSignal.prototype, "addEventListener");
  f.ui.openSession(SessionId("cancelled"));
  // No history has opened: the last explicit listener belongs to ID resolution.
  const [type, listener] = added.mock.calls.at(-1)!;
  const signal = added.mock.contexts.at(-1)!;
  const removed = vi.spyOn(signal, "removeEventListener");
  expect(type).toBe("abort");
  f.ui.startSession();
  expect(removed).toHaveBeenCalledWith("abort", listener);
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
  f.read("cancelled").reject(new Error("late lookup failure"));
  await flush();
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
  f.ui.retryOpening();
  expect(f.list).toHaveBeenCalledTimes(1);
});

it("keeps an opening failure dismissible when retaining the resolved ID throws", async () => {
  const f = fixture();
  f.workspace.update((s) => {
    s.canStartProjectless = false;
  });
  f.ui.openSession(SessionId("unavailable"));
  vi.spyOn(f.sessions, "retain").mockImplementationOnce(() => {
    throw new Error("retain failed");
  });
  f.read("unavailable").resolve(success([summary("unavailable")]));
  await flush();
  expect(f.ui.opening.getSnapshot()).toMatchObject({ state: "error", message: "retain failed" });
  // This explicit navigation fails its own prerequisite, but must dismiss the old error/retry.
  await expect(f.ui.openWorkspace(null)).rejects.toThrow("This Host requires a Workspace.");
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
  const reads = f.list.mock.calls.length;
  f.ui.retryOpening();
  expect(f.list).toHaveBeenCalledTimes(reads);
});

it("cleans a pending lookup on disposal and ignores its late rejection", async () => {
  const f = fixture();
  const added = vi.spyOn(AbortSignal.prototype, "addEventListener");
  f.ui.openSession(SessionId("disposed"));
  const [, listener] = added.mock.calls.at(-1)!;
  const signal = added.mock.contexts.at(-1)!;
  const removed = vi.spyOn(signal, "removeEventListener");
  await f.ctx.fiber.dispose();
  expect(removed).toHaveBeenCalledWith("abort", listener);
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
  f.read("disposed").reject(new Error("late disposal failure"));
  await flush();
  expect(f.ui.opening.getSnapshot().state).toBe("idle");
  f.ui.retryOpening();
  expect(f.list).toHaveBeenCalledTimes(1);
});

it("unrelated archived metadata does not cancel saved-ID startup", async () => {
  const f = fixture("saved");
  const navigations = f.beginNavigation.mock.calls.length;
  f.workspace.update((s) => {
    s.archivedSessionIds = [SessionId("archived")];
  });
  f.read("saved").resolve(success([summary("saved")]));
  await flush();
  expect(f.beginNavigation).toHaveBeenCalledTimes(navigations);
  expect(f.sessions.retainInfo(SessionId("saved")).getSnapshot().retainedBy.mainView).toBe(1);
  expect(f.requests).toEqual(["saved"]);
});

it("keeps saved blank drafts behind their original Workspace/writer prerequisites", async () => {
  const f = fixture("blank");
  f.read("blank").resolve(success([summary("blank", true)]));
  await flush();
  expect(f.requests).toEqual([]);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.sessions.binding(SessionId("blank"))).toBeUndefined();
});
