/** Placement writes use the Web RPC; its catalog push remains the row authority. */
import type { Context } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { RowToast } from "../contract/slots.ts";
import type { WorkspaceViewStoreActions } from "../stores.ts";
import { threadAncestors } from "../thread-tree.ts";
import { threadTreeParentOf } from "../tree.ts";
import {
  PlaceSessionDialog,
  PlaceSessionMenuItems,
  type PlaceSessionInjected,
} from "./PlaceSession.tsx";

export function registerThreadPlacement(
  ctx: Context,
  sessions: ISessions,
  view: WorkspaceViewStoreActions,
  notify: (toast: RowToast) => void,
): PlaceSessionInjected["placeSession"] {
  const request = createSnapshotStore<SessionId | null>(null);
  const injected = (): PlaceSessionInjected => ({
    hooks: { placementRequest: request },
    requestPlacement: (id) => request.set(id),
    closePlacement: () => request.set(null),
    placeSession: async (sessionId, parentSessionId) => {
      try {
        const connection = ctx.get("connection") as ConnectionHandle;
        const result = await connection.rpc.call("/api", "session/place", {
          args: { request: { sessionId, parentSessionId } },
        });
        if (!result.ok) throw new Error(result.error.message);
        // The RPC publishes its catalog delta; a fallback read must not delay or reject the write.
        void sessions.refresh().catch(() => undefined);
        if (parentSessionId !== null) {
          const list = sessions.list.getSnapshot();
          const ancestors = threadAncestors(parentSessionId, (id) => {
            const summary = list.byId[SessionId(id)];
            return summary === undefined ? null : threadTreeParentOf(summary);
          });
          view.setThreadsExpanded([parentSessionId, ...ancestors], true);
        }
        request.set(null);
        return true;
      } catch (reason) {
        notify({
          kind: "placeFailed",
          message: reason instanceof Error ? reason.message : String(reason),
        });
        return false;
      }
    },
  });
  const placeSession = injected().placeSession;
  ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
    ctx.slots.register(
      {
        name: "sidebar.workspaces.session.menu.item",
        id: "thread-placement",
        order: 375,
        locale: "workspace",
        inject: injected,
      },
      PlaceSessionMenuItems,
    ),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "workspace.thread-placement",
        locale: "workspace",
        inject: injected,
      },
      PlaceSessionDialog,
    ),
  );
  return placeSession;
}
