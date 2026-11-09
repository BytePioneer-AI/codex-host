/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
import { defineStore, type EngineStoreHandle } from "@deepseek-ai/dsh-client-store";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { reconcileManualOrder, type ArchivedFilter, type SessionRowState } from "./tree.ts";

/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = "__flat_session_order__";

/** Sidebar sections above the tree: they fold independently of the tree's own groups. */
export const PINNED_SECTION_KEY = "pinned";
export const WORKSPACES_SECTION_KEY = "workspaces";

/** Session-list grouping mode: sibling Workspace sections, a Workspace tree, or one flat list. */
export type SessionGroupBy = "workspace" | "workspace-tree" | "flat";
/** Session order: saved manual positions or current recency. */
export type SessionOrderBy = "manual" | "updated";

/** Workspace browser viewing state persisted across surface remounts and reloads. */
type WorkspaceViewState = {
  groupBy: SessionGroupBy;
  orderBy: SessionOrderBy;
  /** Explicit group expansion keyed by Workspace identity, including descendants in tree mode. */
  groupExpansion: Record<string, boolean>;
  /**
   * Section folds above the tree, keyed by section. A missing entry shows the
   * section, which also covers views persisted before sections could fold.
   */
  sectionExpansion?: Record<string, boolean>;
  /** Saved manual order per Workspace group plus the browser-local flat-list account. */
  sessionOrderByAccount: Record<string, string[]>;
  /** Archived-row visibility for the current page; page startup resets it to 'default'. */
  archivedFilter?: ArchivedFilter;
};

/**
 * Read one section's fold state.
 * @param expansion - persisted section folds, when the view carries them.
 * @param key - section key.
 * @returns whether the section shows its rows.
 */
export function sectionExpanded(
  expansion: Readonly<Record<string, boolean>> | undefined,
  key: string,
): boolean {
  return expansion?.[key] ?? true;
}

type SessionOrderSource = {
  members: Readonly<Record<string, readonly SessionId[]>>;
  summaries: SessionListState["byId"];
  rowState: Pick<SessionRowState, "pinnedSessionIds" | "archivedSessionIds">;
};

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: SessionGroupBy) => void;
  setOrderBy: (
    draft: WorkspaceViewState,
    mode: SessionOrderBy,
    initialOrders: Readonly<Record<string, readonly string[]>>,
    source: SessionOrderSource,
  ) => void;
  setGroupExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void;
  setSectionExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void;
  retainAccountKeys: (draft: WorkspaceViewState, workspaceKeys: readonly string[]) => void;
  syncSessionOrders: (
    draft: WorkspaceViewState,
    orders: Readonly<Record<string, readonly string[]>>,
    source: SessionOrderSource,
  ) => void;
  setSessionOrder: (
    draft: WorkspaceViewState,
    accountKey: string,
    order: readonly string[],
    initialOrders: Readonly<Record<string, readonly string[]>>,
    source: SessionOrderSource,
  ) => void;
  pinSessionOrder: (
    draft: WorkspaceViewState,
    sessionId: string,
    accountKeys: readonly string[],
    source: SessionOrderSource,
  ) => void;
  setArchivedFilter: (draft: WorkspaceViewState, filter: ArchivedFilter) => void;
};

/** Preserve unresolved saved slots across scoped lists, without rendering or discovering them. */
function copySessionOrders(
  orders: Readonly<Record<string, readonly string[]>>,
  saved: Readonly<Record<string, readonly string[]>>,
  source: SessionOrderSource,
): Record<string, string[]> {
  const known = new Map(Object.entries(source.summaries));
  const accounts = new Map<string, string>();
  for (const [key, members] of Object.entries(source.members)) {
    if (key === FLAT_SESSION_ORDER_KEY) continue;
    for (const id of members) accounts.set(id, key);
  }
  return Object.fromEntries(
    Object.entries(orders).map(([key, order]) => {
      const retained = [...order];
      const first = order[0] === undefined ? undefined : known.get(order[0]);
      // The selected blank remains first when its first prompt ends blank pinning.
      let insertion = first?.blank && (first.retainedBy.mainView ?? 0) > 0 ? 1 : 0;
      for (const id of saved[key] ?? []) {
        const index = retained.indexOf(id);
        if (index !== -1) insertion = index + 1;
        else if (
          !known.has(id) &&
          (key === FLAT_SESSION_ORDER_KEY || !accounts.has(id) || accounts.get(id) === key)
        ) {
          retained.splice(insertion++, 0, id);
        }
      }
      return [key, retained];
    }),
  );
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<
  WorkspaceViewState,
  WorkspaceViewActions
> {
  return defineStore({
    init: (): WorkspaceViewState => ({
      groupBy: "workspace",
      orderBy: "updated",
      groupExpansion: {},
      sectionExpansion: {},
      sessionOrderByAccount: {},
      archivedFilter: "default",
    }),
    persist: "dsh.workspace.view.v5",
    actions: {
      setGroupBy: (d, mode: SessionGroupBy) => {
        d.groupBy = mode;
      },
      setOrderBy: (d, mode: SessionOrderBy, initialOrders, source) => {
        if (mode === d.orderBy) return;
        d.sessionOrderByAccount =
          mode === "manual"
            ? copySessionOrders(initialOrders, d.sessionOrderByAccount, source)
            : {};
        d.orderBy = mode;
      },
      setGroupExpanded: (d, key: string, expanded: boolean) => {
        d.groupExpansion[key] = expanded;
      },
      setSectionExpanded: (d, key: string, expanded: boolean) => {
        d.sectionExpansion = { ...d.sectionExpansion, [key]: expanded };
      },
      retainAccountKeys: (d, workspaceKeys: readonly string[]) => {
        const retained = new Set(workspaceKeys);
        d.groupExpansion = Object.fromEntries(
          Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)),
        );
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)),
        );
        delete (d as WorkspaceViewState & { sessionUpdatedAtByAccount?: unknown })
          .sessionUpdatedAtByAccount;
      },
      syncSessionOrders: (d, orders, source) => {
        if (d.orderBy !== "manual") return;
        Object.assign(
          d.sessionOrderByAccount,
          copySessionOrders(orders, d.sessionOrderByAccount, source),
        );
      },
      setSessionOrder: (d, accountKey, order, initialOrders, source) => {
        const orders = copySessionOrders(
          { ...initialOrders, [accountKey]: order },
          d.sessionOrderByAccount,
          source,
        );
        if (d.orderBy === "updated") d.sessionOrderByAccount = orders;
        else Object.assign(d.sessionOrderByAccount, orders);
        d.orderBy = "manual";
      },
      pinSessionOrder: (d, sessionId, accountKeys, source) => {
        const selected = new Set(accountKeys);
        const orders = copySessionOrders(
          Object.fromEntries(
            Object.entries(source.members).map(([key, members]) => [
              key,
              reconcileManualOrder(
                members,
                d.sessionOrderByAccount[key],
                source.summaries,
                source.rowState,
              ),
            ]),
          ),
          d.sessionOrderByAccount,
          source,
        );
        for (const key of selected) {
          if (orders[key] !== undefined)
            orders[key] = [sessionId, ...orders[key].filter((id) => id !== sessionId)];
        }
        // Groups absent from this scoped catalog may contain only unloaded archives.
        Object.assign(d.sessionOrderByAccount, orders);
      },
      setArchivedFilter: (d, filter: ArchivedFilter) => {
        d.archivedFilter = filter;
      },
    },
  });
}

/** The bound write set of one viewing-store instance (what the UiWorkspace service drives). */
export type WorkspaceViewStoreActions = ReturnType<
  ReturnType<typeof createWorkspaceViewStore>["create"]
>["actions"];
