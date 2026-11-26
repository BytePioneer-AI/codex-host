import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type {
  ISessions,
  SessionListState,
  SessionSummary,
  SessionTarget,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type {
  IWorkspaces,
  WorkspaceSnapshot,
} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { ConnectionState } from "@deepseek-ai/dsh-client-connection/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  SessionStatus,
  SessionStatusSnapshot,
} from "@deepseek-ai/dsh-client-ui-session/client";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SubagentAddress } from "@deepseek-ai/dsh-subagent/client";
import type { SessionOpeningState, UiWorkspaceService } from "../src/client/navigation.ts";
import { registerRecentNavigation } from "../src/client/recent-navigation.ts";
import { RecentVisits } from "../src/client/recent-visits.ts";
import type { WorkspacePreferences } from "../src/client/workspace-preferences.ts";

const MINUTE_MS = 60_000;
const CACHE_KEY = "codexhost.web.session-tabs.v2:local";

interface FakeBrowser {
  visibilityState: "visible" | "hidden";
  setVisibility(state: "visible" | "hidden"): void;
  dispatchPageShow(persisted?: boolean): void;
  listenerCounts(): { visibilitychange: number; pageshow: number };
}

function installFakeBrowser(): FakeBrowser {
  const storage = new Map<string, string>();
  const docListeners = new Map<string, Set<() => void>>();
  const winListeners = new Map<string, Set<(event: { persisted: boolean }) => void>>();
  let visibilityState: "visible" | "hidden" = "visible";

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });

  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (type: string, listener: () => void) => {
      let set = docListeners.get(type);
      if (set === undefined) {
        set = new Set();
        docListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      docListeners.get(type)?.delete(listener);
    },
  });

  vi.stubGlobal("window", {
    location: { protocol: "https:" },
    addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => {
      let set = winListeners.get(type);
      if (set === undefined) {
        set = new Set();
        winListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => {
      winListeners.get(type)?.delete(listener);
    },
  });

  return {
    get visibilityState() {
      return visibilityState;
    },
    setVisibility(state) {
      visibilityState = state;
      for (const listener of [...(docListeners.get("visibilitychange") ?? [])]) listener();
    },
    dispatchPageShow(persisted = true) {
      for (const listener of [...(winListeners.get("pageshow") ?? [])]) listener({ persisted });
    },
    listenerCounts() {
      return {
        visibilitychange: docListeners.get("visibilitychange")?.size ?? 0,
        pageshow: winListeners.get("pageshow")?.size ?? 0,
      };
    },
  };
}

function makeSummary(id: SessionId, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: 0,
    retainedBy: {},
    ...overrides,
  };
}

interface HarnessOptions {
  initialList: SessionListState;
  initialWorkspaces?: WorkspaceSnapshot;
  initialStatuses?: ReadonlyMap<SessionId, SessionStatus>;
  initialConnection?: ConnectionState | undefined;
  initialPreferences?: Partial<WorkspacePreferences>;
  cachedTabs?: ReadonlyArray<{
    sessionId: SessionId;
    target: SessionTarget;
    lastVisitedAt: number;
  }>;
  currentId?: SessionId;
  subagentAddresses?: ReadonlyMap<SessionId, SubagentAddress>;
}

async function createHarness(options: HarnessOptions) {
  const browser = installFakeBrowser();
  if (options.cachedTabs !== undefined) {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: 2, entries: options.cachedTabs }));
  }

  const listStore = createSnapshotStore<SessionListState>(options.initialList);
  const workspacesStore = createSnapshotStore<WorkspaceSnapshot>(
    options.initialWorkspaces ?? {
      items: [],
      canStartProjectless: true,
      archivedSessionIds: [],
      pinnedSessionIds: [],
      threadSections: [],
      state: "idle",
      phase: "ready",
      error: null,
    },
  );
  const statusStore = createSnapshotStore<SessionStatusSnapshot>(
    new Map(options.initialStatuses ?? []),
  );
  const connectionStore = createSnapshotStore<ConnectionState | undefined>(
    "initialConnection" in options ? options.initialConnection : "connected",
  );
  const openingStore = createSnapshotStore<SessionOpeningState>({ state: "idle" });

  const initialValue: WorkspacePreferences = {
    showRecentVisits: true,
    tabIdleTimeoutMinutes: 60,
    threadTreeCollapseStyle: "summary",
    ...options.initialPreferences,
  };
  const prefStore = createSnapshotStore<ConfigFormSnapshot<WorkspacePreferences>>({
    status: "ready",
    value: initialValue,
    base: initialValue,
    user: {},
    revision: 0,
    writable: true,
    mode: "browser",
  });
  const preference: ConfigForm<WorkspacePreferences> = {
    getSnapshot: () => prefStore.getSnapshot(),
    subscribe: (listener) => prefStore.subscribe(listener),
    set: async (field, value) => {
      const current = prefStore.getSnapshot();
      const nextValue = { ...(current.value as WorkspacePreferences), [field]: value };
      prefStore.set({ ...current, value: nextValue, revision: (current.revision ?? 0) + 1 });
      return true;
    },
    unset: async () => true,
    mutate: async () => true,
  };

  const addresses = options.subagentAddresses ?? new Map<SessionId, SubagentAddress>();
  const loadSummary = vi.fn(async () => {});
  const sessions = {
    list: listStore,
    loadSummary,
    subagentAddress: (id: SessionId) => addresses.get(id),
    binding: () => undefined,
  } as unknown as ISessions;
  const workspaces = {
    list: workspacesStore,
  } as unknown as IWorkspaces;

  const recentVisits = new RecentVisits(sessions, workspaces);
  const stopVisits = recentVisits.start(options.currentId);
  if (options.currentId !== undefined) recentVisits.visit(options.currentId, options.currentId);

  const ctx = new Context();
  ctx.provide("sessions", sessions);
  ctx.provide("workspaces", workspaces);
  ctx.provide("uiSession", { sessionStatus: statusStore });
  ctx.provide("connection", { state: connectionStore });
  ctx.provide("slots", { inject: () => () => {} });

  const navigation = {
    recentVisits,
    opening: openingStore,
    openSession: vi.fn(),
    closeSessionTab: (id: SessionId) => recentVisits.close(id),
    closeAllSessionTabs: () => recentVisits.closeAll(),
    startSession: vi.fn(),
  } as unknown as UiWorkspaceService;

  registerRecentNavigation(ctx, navigation, preference);
  await Promise.resolve();
  await Promise.resolve();

  const tabIds = () => recentVisits.entries.getSnapshot().map((entry) => entry.sessionId);

  return {
    browser,
    ctx,
    listStore,
    workspacesStore,
    statusStore,
    connectionStore,
    openingStore,
    preference,
    recentVisits,
    loadSummary,
    tabIds,
    async dispose() {
      await ctx.fiber.dispose();
      stopVisits();
    },
  };
}

describe("idle session tab auto-close", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("immediately closes expired background tabs when lowering timeout or enabling tabs, without resetting timer on unrelated preferences", async () => {
    const now = Date.now();
    const currentId = SessionId("current");
    const staleId = SessionId("stale-20m");
    const freshId = SessionId("fresh-10m");

    const h = await createHarness({
      initialList: {
        ids: [currentId, staleId, freshId],
        byId: {
          [currentId]: makeSummary(currentId, { updatedAt: now - 30 * MINUTE_MS }),
          [staleId]: makeSummary(staleId, { updatedAt: now - 25 * MINUTE_MS }),
          [freshId]: makeSummary(freshId, { updatedAt: now - 10 * MINUTE_MS }),
        },
        phase: "ready",
        loading: false,
        listError: null,
        projectionsBySession: {},
      },
      initialPreferences: { showRecentVisits: true, tabIdleTimeoutMinutes: 60 },
      cachedTabs: [
        { sessionId: currentId, target: currentId, lastVisitedAt: now },
        { sessionId: staleId, target: staleId, lastVisitedAt: now - 20 * MINUTE_MS },
        { sessionId: freshId, target: freshId, lastVisitedAt: now - 10 * MINUTE_MS },
      ],
    });
    h.recentVisits.visit(currentId, currentId);
    expect(h.tabIds()).toEqual([currentId, staleId, freshId]);

    // Lower timeout from 60m to 15m -> staleId (idle 20m) closes immediately without waiting 60s.
    await h.preference.set("tabIdleTimeoutMinutes", 15);
    expect(h.tabIds()).toEqual([currentId, freshId]);

    // Advance 4m50s (10s remaining for freshId), change unrelated preference -> must not reset timer.
    vi.advanceTimersByTime(4 * MINUTE_MS + 50_000);
    expect(h.tabIds()).toEqual([currentId, freshId]);
    await h.preference.set("threadTreeCollapseStyle", "ring");
    vi.advanceTimersByTime(10_000);
    expect(h.tabIds()).toEqual([currentId]);

    // Toggling showRecentVisits off then on after another tab expires closes it immediately on re-enable.
    const toggledId = SessionId("toggled");
    h.listStore.set({
      ...h.listStore.getSnapshot(),
      ids: [currentId, toggledId],
      byId: {
        ...h.listStore.getSnapshot().byId,
        [toggledId]: makeSummary(toggledId, { updatedAt: Date.now() }),
      },
    });
    h.recentVisits.visit(toggledId, toggledId);
    h.recentVisits.visit(currentId, currentId);
    expect(h.tabIds()).toEqual([currentId, toggledId]);

    await h.preference.set("showRecentVisits", false);
    vi.advanceTimersByTime(20 * MINUTE_MS);
    expect(h.tabIds()).toEqual([currentId, toggledId]);

    await h.preference.set("showRecentVisits", true);
    expect(h.tabIds()).toEqual([currentId]);

    await h.dispose();
  });

  it("closes idle tabs immediately on foreground return (<60s stay) via visibilitychange and pageshow, and retries once reconnected and ready", async () => {
    const now = Date.now();
    const currentId = SessionId("current");
    const idleA = SessionId("idle-a");
    const idleB = SessionId("idle-b");

    const h = await createHarness({
      initialList: {
        ids: [currentId, idleA, idleB],
        byId: {
          [currentId]: makeSummary(currentId, { updatedAt: now }),
          [idleA]: makeSummary(idleA, { updatedAt: now }),
          [idleB]: makeSummary(idleB, { updatedAt: now }),
        },
        phase: "ready",
        loading: false,
        listError: null,
        projectionsBySession: {},
      },
      initialPreferences: { showRecentVisits: true, tabIdleTimeoutMinutes: 15 },
      cachedTabs: [
        { sessionId: currentId, target: currentId, lastVisitedAt: now },
        { sessionId: idleA, target: idleA, lastVisitedAt: now },
        { sessionId: idleB, target: idleB, lastVisitedAt: now },
      ],
    });
    h.recentVisits.visit(currentId, currentId);

    // Go to background for 20 minutes while connection drops.
    h.browser.setVisibility("hidden");
    h.connectionStore.set("connecting");
    h.listStore.set({ ...h.listStore.getSnapshot(), loading: true });
    vi.advanceTimersByTime(20 * MINUTE_MS);
    expect(h.tabIds()).toEqual([currentId, idleA, idleB]);

    // Return to foreground for only 5 seconds while still reconnecting, then become ready.
    h.browser.setVisibility("visible");
    expect(h.tabIds()).toEqual([currentId, idleA, idleB]);

    vi.advanceTimersByTime(2_000);
    h.connectionStore.set("connected");
    expect(h.tabIds()).toEqual([currentId, idleA, idleB]);

    vi.advanceTimersByTime(1_000);
    h.listStore.set({ ...h.listStore.getSnapshot(), loading: false });
    expect(h.tabIds()).toEqual([currentId]);

    // Verify pageshow (iOS Safari bfcache restore) also triggers immediate expiration.
    const bfcacheId = SessionId("bfcache");
    const t2 = Date.now();
    h.listStore.set({
      ...h.listStore.getSnapshot(),
      ids: [currentId, bfcacheId],
      byId: {
        ...h.listStore.getSnapshot().byId,
        [bfcacheId]: makeSummary(bfcacheId, { updatedAt: t2 }),
      },
    });
    h.recentVisits.visit(bfcacheId, bfcacheId);
    h.recentVisits.visit(currentId, currentId);
    expect(h.tabIds()).toEqual([currentId, bfcacheId]);

    // Simulate bfcache freeze where visibilitychange did not fire before pageshow.
    vi.setSystemTime(t2 + 16 * MINUTE_MS);
    h.browser.dispatchPageShow(true);
    expect(h.tabIds()).toEqual([currentId]);

    await h.dispose();
    expect(h.browser.listenerCounts()).toEqual({ visibilitychange: 0, pageshow: 0 });
  });

  it("fires precisely when a background tab reaches timeout without waiting for a 60s tick", async () => {
    const now = Date.now();
    const currentId = SessionId("current");
    const soonId = SessionId("soon-10s");

    const h = await createHarness({
      initialList: {
        ids: [currentId, soonId],
        byId: {
          [currentId]: makeSummary(currentId, { updatedAt: now }),
          [soonId]: makeSummary(soonId, { updatedAt: now - 20 * MINUTE_MS }),
        },
        phase: "ready",
        loading: false,
        listError: null,
        projectionsBySession: {},
      },
      initialPreferences: { showRecentVisits: true, tabIdleTimeoutMinutes: 15 },
      cachedTabs: [
        { sessionId: currentId, target: currentId, lastVisitedAt: now },
        {
          sessionId: soonId,
          target: soonId,
          lastVisitedAt: now - (15 * MINUTE_MS - 10_000),
        },
      ],
    });
    h.recentVisits.visit(currentId, currentId);

    vi.advanceTimersByTime(9_999);
    expect(h.tabIds()).toEqual([currentId, soonId]);

    vi.advanceTimersByTime(1);
    expect(h.tabIds()).toEqual([currentId]);

    await h.dispose();
  });

  it("preserves protected tabs (current, running, parent with running subagent, pending interaction, fresh updatedAt)", async () => {
    const now = Date.now();
    const staleAt = now - 30 * MINUTE_MS;
    const currentId = SessionId("current");
    const runningId = SessionId("running");
    const parentId = SessionId("parent-with-running-child");
    const runningChildId = SessionId("running-child");
    const pendingId = SessionId("pending-interaction");
    const recentActivityId = SessionId("recent-updated-at");
    const expirableId = SessionId("expirable");

    const h = await createHarness({
      initialList: {
        ids: [currentId, runningId, parentId, pendingId, recentActivityId, expirableId],
        byId: {
          [currentId]: makeSummary(currentId, { updatedAt: staleAt }),
          [runningId]: makeSummary(runningId, { updatedAt: staleAt, running: true }),
          [parentId]: makeSummary(parentId, { updatedAt: staleAt }),
          [runningChildId]: makeSummary(runningChildId, {
            updatedAt: staleAt,
            running: true,
            parentId,
            origin: "subagent",
          }),
          [pendingId]: makeSummary(pendingId, { updatedAt: staleAt }),
          [recentActivityId]: makeSummary(recentActivityId, {
            updatedAt: now - 5 * MINUTE_MS,
          }),
          [expirableId]: makeSummary(expirableId, { updatedAt: staleAt }),
        },
        phase: "ready",
        loading: false,
        listError: null,
        projectionsBySession: {
          [parentId]: {
            state: "ready",
            error: null,
            values: {
              subagentCatalog: [
                { id: runningChildId, createdAt: staleAt, mode: "one-shot", label: "worker" },
              ],
            },
          },
        },
      },
      initialStatuses: new Map<SessionId, SessionStatus>([
        [
          pendingId,
          {
            running: false,
            completionUnread: false,
            pendingInteraction: { key: "req-1", kind: "approval", sessionId: pendingId },
          },
        ],
      ]),
      initialPreferences: { showRecentVisits: true, tabIdleTimeoutMinutes: 15 },
      cachedTabs: [
        { sessionId: currentId, target: currentId, lastVisitedAt: staleAt },
        { sessionId: runningId, target: runningId, lastVisitedAt: staleAt },
        { sessionId: parentId, target: parentId, lastVisitedAt: staleAt },
        { sessionId: pendingId, target: pendingId, lastVisitedAt: staleAt },
        { sessionId: recentActivityId, target: recentActivityId, lastVisitedAt: staleAt },
        { sessionId: expirableId, target: expirableId, lastVisitedAt: staleAt },
      ],
      currentId,
    });

    expect(h.tabIds()).toEqual([currentId, runningId, parentId, pendingId, recentActivityId]);

    // Once the running tab finishes, status/list update triggers immediate cleanup.
    h.listStore.set({
      ...h.listStore.getSnapshot(),
      byId: {
        ...h.listStore.getSnapshot().byId,
        [runningId]: makeSummary(runningId, { updatedAt: staleAt, running: false }),
      },
    });
    expect(h.tabIds()).toEqual([currentId, parentId, pendingId, recentActivityId]);

    await h.dispose();
  });

  it("allows expiration when listErrorPage is 'more', still skips when listErrorPage is 'head'", async () => {
    const now = Date.now();
    const staleAt = now - 30 * MINUTE_MS;
    const currentId = SessionId("current");
    const staleId = SessionId("stale");

    const h = await createHarness({
      initialList: {
        ids: [currentId, staleId],
        byId: {
          [currentId]: makeSummary(currentId, { updatedAt: staleAt }),
          [staleId]: makeSummary(staleId, { updatedAt: staleAt }),
        },
        phase: "ready",
        loading: false,
        listError: "head failed",
        listErrorPage: "head",
        projectionsBySession: {},
      },
      initialPreferences: { showRecentVisits: true, tabIdleTimeoutMinutes: 15 },
      cachedTabs: [
        { sessionId: currentId, target: currentId, lastVisitedAt: now },
        { sessionId: staleId, target: staleId, lastVisitedAt: staleAt },
      ],
    });
    h.recentVisits.visit(currentId, currentId);

    // Head list failure still prevents expiration.
    expect(h.tabIds()).toEqual([currentId, staleId]);

    // Pagination ("more") failure must not block idle tab expiration.
    h.listStore.set({
      ...h.listStore.getSnapshot(),
      listError: "loadMore failed",
      listErrorPage: "more",
    });
    expect(h.tabIds()).toEqual([currentId]);

    await h.dispose();
  });

  it("closes finished subagent tabs confirmed non-running by catalog/timing even when statuses has no entry, while protecting unknown/active subagents", async () => {
    const now = Date.now();
    const staleAt = now - 30 * MINUTE_MS;
    const parentId = SessionId("parent");
    const listedDoneChild = SessionId("subagent-listed-done");
    const timingDoneChild = SessionId("subagent-timing-done");
    const activeTimingChild = SessionId("subagent-timing-active");
    const unconfirmedChild = SessionId("subagent-unconfirmed");

    const addressOf = (childSessionId: SessionId): SubagentAddress => ({
      parentSessionId: parentId,
      childSessionId,
      mode: "continuable",
    });

    const h = await createHarness({
      initialList: {
        // Only parentId and listedDoneChild came from Host session/list (`list.ids`).
        ids: [parentId, listedDoneChild],
        byId: {
          [parentId]: makeSummary(parentId, { updatedAt: now }),
          [listedDoneChild]: makeSummary(listedDoneChild, {
            updatedAt: staleAt,
            running: false,
            parentId,
            origin: "subagent",
          }),
          [timingDoneChild]: makeSummary(timingDoneChild, {
            updatedAt: staleAt,
            running: false,
            parentId,
            origin: "subagent",
            projectionValues: {
              subagentTiming: { settledMs: 5_000, lastTurnCompleted: true },
            },
          }),
          [activeTimingChild]: makeSummary(activeTimingChild, {
            updatedAt: staleAt,
            running: false,
            parentId,
            origin: "subagent",
            projectionValues: {
              subagentTiming: {
                settledMs: 0,
                active: { since: staleAt, through: staleAt + 1_000 },
              },
            },
          }),
          [unconfirmedChild]: makeSummary(unconfirmedChild, {
            updatedAt: 0,
            running: false,
            parentId,
            origin: "subagent",
          }),
        },
        phase: "ready",
        loading: false,
        listError: null,
        projectionsBySession: {
          [parentId]: {
            state: "ready",
            error: null,
            values: {
              subagentCatalog: [
                { id: listedDoneChild, createdAt: staleAt, mode: "continuable", label: "done-1" },
                { id: timingDoneChild, createdAt: staleAt, mode: "continuable", label: "done-2" },
                {
                  id: activeTimingChild,
                  createdAt: staleAt,
                  mode: "continuable",
                  label: "active",
                },
                {
                  id: unconfirmedChild,
                  createdAt: staleAt,
                  mode: "continuable",
                  label: "unknown",
                },
              ],
            },
          },
        },
      },
      // Empty statuses map: simulates cold reload where uiSession has not received status for subagents.
      initialStatuses: new Map(),
      initialPreferences: { showRecentVisits: true, tabIdleTimeoutMinutes: 15 },
      subagentAddresses: new Map([
        [listedDoneChild, addressOf(listedDoneChild)],
        [timingDoneChild, addressOf(timingDoneChild)],
        [activeTimingChild, addressOf(activeTimingChild)],
        [unconfirmedChild, addressOf(unconfirmedChild)],
      ]),
      cachedTabs: [
        { sessionId: parentId, target: parentId, lastVisitedAt: now },
        { sessionId: listedDoneChild, target: addressOf(listedDoneChild), lastVisitedAt: staleAt },
        { sessionId: timingDoneChild, target: addressOf(timingDoneChild), lastVisitedAt: staleAt },
        {
          sessionId: activeTimingChild,
          target: addressOf(activeTimingChild),
          lastVisitedAt: staleAt,
        },
        {
          sessionId: unconfirmedChild,
          target: addressOf(unconfirmedChild),
          lastVisitedAt: staleAt,
        },
      ],
    });
    h.recentVisits.visit(parentId, parentId);

    // listedDoneChild and timingDoneChild expire; activeTimingChild and unconfirmedChild stay protected.
    expect(h.tabIds()).toEqual([parentId, activeTimingChild, unconfirmedChild]);

    await h.dispose();
  });
});
