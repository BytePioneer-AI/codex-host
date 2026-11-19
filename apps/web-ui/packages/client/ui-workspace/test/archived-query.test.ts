import { afterEach, expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionManager } from "../../../api/session-controller/src/client/sessions/manager.ts";
import type { SessionRemotes } from "../../../api/session-controller/src/client/sessions/remotes.ts";
import { pinOrderSource } from "../src/client/pin-order.ts";
import { createWorkspaceViewStore, FLAT_SESSION_ORDER_KEY } from "../src/client/stores.ts";
import {
  reconcileManualOrder,
  sessionMemberIds,
  UNGROUPED_KEY,
  visibleSessionIds,
} from "../src/client/tree.ts";

afterEach(() => vi.unstubAllGlobals());

const active = SessionId("active");
const archived = SessionId("archived");
const deleted = SessionId("deleted");
const summary = (id: SessionId) => ({
  id,
  displayTitle: id,
  running: false,
  blank: false,
  updatedAt: 1,
  retainedBy: {},
});
const list = (): SessionListState => ({
  ids: [active],
  byId: { [active]: summary(active) },
  phase: "ready",
  projectionsBySession: {},
});
const rowState = { pinnedSessionIds: [active], archivedSessionIds: [archived] };

it("retains unloaded archive order slots in flat/Ungrouped pin writes, not known departures", () => {
  const snapshot = list();
  snapshot.byId[deleted] = summary(deleted);
  const members = sessionMemberIds(snapshot, [archived]);
  const saved = [archived, deleted, active];
  expect(reconcileManualOrder(members, saved, snapshot.byId, rowState)).toEqual([archived, active]);
  const view = createWorkspaceViewStore().create();
  view.actions.setOrderBy(
    "manual",
    {
      [FLAT_SESSION_ORDER_KEY]: saved,
      [UNGROUPED_KEY]: saved,
    },
    pinOrderSource([], snapshot, rowState),
  );
  view.actions.pinSessionOrder(
    active,
    [FLAT_SESSION_ORDER_KEY, UNGROUPED_KEY],
    pinOrderSource([], snapshot, rowState),
  );
  expect(view.getSnapshot().sessionOrderByAccount).toEqual({
    [FLAT_SESSION_ORDER_KEY]: [active, archived],
    [UNGROUPED_KEY]: [active, archived],
  });
  for (const filter of ["show", "only", "default"] as const) view.actions.setArchivedFilter(filter);
  expect(view.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual([
    active,
    archived,
  ]);
  expect(visibleSessionIds(snapshot, [archived], "show")).toEqual([active]);
  expect(snapshot.byId[archived]).toBeUndefined();
});

it.each(["pin", "move", "sync", "manual"] as const)(
  "preserves undiscovered saved slots on %s writes without leaking known foreign membership",
  (operation) => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const cold = SessionId("native-archive-not-yet-discovered");
    const moved = SessionId("known-in-another-group-without-a-summary");
    const other = SessionId("other-active");
    const snapshot = list();
    snapshot.ids.push(other);
    snapshot.byId[other] = summary(other);
    const source = {
      members: {
        groupA: [active, other],
        groupB: [moved],
        [UNGROUPED_KEY]: [],
        [FLAT_SESSION_ORDER_KEY]: [active, other],
      },
      summaries: snapshot.byId,
      rowState: { pinnedSessionIds: [], archivedSessionIds: [] },
    };
    const saved = {
      groupA: [cold, moved, active, other],
      groupB: [],
      unloadedGroup: [SessionId("another-undiscovered-archive")],
      [UNGROUPED_KEY]: [cold, moved],
      [FLAT_SESSION_ORDER_KEY]: [cold, moved, active, other],
    };
    const handle = createWorkspaceViewStore();
    storage.set(
      "dsh.workspace.view.v5",
      JSON.stringify({
        ...handle.spec.init(),
        orderBy: operation === "manual" ? "updated" : "manual",
        sessionOrderByAccount: saved,
      }),
    );
    const view = handle.create();
    const renderedOrders = Object.fromEntries(
      Object.entries(source.members).map(([key, members]) => [
        key,
        reconcileManualOrder(
          members,
          saved[key as keyof typeof saved],
          snapshot.byId,
          source.rowState,
        ),
      ]),
    );
    expect(renderedOrders.groupA).toEqual([active, other]);
    if (operation === "pin")
      view.actions.pinSessionOrder(active, ["groupA", FLAT_SESSION_ORDER_KEY], source);
    else if (operation === "move")
      view.actions.setSessionOrder("groupA", [other, active], renderedOrders, source);
    else if (operation === "manual") view.actions.setOrderBy("manual", renderedOrders, source);
    else view.actions.syncSessionOrders(renderedOrders, source);
    const orders = view.getSnapshot().sessionOrderByAccount;
    expect(orders.groupA).toEqual(
      operation === "pin"
        ? [active, cold, other]
        : operation === "move"
          ? [cold, other, active]
          : [cold, active, other],
    );
    expect(orders[UNGROUPED_KEY]).toEqual([cold]);
    expect(orders[FLAT_SESSION_ORDER_KEY]).toContain(cold);
    expect(orders[FLAT_SESSION_ORDER_KEY]).toContain(moved);
    expect(orders.groupB).toEqual([]);
    if (operation !== "manual") expect(orders.unloadedGroup).toEqual(saved.unloadedGroup);
    expect(visibleSessionIds(snapshot, [], "show")).toEqual([active, other]);
    const persisted = JSON.parse(storage.get("dsh.workspace.view.v5") ?? "null");
    expect(persisted.sessionOrderByAccount).toEqual(orders);
    snapshot.byId[cold] = summary(cold);
    expect(reconcileManualOrder([active, other, cold], orders.groupA, snapshot.byId)).toEqual(
      orders.groupA,
    );
  },
);

it("keeps the selected blank first when syncing orders with unresolved saved slots", () => {
  const cold = SessionId("undiscovered");
  const snapshot = list();
  snapshot.byId[active] = { ...summary(active), blank: true, retainedBy: { mainView: 1 } };
  const source = pinOrderSource([], snapshot, { pinnedSessionIds: [], archivedSessionIds: [] });
  const view = createWorkspaceViewStore().create();
  view.actions.setOrderBy("manual", { [FLAT_SESSION_ORDER_KEY]: [cold, active] }, source);
  view.actions.syncSessionOrders({ [FLAT_SESSION_ORDER_KEY]: [active] }, source);
  expect(view.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual([active, cold]);
});

it("filters background archived upserts by each browser's choice without removing the summary", async () => {
  const manager = new SessionManager({
    session: {
      list: async () => ({ ok: true, value: { items: [], archivedSessionIds: [archived] } }),
    },
  } as unknown as SessionRemotes);
  await manager.refreshList();
  manager.handleSessionAdded({
    sessionId: archived,
    agentAvailable: true,
    blank: false,
    running: true,
    updatedAt: 1,
  });
  const snapshot = list();
  for (const row of manager.getListSnapshot().items) {
    snapshot.ids.push(row.sessionId);
    snapshot.byId[row.sessionId] = { ...summary(row.sessionId), running: row.running };
  }
  const hidden = createWorkspaceViewStore().create();
  const shown = createWorkspaceViewStore().create();
  shown.actions.setArchivedFilter("show");
  expect(hidden.getSnapshot().archivedFilter).toBe("default");
  expect(
    visibleSessionIds(snapshot, [archived], hidden.getSnapshot().archivedFilter ?? "default"),
  ).toEqual([active]);
  expect(
    visibleSessionIds(snapshot, [archived], shown.getSnapshot().archivedFilter ?? "default"),
  ).toEqual([active, archived]);
  expect(visibleSessionIds(snapshot, [archived], "only")).toEqual([archived]);
  await manager.refreshList();
  expect(manager.getListSnapshot().items.map((row) => row.sessionId)).toEqual([archived]);
  expect(manager.getListSnapshot().items[0]?.running).toBe(true);
  await manager.dispose();
});
