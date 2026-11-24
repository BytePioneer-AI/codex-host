import assert from "node:assert/strict";
import { it } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionReference,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type {
  IWorkspaces,
  WorkspaceSnapshot,
} from "@deepseek-ai/dsh-api-workspace-controller/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace/types";
import { UiWorkspaceService } from "../src/client/navigation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const sessionA = SessionId("session-a");
  const sessionB = SessionId("session-b");
  const ws1 = "ws-1" as WorkspaceId;
  const listStore = createSnapshotStore<SessionListState>({
    ids: [sessionA, sessionB],
    byId: {
      [sessionA]: {
        id: sessionA,
        displayTitle: "A",
        running: false,
        blank: false,
        updatedAt: 1,
        retainedBy: {},
      },
      [sessionB]: {
        id: sessionB,
        displayTitle: "B",
        running: false,
        blank: false,
        updatedAt: 2,
        retainedBy: {},
      },
    },
    phase: "ready",
    projectionsBySession: {},
  });
  const workspacesStore = createSnapshotStore<WorkspaceSnapshot>({
    items: [
      {
        workspaceId: ws1,
        path: "/tmp/ws-1",
        title: "WS 1",
        sessionIds: [],
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ],
    phase: "ready",
    canStartProjectless: true,
    pinnedSessionIds: [],
    archivedSessionIds: [],
  });

  let navController = new AbortController();
  const panelSelections: Array<string | null> = [];
  const retainedMain: SessionId[] = [];
  const releasedMain: SessionId[] = [];
  const adopted: Array<{ sessionId: SessionId; options?: unknown }> = [];
  const toasts: unknown[] = [];
  const createQueue: Array<ReturnType<typeof deferred<SessionId>>> = [];

  const bindings = new Map<SessionId, SessionBinding>();
  const sessionStores = new Map<
    SessionId,
    ReturnType<
      typeof createSnapshotStore<{
        sessionId: SessionId;
        openState: string;
        running: boolean;
        blank: boolean;
        removed: boolean;
        subagent: null;
        promptError: null;
      }>
    >
  >();
  const removedListeners = new Set<(id: SessionId) => void>();
  const ensureBinding = (id: SessionId): SessionBinding => {
    let existing = bindings.get(id);
    if (existing !== undefined) return existing;
    const sessionSnapshot = createSnapshotStore({
      sessionId: id,
      openState: "open",
      running: false,
      blank: listStore.getSnapshot().byId[id]?.blank ?? false,
      removed: false,
      subagent: null,
      promptError: null,
    });
    sessionStores.set(id, sessionSnapshot);
    existing = { sessionId: id, session: sessionSnapshot } as unknown as SessionBinding;
    bindings.set(id, existing);
    return existing;
  };

  const sessions: Partial<ISessions> = {
    list: listStore,
    create: async () => {
      const next = createQueue.shift();
      if (next === undefined) throw new Error("unexpected create");
      const id = await next.promise;
      listStore.update((draft) => {
        if (!draft.ids.includes(id)) draft.ids.push(id);
        draft.byId[id] = {
          id,
          displayTitle: id,
          running: false,
          blank: true,
          updatedAt: Date.now(),
          retainedBy: {},
        };
      });
      return id;
    },
    retain: (target, options) => {
      const id = typeof target === "string" ? target : target.childSessionId;
      const isMain = options?.source === "mainView";
      if (isMain) retainedMain.push(id);
      return {
        sessionId: id,
        binding: ensureBinding(id),
        release: () => {
          if (isMain) releasedMain.push(id);
        },
      } as unknown as SessionReference;
    },
    binding: (id) => ensureBinding(id),
    subagentAddress: () => undefined,
  };

  const workspaces: Partial<IWorkspaces> = {
    list: workspacesStore,
  };

  const conversation = {
    input: {
      adoptPendingDraft: (binding: SessionBinding, options?: unknown) => {
        adopted.push({
          sessionId: binding.sessionId,
          ...(options === undefined ? {} : { options }),
        });
        return "applied" as const;
      },
    },
  };

  const ctx = new Context();
  ctx.provide(
    "remote" as never,
    {
      $on: (event: string, listener: (id: SessionId) => void) => {
        if (event === "api-session/removed") removedListeners.add(listener);
        return () => {
          removedListeners.delete(listener);
        };
      },
    } as never,
  );
  ctx.provide("conversation" as never, conversation as never);
  ctx.provide(
    "layout" as never,
    {
      beginNavigation: () => {
        navController.abort();
        navController = new AbortController();
        return navController.signal;
      },
      selectPanel: (panel: string | null) => {
        navController.abort();
        panelSelections.push(panel);
      },
    } as never,
  );
  ctx.provide(
    "locale" as never,
    {
      bind: () => (key: string) => key,
    } as never,
  );

  const service = new UiWorkspaceService(
    ctx,
    {} as never,
    workspaces as IWorkspaces,
    sessions as ISessions,
    { pinSessionOrder: () => {} },
    (toast) => {
      toasts.push(toast);
    },
  );

  return {
    ctx,
    service,
    listStore,
    workspacesStore,
    sessionA,
    sessionB,
    ws1,
    createQueue,
    panelSelections,
    retainedMain,
    releasedMain,
    adopted,
    toasts,
    emitRemoved: (id: SessionId) => {
      for (const listener of removedListeners) listener(id);
    },
    markSessionRemoved: (id: SessionId) => {
      sessionStores.get(id)?.update((draft) => {
        draft.removed = true;
      });
    },
  };
}

it("switches immediately to creating state, hands off pending draft on success, and supports retry on failure", async () => {
  const h = createHarness();
  h.service.openSession(h.sessionA);
  assert.deepEqual(h.retainedMain, [h.sessionA]);

  // First attempt fails with host/no-harness.
  const first = deferred<SessionId>();
  h.createQueue.push(first);
  h.service.startSession();

  assert.equal(h.releasedMain.includes(h.sessionA), true);
  const creatingState = h.service.creating.getSnapshot();
  assert.equal(creatingState.state, "creating");
  assert.equal(creatingState.workspaceId, null);
  const token = creatingState.token;

  const noHarnessError = Object.assign(new Error("no harness"), {
    name: "SessionCreateError",
    rpcError: { code: "host/no-harness", message: "no ready harness" },
  });
  first.reject(noHarnessError);
  await new Promise((r) => setTimeout(r, 0));

  const errorState = h.service.creating.getSnapshot();
  assert.equal(errorState.state, "error");
  assert.equal(errorState.reason, "no-harness");
  assert.equal(errorState.message, undefined);
  assert.equal(errorState.token, token);
  assert.equal(h.toasts.length, 0);

  // Retry keeps the same token without flashing `idle` (which would clear the pending draft).
  const statesDuringRetry: string[] = [];
  const stopWatching = h.service.creating.subscribe(() => {
    statesDuringRetry.push(h.service.creating.getSnapshot().state);
  });
  const second = deferred<SessionId>();
  h.createQueue.push(second);
  h.service.retryCreating();
  stopWatching();
  assert.deepEqual(statesDuringRetry, ["creating"]);
  const retryingState = h.service.creating.getSnapshot();
  assert.equal(retryingState.state, "creating");
  assert.equal(retryingState.token, token);

  const created = SessionId("new-1");
  second.resolve(created);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(h.service.creating.getSnapshot().state, "idle");
  assert.equal(h.retainedMain.at(-1), created);
  assert.deepEqual(h.adopted, [{ sessionId: created }]);
});

it("cancels in-flight creation when navigating to another session or starting again", async () => {
  const h = createHarness();
  const req1 = deferred<SessionId>();
  h.createQueue.push(req1);
  h.service.startSession();
  assert.equal(h.service.creating.getSnapshot().state, "creating");

  // User clicks an existing session before req1 resolves.
  h.service.openSession(h.sessionB);
  assert.equal(h.service.creating.getSnapshot().state, "idle");
  assert.equal(h.retainedMain.at(-1), h.sessionB);

  // Late response from req1 must not hijack the page.
  req1.resolve(SessionId("stale-new"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.retainedMain.at(-1), h.sessionB);
  assert.equal(h.service.creating.getSnapshot().state, "idle");

  // Starting twice without a project cancels the first create and honors only the second.
  const req2 = deferred<SessionId>();
  const req3 = deferred<SessionId>();
  h.createQueue.push(req2, req3);
  h.service.startSession(undefined, { prompt: "first prompt" });
  const firstState = h.service.creating.getSnapshot();
  assert.equal(firstState.state, "creating");
  assert.equal(firstState.workspaceId, null);
  assert.equal(firstState.initialPrompt, "first prompt");

  h.service.startSession(undefined, { prompt: "second prompt" });
  req2.resolve(SessionId("stale-projectless"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.service.creating.getSnapshot().state, "creating");

  const finalId = SessionId("final-projectless");
  req3.resolve(finalId);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.service.creating.getSnapshot().state, "idle");
  assert.equal(h.retainedMain.at(-1), finalId);
  assert.deepEqual(h.adopted, [{ sessionId: finalId, options: { prompt: "second prompt" } }]);

  // Project-scoped startSession shares connectWorkspace inflight and surfaces workspaceId immediately.
  const reqWs = deferred<SessionId>();
  h.createQueue.push(reqWs);
  h.service.startSession(h.ws1, { prompt: "ws prompt" });
  const wsState = h.service.creating.getSnapshot();
  assert.equal(wsState.state, "creating");
  assert.equal(wsState.workspaceId, h.ws1);
  const wsSession = SessionId("ws-session-1");
  reqWs.resolve(wsSession);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.service.creating.getSnapshot().state, "idle");
  assert.equal(h.retainedMain.at(-1), wsSession);
  assert.deepEqual(h.adopted.at(-1), { sessionId: wsSession, options: { prompt: "ws prompt" } });
});

it("preserves failure detail for unknown creation errors without code prefixes", async () => {
  const h = createHarness();

  // Host refusal: keep rpcError.message without the wire code prefix.
  const hostRefusal = deferred<SessionId>();
  h.createQueue.push(hostRefusal);
  h.service.startSession();
  hostRefusal.reject(
    Object.assign(new Error("session/limit: Too many open sessions"), {
      name: "SessionCreateError",
      rpcError: { code: "session/limit", message: "Too many open sessions" },
    }),
  );
  await new Promise((r) => setTimeout(r, 0));
  const refusedState = h.service.creating.getSnapshot();
  assert.equal(refusedState.state, "error");
  assert.equal(refusedState.reason, "unknown");
  assert.equal(refusedState.message, "Too many open sessions");

  // Generic Error: keep error.message.
  const genericErr = deferred<SessionId>();
  h.createQueue.push(genericErr);
  h.service.retryCreating();
  genericErr.reject(new Error("Network connection lost"));
  await new Promise((r) => setTimeout(r, 0));
  const genericState = h.service.creating.getSnapshot();
  assert.equal(genericState.state, "error");
  assert.equal(genericState.reason, "unknown");
  assert.equal(genericState.message, "Network connection lost");

  // Blank message: leave message undefined so UI falls back to generic copy.
  const blankErr = deferred<SessionId>();
  h.createQueue.push(blankErr);
  h.service.retryCreating();
  blankErr.reject(new Error("   "));
  await new Promise((r) => setTimeout(r, 0));
  const blankState = h.service.creating.getSnapshot();
  assert.equal(blankState.state, "error");
  assert.equal(blankState.reason, "unknown");
  assert.equal(blankState.message, undefined);
});

it("clears main view when an open remote session is explicitly removed, without closing unpaged or local sessions", () => {
  const h = createHarness();
  const remoteSession1 = SessionId("remote-s1");
  const remoteSession2 = SessionId("remote-s2");
  const remoteWs = "remote-peer:vps::/srv/app" as WorkspaceId;

  const prevWorkspaces = h.workspacesStore.getSnapshot();
  h.workspacesStore.set({
    ...prevWorkspaces,
    items: [
      ...prevWorkspaces.items,
      {
        workspaceId: remoteWs,
        path: "/srv/app",
        title: "app",
        sessionIds: [remoteSession1, remoteSession2],
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        remote: { hostId: "remote-peer:vps", displayName: "VPS", state: "connected" },
      },
    ],
  });
  h.listStore.update((draft) => {
    draft.ids = [...draft.ids, remoteSession1, remoteSession2];
    draft.byId[remoteSession1] = {
      id: remoteSession1,
      displayTitle: "Remote 1",
      running: false,
      blank: false,
      updatedAt: 3,
      retainedBy: {},
      projectionValues: {
        remoteHost: { hostId: "remote-peer:vps", displayName: "VPS", state: "connected" },
      },
    };
    draft.byId[remoteSession2] = {
      id: remoteSession2,
      displayTitle: "Remote 2",
      running: false,
      blank: false,
      updatedAt: 4,
      retainedBy: {},
      projectionValues: {
        remoteHost: { hostId: "remote-peer:vps", displayName: "VPS", state: "connected" },
      },
    };
  });

  // 1. Open remoteSession1; omitting it from paginated list ids alone must NOT close it.
  h.service.openSession(remoteSession1);
  assert.equal(h.retainedMain.at(-1), remoteSession1);
  h.listStore.update((draft) => {
    draft.ids = draft.ids.filter((id) => id !== remoteSession1);
    delete draft.byId[remoteSession1];
  });
  assert.equal(h.releasedMain.includes(remoteSession1), false);

  // 2. Explicit api-session/removed closes the open remote session and clears main view.
  const panelCountBefore = h.panelSelections.length;
  h.emitRemoved(remoteSession1);
  assert.equal(h.releasedMain.includes(remoteSession1), true);
  assert.equal(h.panelSelections.length, panelCountBefore + 1);
  assert.equal(h.panelSelections.at(-1), null);

  // 3. Resident Session snapshot `removed: true` also clears main view for remote sessions.
  h.service.openSession(remoteSession2);
  h.markSessionRemoved(remoteSession2);
  assert.equal(h.releasedMain.includes(remoteSession2), true);

  // 4. Local sessions are not auto-closed by api-session/removed.
  h.service.openSession(h.sessionA);
  h.emitRemoved(h.sessionA);
  assert.equal(h.releasedMain.includes(h.sessionA), false);
});
