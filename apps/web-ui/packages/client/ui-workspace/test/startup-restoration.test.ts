import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
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

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  return data;
}

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

function remoteError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: "RemoteError",
    isDSHRemoteError: true as const,
    code,
    details: {},
  });
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createHarness(options: {
  savedSessionId?: SessionId;
  loadSummary: (
    sessionId: SessionId,
    listStore: ReturnType<typeof createSnapshotStore<SessionListState>>,
  ) => Promise<void>;
  createdIds?: SessionId[];
}) {
  const storage = installLocalStorage(
    options.savedSessionId === undefined
      ? {}
      : { "dsh.sessions.current": JSON.stringify({ sessionId: options.savedSessionId }) },
  );
  const ws1 = "ws-1" as WorkspaceId;
  const listStore = createSnapshotStore<SessionListState>({
    ids: [],
    byId: {},
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
  const retainedMain: SessionId[] = [];
  const createdIds = [...(options.createdIds ?? [])];
  const createdCalls: Array<unknown> = [];
  const loadSummaryCalls: SessionId[] = [];
  const bindings = new Map<SessionId, SessionBinding>();

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
    existing = { sessionId: id, session: sessionSnapshot } as unknown as SessionBinding;
    bindings.set(id, existing);
    return existing;
  };

  const sessions: Partial<ISessions> = {
    list: listStore,
    loadSummary: async (sessionId: SessionId) => {
      loadSummaryCalls.push(sessionId);
      await options.loadSummary(sessionId, listStore);
    },
    create: async (opts) => {
      createdCalls.push(opts);
      const id = createdIds.shift();
      if (id === undefined) throw new Error("unexpected create");
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
    retain: (target, opts) => {
      const id = typeof target === "string" ? target : target.childSessionId;
      if (opts?.source === "mainView") retainedMain.push(id);
      return {
        sessionId: id,
        binding: ensureBinding(id),
        release: () => {},
      } as unknown as SessionReference;
    },
    binding: (id) => ensureBinding(id),
    subagentAddress: () => undefined,
  };

  const ctx = new Context();
  ctx.provide("remote" as never, { $on: () => () => {} } as never);
  ctx.provide(
    "layout" as never,
    {
      beginNavigation: () => {
        navController.abort();
        navController = new AbortController();
        return navController.signal;
      },
      selectPanel: () => {
        navController.abort();
      },
    } as never,
  );
  ctx.provide("locale" as never, { bind: () => (key: string) => key } as never);

  const workspaces: Partial<IWorkspaces> = { list: workspacesStore };

  const service = new UiWorkspaceService(
    ctx,
    {} as never,
    workspaces as IWorkspaces,
    sessions as ISessions,
    { pinSessionOrder: () => {} },
    () => {},
  );

  return {
    service,
    storage,
    listStore,
    workspacesStore,
    retainedMain,
    createdCalls,
    loadSummaryCalls,
  };
}

it("clears an expired saved draft on startup and falls back to normal initial restoration", async () => {
  const expiredDraft = SessionId("draft-1b699a94-b559-44b6-8c4a-4b1604d01d4b");
  const freshDraft = SessionId("draft-fresh-1");
  const h = createHarness({
    savedSessionId: expiredDraft,
    createdIds: [freshDraft],
    loadSummary: async () => {
      throw remoteError("session/not-found", "Draft Session is no longer available.");
    },
  });

  await flushMicrotasks();

  assert.deepEqual(h.loadSummaryCalls, [expiredDraft]);
  assert.deepEqual(h.service.opening.getSnapshot(), { state: "idle" });
  assert.deepEqual(h.retainedMain, [freshDraft]);
  assert.equal(h.storage.get("dsh.sessions.current"), JSON.stringify({ sessionId: freshDraft }));
});

it("still restores a live persisted draft across page reload without creating a duplicate", async () => {
  const liveDraft = SessionId("draft-live-1");
  const h = createHarness({
    savedSessionId: liveDraft,
    loadSummary: async (id, listStore) => {
      listStore.update((draft) => {
        draft.ids.push(id);
        draft.byId[id] = {
          id,
          displayTitle: "New chat",
          running: false,
          blank: true,
          updatedAt: Date.now(),
          retainedBy: {},
        };
      });
    },
  });

  await flushMicrotasks();

  assert.deepEqual(h.service.opening.getSnapshot(), { state: "idle" });
  assert.deepEqual(h.retainedMain, [liveDraft]);
  assert.equal(h.createdCalls.length, 0);
});

it("keeps saved selection and retryable error state on transient startup failures", async () => {
  const realSession = SessionId("real-session-1");
  let online = false;
  const h = createHarness({
    savedSessionId: realSession,
    loadSummary: async (id, listStore) => {
      if (!online) throw remoteError("host/offline", "The Host is disconnected.");
      listStore.update((draft) => {
        draft.ids.push(id);
        draft.byId[id] = {
          id,
          displayTitle: "Real",
          running: false,
          blank: false,
          updatedAt: Date.now(),
          retainedBy: {},
        };
      });
    },
  });

  await flushMicrotasks();

  assert.deepEqual(h.service.opening.getSnapshot(), {
    state: "error",
    sessionId: realSession,
    message: "The Host is disconnected.",
  });
  assert.deepEqual(h.retainedMain, []);
  assert.equal(h.storage.get("dsh.sessions.current"), JSON.stringify({ sessionId: realSession }));

  online = true;
  h.service.retryOpening();
  await flushMicrotasks();

  assert.deepEqual(h.service.opening.getSnapshot(), { state: "idle" });
  assert.deepEqual(h.retainedMain, [realSession]);
});

it("still surfaces session/not-found for explicit openSession calls", async () => {
  const missing = SessionId("draft-explicit-missing");
  const initialBlank = SessionId("draft-initial");
  const h = createHarness({
    createdIds: [initialBlank],
    loadSummary: async () => {
      throw remoteError("session/not-found", "Draft Session is no longer available.");
    },
  });

  await flushMicrotasks();
  h.service.openSession(missing);
  await flushMicrotasks();

  assert.deepEqual(h.service.opening.getSnapshot(), {
    state: "error",
    sessionId: missing,
    message: "Draft Session is no longer available.",
  });
});
