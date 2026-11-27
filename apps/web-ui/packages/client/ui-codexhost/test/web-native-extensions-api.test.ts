// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {
  HostExtensionRuntimeEntry,
  WebExtensionActiveSession,
} from "@codexhost/shared-contracts";
import { createWebExtensionApi } from "../src/client/native-extensions/api.ts";
import type { WebNativeExtensionRpcClient } from "../src/client/native-extensions/rpc.ts";

interface Store<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  set(next: T): void;
  listenerCount(): number;
}

function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

interface SessionSummaryFixture {
  id: string;
  displayTitle: string;
  cwd?: string;
  parentId?: string;
  running: boolean;
  blank: boolean;
  retainedBy: { mainView?: number };
  projectionValues?: { remoteHost?: unknown };
}

interface SessionListFixture {
  byId: Record<string, SessionSummaryFixture>;
  projectionsBySession?: Record<string, { values?: { remoteHost?: unknown } }>;
}

interface WorkspaceFixture {
  workspaceId: string;
  path: string;
  sessionIds: string[];
  remote?: { hostId: string };
}

function createEntry(): HostExtensionRuntimeEntry {
  return {
    id: "sample-ext",
    activationId: "00000000-0000-4000-8000-000000000001",
    digest: "a".repeat(64),
    installedAt: "2026-11-27T00:00:00.000Z",
    settingsRevision: 1,
    manifest: {
      manifestVersion: 2,
      id: "sample-ext",
      name: { en: "Sample", "zh-CN": "示例" },
      version: "1.0.0",
      description: { en: "Sample", "zh-CN": "示例" },
      web: { apiVersion: 1, entry: "web/index.mjs" },
    },
  };
}

function createMockRpc(): WebNativeExtensionRpcClient {
  return {
    snapshot: vi.fn(),
    settingsGet: vi.fn(),
    settingsSet: vi.fn(),
    backendInvoke: vi.fn(),
  };
}

function createMockCtx(services: Record<string, unknown>): ClientContext {
  return {
    get(name: string) {
      return services[name];
    },
  } as unknown as ClientContext;
}

describe("WebExtensionApi session context and composer-dock region", () => {
  it("returns null when sessions service is absent or no session is retained by mainView", () => {
    const absent = createWebExtensionApi({
      ctx: createMockCtx({}),
      document,
      entry: createEntry(),
      rpc: createMockRpc(),
      onSettingsRevisionObserved: () => undefined,
    });
    expect(absent.api.session.getActive()).toBeNull();
    const stopAbsent = absent.api.session.onChange(() => undefined);
    stopAbsent();
    absent.reclaim();

    const sessionsStore = createStore<SessionListFixture>({
      byId: {
        s1: {
          id: "s1",
          displayTitle: "Background thread",
          cwd: "/repo/a",
          running: false,
          blank: false,
          retainedBy: {},
        },
      },
    });
    const managed = createWebExtensionApi({
      ctx: createMockCtx({ sessions: { list: sessionsStore } }),
      document,
      entry: createEntry(),
      rpc: createMockRpc(),
      onSettingsRevisionObserved: () => undefined,
    });
    expect(managed.api.session.getActive()).toBeNull();
    managed.reclaim();
  });

  it("reads local, worktree, workspace-fallback, blank, and remote active session snapshots", () => {
    const sessionsStore = createStore<SessionListFixture>({
      byId: {
        local: {
          id: "local",
          displayTitle: "Worktree thread",
          cwd: "/repo/worktrees/feat",
          running: true,
          blank: false,
          retainedBy: { mainView: 1 },
        },
      },
    });
    const workspacesStore = createStore<{ items: WorkspaceFixture[] }>({
      items: [
        {
          workspaceId: "ws-1",
          path: "/repo/main",
          sessionIds: ["local", "blank-1", "parent-remote"],
        },
        {
          workspaceId: "ws-remote",
          path: "/remote/repo",
          sessionIds: ["remote-via-ws"],
          remote: { hostId: "peer-1" },
        },
      ],
    });
    const subagentParents: Record<string, { parentSessionId: string }> = {
      "child-of-remote": { parentSessionId: "parent-remote" },
    };
    const managed = createWebExtensionApi({
      ctx: createMockCtx({
        sessions: {
          list: sessionsStore,
          subagentAddress: (id: string) => subagentParents[id],
        },
        workspaces: { list: workspacesStore },
      }),
      document,
      entry: createEntry(),
      rpc: createMockRpc(),
      onSettingsRevisionObserved: () => undefined,
    });

    // Worktree summary.cwd takes precedence over workspace.path; snapshot is cloned.
    const first = managed.api.session.getActive();
    expect(first).toEqual({
      id: "local",
      title: "Worktree thread",
      cwd: "/repo/worktrees/feat",
      workspaceId: "ws-1",
      isBlank: false,
      isRemote: false,
      running: true,
    });
    if (first !== null) {
      (first as { cwd: string | null }).cwd = "/mutated";
    }
    expect(managed.api.session.getActive()?.cwd).toBe("/repo/worktrees/feat");

    // Blank session falls back to owning workspace.path when summary.cwd is omitted.
    sessionsStore.set({
      byId: {
        "blank-1": {
          id: "blank-1",
          displayTitle: "New session",
          running: false,
          blank: true,
          retainedBy: { mainView: 1 },
        },
      },
    });
    expect(managed.api.session.getActive()).toEqual({
      id: "blank-1",
      title: "New session",
      cwd: "/repo/main",
      workspaceId: "ws-1",
      isBlank: true,
      isRemote: false,
      running: false,
    });

    // Projectless blank session reports null cwd and workspaceId.
    sessionsStore.set({
      byId: {
        "blank-free": {
          id: "blank-free",
          displayTitle: "Blank",
          running: false,
          blank: true,
          retainedBy: { mainView: 1 },
        },
      },
    });
    expect(managed.api.session.getActive()).toEqual({
      id: "blank-free",
      title: "Blank",
      cwd: null,
      workspaceId: null,
      isBlank: true,
      isRemote: false,
      running: false,
    });

    // Remote session detected via web-remote prefix, remote workspace, or parent projection.
    sessionsStore.set({
      byId: {
        "web-remote:peer:t1": {
          id: "web-remote:peer:t1",
          displayTitle: "Remote thread",
          cwd: "/srv/app",
          running: false,
          blank: false,
          retainedBy: { mainView: 1 },
        },
      },
    });
    expect(managed.api.session.getActive()?.isRemote).toBe(true);

    sessionsStore.set({
      byId: {
        "remote-via-ws": {
          id: "remote-via-ws",
          displayTitle: "Remote workspace thread",
          running: false,
          blank: false,
          retainedBy: { mainView: 1 },
        },
      },
    });
    expect(managed.api.session.getActive()).toMatchObject({
      cwd: "/remote/repo",
      workspaceId: "ws-remote",
      isRemote: true,
    });

    sessionsStore.set({
      byId: {
        "parent-remote": {
          id: "parent-remote",
          displayTitle: "Parent",
          running: false,
          blank: false,
          retainedBy: {},
        },
        "child-of-remote": {
          id: "child-of-remote",
          displayTitle: "Child subagent",
          running: true,
          blank: false,
          retainedBy: { mainView: 1 },
        },
      },
      projectionsBySession: {
        "parent-remote": { values: { remoteHost: { hostId: "peer-2" } } },
      },
    });
    expect(managed.api.session.getActive()).toMatchObject({
      id: "child-of-remote",
      workspaceId: "ws-1",
      isRemote: true,
    });

    managed.reclaim();
  });

  it("subscribes lazily, deduplicates unchanged snapshots, isolates errors, and cleans up on reclaim", () => {
    const sessionsStore = createStore<SessionListFixture>({
      byId: {
        s1: {
          id: "s1",
          displayTitle: "Thread 1",
          cwd: "/repo/one",
          running: false,
          blank: false,
          retainedBy: { mainView: 1 },
        },
      },
    });
    const workspacesStore = createStore<{ items: WorkspaceFixture[] }>({
      items: [{ workspaceId: "ws-1", path: "/repo/one", sessionIds: ["s1"] }],
    });
    const managed = createWebExtensionApi({
      ctx: createMockCtx({
        sessions: { list: sessionsStore },
        workspaces: { list: workspacesStore },
      }),
      document,
      entry: createEntry(),
      rpc: createMockRpc(),
      onSettingsRevisionObserved: () => undefined,
    });

    // No underlying store subscription until a listener is registered.
    expect(sessionsStore.listenerCount()).toBe(0);
    expect(workspacesStore.listenerCount()).toBe(0);

    const events: Array<WebExtensionActiveSession | null> = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stopBad = managed.api.session.onChange(() => {
      throw new Error("boom");
    });
    const stopGood = managed.api.session.onChange((session) => {
      events.push(session);
    });

    // Does not replay initial value; subscribes once to each store.
    expect(events).toHaveLength(0);
    expect(sessionsStore.listenerCount()).toBe(1);
    expect(workspacesStore.listenerCount()).toBe(1);

    // Unrelated catalog update does not trigger listeners.
    sessionsStore.set({
      byId: {
        ...sessionsStore.getSnapshot().byId,
        bg: {
          id: "bg",
          displayTitle: "Other",
          cwd: "/repo/other",
          running: true,
          blank: false,
          retainedBy: {},
        },
      },
    });
    expect(events).toHaveLength(0);

    // Running state change emits once and isolates the throwing listener.
    sessionsStore.set({
      byId: {
        s1: {
          id: "s1",
          displayTitle: "Thread 1",
          cwd: "/repo/one",
          running: true,
          blank: false,
          retainedBy: { mainView: 1 },
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.running).toBe(true);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Workspace update assigning a workspaceId emits cleanly.
    workspacesStore.set({
      items: [{ workspaceId: "ws-2", path: "/repo/one", sessionIds: ["s1"] }],
    });
    expect(events).toHaveLength(2);
    expect(events[1]?.workspaceId).toBe("ws-2");

    // Clearing mainView emits null.
    sessionsStore.set({ byId: {} });
    expect(events).toHaveLength(3);
    expect(events[2]).toBeNull();

    // Unsubscribing all listeners detaches store subscriptions.
    stopBad();
    stopGood();
    expect(sessionsStore.listenerCount()).toBe(0);
    expect(workspacesStore.listenerCount()).toBe(0);

    // Re-subscribe then reclaim: store subscriptions detach and API guards reject calls.
    managed.api.session.onChange(() => undefined);
    expect(sessionsStore.listenerCount()).toBe(1);
    managed.reclaim();
    expect(sessionsStore.listenerCount()).toBe(0);
    expect(workspacesStore.listenerCount()).toBe(0);
    expect(() => managed.api.session.getActive()).toThrow(/unloading|aborted/iu);
    expect(() => managed.api.session.onChange(() => undefined)).toThrow(/unloading|aborted/iu);
    errorSpy.mockRestore();
  });

  it("mounts into composer-dock within the main conversation region without targeting embedded sidebar docks", () => {
    document.body.innerHTML = `
      <div data-cx-region="app">
        <aside data-cx-region="sidebar">
          <div data-cx-region="composer-dock" id="embedded-dock"></div>
        </aside>
        <main data-cx-region="conversation">
          <div data-cx-region="composer-dock" id="main-dock"><span id="existing"></span></div>
        </main>
      </div>
    `;
    const managed = createWebExtensionApi({
      ctx: createMockCtx({}),
      document,
      entry: createEntry(),
      rpc: createMockRpc(),
      onSettingsRevisionObserved: () => undefined,
    });

    const mount = managed.api.dom.mount("composer-dock", "prepend");
    expect(mount).toBeDefined();
    expect(mount?.container.parentElement?.id).toBe("main-dock");
    expect(mount?.container.nextElementSibling?.id).toBe("existing");
    managed.reclaim();
    expect(document.getElementById("main-dock")?.children).toHaveLength(1);

    // When conversation is not mounted in the app shell (e.g. Settings/Plugins), do not mount into embedded docks.
    document.body.innerHTML = `
      <div data-cx-region="app">
        <aside data-cx-region="sidebar">
          <div data-cx-region="composer-dock" id="embedded-dock"></div>
        </aside>
      </div>
    `;
    const managedNoConv = createWebExtensionApi({
      ctx: createMockCtx({}),
      document,
      entry: createEntry(),
      rpc: createMockRpc(),
      onSettingsRevisionObserved: () => undefined,
    });
    expect(managedNoConv.api.dom.mount("composer-dock", "prepend")).toBeUndefined();
    managedNoConv.reclaim();

    // In standalone DOM without an app shell wrapper, composer-dock resolves directly.
    document.body.innerHTML = `<div data-cx-region="composer-dock" id="standalone-dock"></div>`;
    const managedStandalone = createWebExtensionApi({
      ctx: createMockCtx({}),
      document,
      entry: createEntry(),
      rpc: createMockRpc(),
      onSettingsRevisionObserved: () => undefined,
    });
    const standaloneMount = managedStandalone.api.dom.mount("composer-dock");
    expect(standaloneMount?.container.parentElement?.id).toBe("standalone-dock");
    managedStandalone.reclaim();
  });
});
