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
  WorkspaceView,
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
  canStartProjectless?: boolean;
  workspaceItems?: WorkspaceSnapshot["items"];
  initialSessions?: SessionListState["byId"];
  initializeDefault?: (
    workspacesStore: ReturnType<typeof createSnapshotStore<WorkspaceSnapshot>>,
  ) => Promise<WorkspaceView>;
}) {
  const storage = installLocalStorage(
    options.savedSessionId === undefined
      ? {}
      : { "dsh.sessions.current": JSON.stringify({ sessionId: options.savedSessionId }) },
  );
  const ws1 = "ws-1" as WorkspaceId;
  const initialById = options.initialSessions ?? {};
  const listStore = createSnapshotStore<SessionListState>({
    ids: Object.keys(initialById) as SessionId[],
    byId: initialById,
    phase: "ready",
    projectionsBySession: {},
  });
  const workspacesStore = createSnapshotStore<WorkspaceSnapshot>({
    items: options.workspaceItems ?? [
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
    canStartProjectless: options.canStartProjectless ?? true,
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

  let initializeDefaultCalls = 0;
  const workspaces: Partial<IWorkspaces> = {
    list: workspacesStore,
    initializeDefault: async () => {
      initializeDefaultCalls += 1;
      if (options.initializeDefault !== undefined) {
        return options.initializeDefault(workspacesStore);
      }
      throw new Error("unexpected initializeDefault");
    },
  };

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
    get initializeDefaultCalls() {
      return initializeDefaultCalls;
    },
  };
}

const recoveryCases = [
  ["session/not-found", "draft-expired", "Draft Session is no longer available."],
  ["remote/not-found", "web-remote:missing", "Remote Thread not found"],
  ["remote/identity-invalid", "web-remote:invalid", "Invalid remote Thread identity"],
  ["remote/offline", "web-remote:offline", "Remote peer is not connected"],
] as const;

for (const [code, sessionId, message] of recoveryCases) {
  it(`falls back to a local draft when startup receives ${code}`, async () => {
    const savedSession = SessionId(sessionId);
    const freshDraft = SessionId("draft-fresh-1");
    const h = createHarness({
      savedSessionId: savedSession,
      createdIds: [freshDraft],
      loadSummary: async () => {
        throw remoteError(code, message);
      },
    });

    await flushMicrotasks();

    assert.deepEqual(h.loadSummaryCalls, [savedSession]);
    assert.deepEqual(h.service.opening.getSnapshot(), { state: "idle" });
    assert.deepEqual(h.retainedMain, [freshDraft]);
    assert.equal(
      h.storage.get("dsh.sessions.current"),
      JSON.stringify({ sessionId: code === "remote/offline" ? savedSession : freshDraft }),
    );
  });
}

it("replaces the saved offline selection when the temporary draft binds or the user navigates", async () => {
  const offline = SessionId("web-remote:offline");
  const draft = SessionId("draft-temporary");
  const canonical = SessionId("canonical-thread");
  const other = SessionId("another-thread");
  const h = createHarness({
    savedSessionId: offline,
    createdIds: [draft],
    loadSummary: async (id, listStore) => {
      if (id === offline) throw remoteError("remote/offline", "Remote peer is not connected");
      listStore.update((state) => {
        state.ids.push(id);
        state.byId[id] = {
          id,
          displayTitle: id,
          running: false,
          blank: false,
          updatedAt: 1,
          retainedBy: {},
        };
      });
    },
  });

  await flushMicrotasks();
  assert.deepEqual(h.retainedMain, [draft]);
  assert.equal(h.storage.get("dsh.sessions.current"), JSON.stringify({ sessionId: offline }));

  // The session-bound notification opens the canonical Thread through this entry point.
  h.service.openSession(canonical);
  await flushMicrotasks();
  assert.equal(h.storage.get("dsh.sessions.current"), JSON.stringify({ sessionId: canonical }));

  h.service.openSession(other);
  await flushMicrotasks();
  assert.equal(h.storage.get("dsh.sessions.current"), JSON.stringify({ sessionId: other }));
  assert.deepEqual(h.retainedMain, [draft, canonical, other]);
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

for (const [code, sessionId, message] of recoveryCases) {
  it(`keeps ${code} visible and retryable when explicitly opening a session`, async () => {
    const target = SessionId(sessionId);
    const initialBlank = SessionId("draft-initial");
    const h = createHarness({
      createdIds: [initialBlank],
      loadSummary: async () => {
        throw remoteError(code, message);
      },
    });

    await flushMicrotasks();
    h.service.openSession(target);
    await flushMicrotasks();

    const errorState = { state: "error", sessionId: target, message };
    assert.deepEqual(h.service.opening.getSnapshot(), errorState);
    h.service.retryOpening();
    await flushMicrotasks();

    assert.deepEqual(h.loadSummaryCalls, [target, target]);
    assert.deepEqual(h.service.opening.getSnapshot(), errorState);
    assert.deepEqual(h.retainedMain, [initialBlank]);
    assert.equal(
      h.storage.get("dsh.sessions.current"),
      JSON.stringify({ sessionId: initialBlank }),
    );
  });
}

it("initializes the default workspace or keeps retryable recovery when offline fallback has only remote sessions", async () => {
  const offline = SessionId("web-remote:offline");
  const otherRemote = SessionId("web-remote:online-peer-thread");
  const remoteWsId = "remote-workspace:peer:proj" as WorkspaceId;
  const defaultWsId = "ws-default" as WorkspaceId;
  const fallbackDraft = SessionId("draft-default-ws");

  const remoteWorkspace: WorkspaceView = {
    workspaceId: remoteWsId,
    path: "/remote/proj",
    title: "Remote Proj",
    sessionIds: [otherRemote],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    remote: { hostId: "remote-peer:other", online: true },
  };
  const remoteSessions: SessionListState["byId"] = {
    [otherRemote]: {
      id: otherRemote,
      displayTitle: "Other remote",
      running: false,
      blank: false,
      updatedAt: 1,
      retainedBy: {},
    },
  };

  const initialized = createHarness({
    savedSessionId: offline,
    canStartProjectless: false,
    workspaceItems: [remoteWorkspace],
    initialSessions: remoteSessions,
    createdIds: [fallbackDraft],
    loadSummary: async () => {
      throw remoteError("remote/offline", "Remote peer is not connected");
    },
    initializeDefault: async (workspacesStore) => {
      const created: WorkspaceView = {
        workspaceId: defaultWsId,
        path: "/tmp/default",
        title: "Default",
        sessionIds: [],
        createdAt: "2026-01-02",
        updatedAt: "2026-01-02",
      };
      workspacesStore.update((draft) => {
        draft.items.push(created);
      });
      return created;
    },
  });

  await flushMicrotasks();

  assert.equal(initialized.initializeDefaultCalls, 1);
  assert.deepEqual(initialized.service.opening.getSnapshot(), { state: "idle" });
  assert.deepEqual(initialized.retainedMain, [fallbackDraft]);
  assert.equal(
    initialized.storage.get("dsh.sessions.current"),
    JSON.stringify({ sessionId: offline }),
  );

  let peerOnline = false;
  const unrecoverable = createHarness({
    savedSessionId: offline,
    canStartProjectless: false,
    workspaceItems: [remoteWorkspace],
    initialSessions: remoteSessions,
    loadSummary: async (id, listStore) => {
      if (!peerOnline) throw remoteError("remote/offline", "Remote peer is not connected");
      listStore.update((draft) => {
        if (!draft.ids.includes(id)) draft.ids.push(id);
        draft.byId[id] = {
          id,
          displayTitle: "Recovered remote",
          running: false,
          blank: false,
          updatedAt: 2,
          retainedBy: {},
        };
      });
    },
    initializeDefault: async () => {
      throw new Error("cannot create default workspace");
    },
  });

  await flushMicrotasks();

  assert.equal(unrecoverable.initializeDefaultCalls, 1);
  assert.deepEqual(unrecoverable.retainedMain, []);
  assert.deepEqual(unrecoverable.service.opening.getSnapshot(), {
    state: "error",
    sessionId: offline,
    message: "Remote peer is not connected",
  });
  assert.equal(
    unrecoverable.storage.get("dsh.sessions.current"),
    JSON.stringify({ sessionId: offline }),
  );

  peerOnline = true;
  unrecoverable.service.retryOpening();
  await flushMicrotasks();

  assert.deepEqual(unrecoverable.service.opening.getSnapshot(), { state: "idle" });
  assert.deepEqual(unrecoverable.retainedMain, [offline]);
});
