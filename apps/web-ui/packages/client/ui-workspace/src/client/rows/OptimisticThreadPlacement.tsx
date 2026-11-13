/** Sidebar-only projection; writes are queued so older RPCs cannot overwrite newer gestures. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { pinOrderSource } from "../pin-order.ts";
import { threadAncestors } from "../thread-tree.ts";
import { threadTreeParentOf } from "../tree.ts";
import {
  applyPlacements,
  applyPlacementOrder,
  applyPlacementOrders,
  confirmPlacements,
  settlePlacement,
  type OptimisticPlacement,
  type PlacementOrder,
} from "../thread-placement-optimistic.ts";

type Place = (
  id: SessionId,
  parent: SessionId | null,
  order?: PlacementOrder,
  write?: boolean,
) => Promise<boolean>;
const PlacementContext = createContext<Place>(async () => false);
export const useOptimisticThreadPlacement = () => useContext(PlacementContext);

export function OptimisticThreadPlacementProvider({
  browser,
  children,
}: {
  browser: WorkspaceBrowserProps;
  children: (browser: WorkspaceBrowserProps) => ReactNode;
}) {
  const catalog = browser.useSessions((state) => state);
  const store = browser.useStore((state) => state);
  const workspaces = browser.useWorkspaces((state) => state);
  const [pending, setPending] = useState<readonly OptimisticPlacement[]>([]);
  const journal = useRef(pending);
  const token = useRef(0);
  const queue = useRef(Promise.resolve());
  const latest = useRef({ catalog, store, workspaces, browser });
  latest.current = { catalog, store, workspaces, browser };
  const publish = useCallback((next: readonly OptimisticPlacement[]) => {
    journal.current = next;
    setPending(next);
  }, []);
  useEffect(() => {
    const next = confirmPlacements(journal.current, catalog);
    if (next !== journal.current) publish(next);
  }, [catalog, pending, publish]);

  const place = useCallback<Place>(
    (id, parent, order, write = true) => {
      const operation: OptimisticPlacement = {
        token: ++token.current,
        id,
        parent,
        order,
        acknowledged: false,
      };
      publish([...journal.current, operation]);
      if (parent !== null) {
        const list = applyPlacements(latest.current.catalog, journal.current);
        latest.current.browser.actions.setThreadsExpanded(
          [
            parent,
            ...threadAncestors(parent, (key) => {
              const row = list.byId[SessionId(key)];
              return row ? threadTreeParentOf(row) : null;
            }),
          ],
          true,
        );
      }
      const result = queue.current.then(async () => {
        let ok = false;
        try {
          const needsWrite =
            write || latest.current.catalog.byId[id]?.projectionValues?.threadTreeParent !== parent;
          ok = !needsWrite || (await latest.current.browser.placeSession(id, parent));
          if (ok && order) {
            const { store, catalog, workspaces, browser } = latest.current;
            const next = applyPlacementOrder(store.sessionOrderByAccount, order, id);
            const source = pinOrderSource(workspaces.items, applyPlacements(catalog, [operation]), {
              pinnedSessionIds: workspaces.pinnedSessionIds,
              archivedSessionIds: workspaces.archivedSessionIds,
              archivedFilter: store.archivedFilter ?? "default",
            });
            browser.actions.setSessionOrder(
              order.account,
              next,
              {},
              {
                ...source,
                members: { ...source.members, [order.account]: next },
              },
            );
          }
          return ok;
        } finally {
          publish(settlePlacement(journal.current, operation.token, ok));
        }
      });
      queue.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [publish],
  );

  const list = useMemo(() => applyPlacements(catalog, pending), [catalog, pending]);
  const view = useMemo(
    () => ({
      ...store,
      sessionOrderByAccount: applyPlacementOrders(store.sessionOrderByAccount, pending),
    }),
    [store, pending],
  );
  const useSessions = useCallback<WorkspaceBrowserProps["useSessions"]>(
    (select) => select(list),
    [list],
  );
  const useStore = useCallback<WorkspaceBrowserProps["useStore"]>((select) => select(view), [view]);
  const projected = useMemo(
    () => ({ ...browser, useSessions, useStore }),
    [browser, useSessions, useStore],
  );
  return <PlacementContext.Provider value={place}>{children(projected)}</PlacementContext.Provider>;
}
