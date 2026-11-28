import { describe, expect, it } from "vitest";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceId, WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionStatus } from "@deepseek-ai/dsh-client-ui-session/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  activityPriorityOf,
  collectUnreadSessionIds,
  deriveActivityView,
} from "../src/client/activity-view.ts";
import {
  filterSessionsByHostScope,
  type HostScopeFilterState,
} from "../src/client/rows/host-scope-filter.ts";
import type { SessionRowState, SessionStatuses } from "../src/client/tree.ts";

function makeSession(
  key: string,
  options: {
    updatedAt?: number;
    running?: boolean;
    blank?: boolean;
    origin?: SessionSummary["origin"];
    parent?: string | null;
    remote?: { hostId: string; displayName: string; state: string; color?: string };
  } = {},
): SessionSummary {
  return {
    id: SessionId(key),
    title: key,
    displayTitle: key,
    running: options.running ?? false,
    blank: options.blank ?? false,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    retainedBy: {},
    updatedAt: options.updatedAt ?? 100,
    projectionValues: {
      threadTreeParent: options.parent ?? null,
      threadReference: { hostId: options.remote?.hostId ?? "local" },
      ...(options.remote === undefined ? {} : { remoteHost: options.remote }),
    },
  };
}

function makeList(
  rows: readonly SessionSummary[],
  subagents: Readonly<Record<string, readonly { id: SessionId; running?: boolean }[]>> = {},
): SessionListState {
  const byId: Record<string, SessionSummary> = Object.fromEntries(rows.map((row) => [row.id, row]));
  for (const children of Object.values(subagents)) {
    for (const child of children) {
      if (byId[child.id] === undefined) {
        byId[child.id] = makeSession(child.id, {
          running: child.running ?? false,
          origin: "subagent",
        });
      }
    }
  }
  const projectionsBySession = Object.fromEntries(
    Object.entries(subagents).map(([parentId, children]) => [
      parentId,
      {
        values: {
          subagentCatalog: children.map((child) => ({
            id: child.id,
            title: child.id,
          })),
        },
      },
    ]),
  ) as SessionListState["projectionsBySession"];

  return {
    ids: rows.map((row) => row.id),
    byId,
    phase: "ready",
    projectionsBySession,
  };
}

function makeStatuses(
  entries: Readonly<
    Record<
      string,
      {
        running?: boolean;
        completionUnread?: boolean;
        pendingKind?: "approval" | "plan-review" | "question";
      }
    >
  >,
): SessionStatuses {
  const map = new Map<SessionId, SessionStatus>();
  for (const [key, entry] of Object.entries(entries)) {
    const id = SessionId(key);
    map.set(id, {
      running: entry.running ?? false,
      completionUnread: entry.completionUnread ?? false,
      pendingInteraction:
        entry.pendingKind === undefined
          ? undefined
          : ({ kind: entry.pendingKind } as SessionStatus["pendingInteraction"]),
    } as SessionStatus);
  }
  return map;
}

const defaultRowState: SessionRowState = {
  pinnedSessionIds: [],
  archivedSessionIds: [],
  archivedFilter: "default",
};

describe("deriveActivityView", () => {
  it("filters to pending, running (including subagents), and unread sessions while excluding idle, blank, subagent, and archived rows", () => {
    const list = makeList(
      [
        makeSession("idle", { updatedAt: 500 }),
        makeSession("blank-draft", { blank: true, updatedAt: 600 }),
        makeSession("subagent-row", { origin: "subagent", running: true, updatedAt: 700 }),
        makeSession("archived-unread", { updatedAt: 800 }),
        makeSession("archived-running", { running: true, updatedAt: 900 }),
        makeSession("approval-row", { updatedAt: 100 }),
        makeSession("plan-row", { updatedAt: 200 }),
        makeSession("question-row", { updatedAt: 150 }),
        makeSession("running-row", { running: true, updatedAt: 250 }),
        makeSession("subagent-host", { updatedAt: 300 }),
        makeSession("unread-old", { updatedAt: 120 }),
        makeSession("unread-new", { updatedAt: 400 }),
      ],
      {
        "subagent-host": [{ id: SessionId("child-agent"), running: true }],
      },
    );
    const statuses = makeStatuses({
      "archived-unread": { completionUnread: true },
      "archived-running": { running: true },
      "approval-row": { pendingKind: "approval" },
      "plan-row": { pendingKind: "plan-review" },
      "question-row": { pendingKind: "question" },
      "running-row": { running: true },
      "unread-old": { completionUnread: true },
      "unread-new": { completionUnread: true },
    });

    // Even when the main sidebar shows archived rows or archived-only, Activity View excludes archived sessions.
    for (const archivedFilter of ["default", "show", "only"] as const) {
      const projection = deriveActivityView(
        list,
        {
          ...defaultRowState,
          archivedSessionIds: [SessionId("archived-unread"), SessionId("archived-running")],
          archivedFilter,
        },
        statuses,
      );

      expect(projection.rows.map((row) => row.id)).toEqual([
        SessionId("plan-row"),
        SessionId("question-row"),
        SessionId("approval-row"),
        SessionId("subagent-host"),
        SessionId("running-row"),
        SessionId("unread-new"),
        SessionId("unread-old"),
      ]);
      expect(projection.unreadSessionIds).toEqual([
        SessionId("unread-new"),
        SessionId("unread-old"),
      ]);
      expect(projection.pendingCount).toBe(3);
      expect(projection.runningCount).toBe(2);
      expect(projection.unreadCount).toBe(2);
      expect(projection.hasAttention).toBe(true);
    }
  });

  it("keeps stable ordering for ties within the same priority bucket", () => {
    const list = makeList([
      makeSession("unread-first", { updatedAt: 500 }),
      makeSession("unread-second", { updatedAt: 500 }),
      makeSession("unread-third", { updatedAt: 500 }),
    ]);
    const statuses = makeStatuses({
      "unread-first": { completionUnread: true },
      "unread-second": { completionUnread: true },
      "unread-third": { completionUnread: true },
    });

    const projection = deriveActivityView(list, defaultRowState, statuses);
    expect(projection.rows.map((row) => row.id)).toEqual([
      SessionId("unread-first"),
      SessionId("unread-second"),
      SessionId("unread-third"),
    ]);
  });

  it("surfaces idle parents with active descendants and collects all unread IDs across the subtree", () => {
    const list = makeList([
      makeSession("parent-with-unread-grandchild", { updatedAt: 100 }),
      makeSession("mid-idle", { parent: "parent-with-unread-grandchild", updatedAt: 150 }),
      makeSession("grandchild-unread", { parent: "mid-idle", updatedAt: 600 }),
      makeSession("parent-with-pending-child", { updatedAt: 200 }),
      makeSession("child-pending", { parent: "parent-with-pending-child", updatedAt: 210 }),
      makeSession("child-unread", { parent: "parent-with-pending-child", updatedAt: 220 }),
      makeSession("standalone-running", { running: true, updatedAt: 500 }),
      makeSession("standalone-unread", { updatedAt: 300 }),
    ]);

    const statusEntries = {
      "grandchild-unread": { completionUnread: true },
      "child-pending": { pendingKind: "approval" as const },
      "child-unread": { completionUnread: true },
      "standalone-running": { running: true },
      "standalone-unread": { completionUnread: true },
    };
    const statuses = makeStatuses(statusEntries);

    const projection = deriveActivityView(list, defaultRowState, statuses);

    // Pending subtree ranks first, running second, unread subtree (effective updatedAt 600) ahead of unread (300).
    expect(projection.rows.map((row) => row.id)).toEqual([
      SessionId("parent-with-pending-child"),
      SessionId("standalone-running"),
      SessionId("parent-with-unread-grandchild"),
      SessionId("standalone-unread"),
    ]);
    expect(activityPriorityOf(projection.rows[0]!)).toBe(0);
    expect(activityPriorityOf(projection.rows[1]!)).toBe(1);
    expect(activityPriorityOf(projection.rows[2]!)).toBe(2);

    const unreadIds = collectUnreadSessionIds(projection.rows);
    expect(unreadIds).toEqual([
      SessionId("child-unread"),
      SessionId("grandchild-unread"),
      SessionId("standalone-unread"),
    ]);
    expect(projection.unreadSessionIds).toEqual(unreadIds);

    // Simulating markCompletionsRead(unreadIds) clears only unread reminders, leaving pending & running untouched.
    const afterMarkRead = new Map(statuses);
    for (const id of unreadIds) {
      const current = afterMarkRead.get(id);
      if (current) afterMarkRead.set(id, { ...current, completionUnread: false });
    }
    const nextProjection = deriveActivityView(list, defaultRowState, afterMarkRead);
    expect(nextProjection.rows.map((row) => row.id)).toEqual([
      SessionId("parent-with-pending-child"),
      SessionId("standalone-running"),
    ]);
    expect(nextProjection.unreadSessionIds).toEqual([]);
    expect(nextProjection.pendingCount).toBe(1);
    expect(nextProjection.runningCount).toBe(1);
    expect(nextProjection.hasAttention).toBe(true);
  });

  it("sets hasAttention to false when sessions are only running without pending interactions or unread completions", () => {
    const list = makeList([makeSession("worker", { running: true, updatedAt: 100 })]);
    const statuses = makeStatuses({ worker: { running: true } });

    const projection = deriveActivityView(list, defaultRowState, statuses);
    expect(projection.rows.map((row) => row.id)).toEqual([SessionId("worker")]);
    expect(projection.runningCount).toBe(1);
    expect(projection.pendingCount).toBe(0);
    expect(projection.unreadCount).toBe(0);
    expect(projection.hasAttention).toBe(false);
  });

  it("scopes activity rows and unread collection to the active host scope filter", () => {
    const remote = {
      hostId: "remote-peer:demo-node",
      displayName: "Demo Node",
      state: "connected",
      color: "blue",
    };
    const workspaces: WorkspaceView[] = [
      {
        workspaceId: "ws-local" as WorkspaceId,
        title: "alpha-app",
        path: "/work/alpha-app",
        sessionIds: [SessionId("local-unread")],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        workspaceId: "ws-remote" as WorkspaceId,
        title: "beta-service",
        path: "/srv/beta-service",
        sessionIds: [SessionId("remote-unread")],
        remote,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const fullList = makeList([
      makeSession("local-unread", { updatedAt: 200 }),
      makeSession("remote-unread", { updatedAt: 300, remote }),
    ]);
    const statuses = makeStatuses({
      "local-unread": { completionUnread: true },
      "remote-unread": { completionUnread: true },
    });

    const remoteOnlyFilter: HostScopeFilterState = {
      selectedHost: remote.hostId,
      perHost: {},
    };
    const allowedIds = new Set(
      filterSessionsByHostScope(
        fullList.ids.map((id) => ({
          id,
          remote: fullList.byId[id]?.projectionValues?.remoteHost ?? undefined,
        })),
        new Set(["ws-remote"]),
        workspaces,
        remoteOnlyFilter,
      ).map((entry) => entry.id),
    );
    const scopedList: SessionListState = {
      ...fullList,
      ids: fullList.ids.filter((id) => allowedIds.has(id)),
    };

    const projection = deriveActivityView(scopedList, defaultRowState, statuses);
    expect(projection.rows.map((row) => row.id)).toEqual([SessionId("remote-unread")]);
    expect(projection.unreadSessionIds).toEqual([SessionId("remote-unread")]);
  });
});
