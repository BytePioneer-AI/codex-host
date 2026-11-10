/** Search the shared Thread catalog and insert the same reference as sidebar drag. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { workspaceTitleOf } from "@deepseek-ai/dsh-util-workspace-path";
import {
  THREAD_REFERENCE_SOURCE,
  threadReferenceInsert,
  threadReferenceOf,
} from "@deepseek-ai/dsh-client-ui-conversation/thread-reference";
import type {} from "@deepseek-ai/dsh-client-ui-input-trigger/client";

export function supportsThreadReferences(ctx: Context, id: SessionId): boolean {
  const row = ctx.sessions.list.getSnapshot().byId[id];
  return (
    row !== undefined &&
    ctx.sessions.subagentAddress(id) === undefined &&
    (threadReferenceOf(row) !== undefined ||
      (row.blank && row.projectionValues?.harnessIdentity != null))
  );
}

export function registerThreadReferenceDiscovery(ctx: Context): void {
  const t = ctx.locale.bind("codexhostImport");
  const openings = new WeakMap<object, Promise<void>>();
  const supported = (id: SessionId) => supportsThreadReferences(ctx, id);
  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "@",
        aliases: ["#"],
        name: THREAD_REFERENCE_SOURCE,
        launcher: "command",
        order: 25,
        showGroupTitle: false,
        codec: { clipboardText: (ref) => ref, serialize: async (ref) => ref },
        subscribeCandidates: (_, listener) => {
          const sessionsOff = ctx.sessions.list.subscribe(listener);
          const workspacesOff = ctx.workspaces.list.subscribe(listener);
          return () => {
            sessionsOff();
            workspacesOff();
          };
        },
        candidates: async ({ sessionId }, req) => {
          if (!supported(sessionId)) return [];
          // A query refinement shares one full catalog refresh, without opening any history.
          let refresh = req.menuEpoch === undefined ? undefined : openings.get(req.menuEpoch);
          if (refresh === undefined) {
            refresh = ctx.sessions.refresh();
            if (req.menuEpoch !== undefined) openings.set(req.menuEpoch, refresh);
          }
          await refresh;
          req.signal.throwIfAborted();
          if (!supported(sessionId)) return [];
          const list = ctx.sessions.list.getSnapshot();
          const workspaces = ctx.workspaces.list.getSnapshot();
          const archived = new Set(workspaces.archivedSessionIds);
          const labels = new Map<SessionId, string>();
          for (const workspace of workspaces.items)
            for (const id of workspace.sessionIds)
              if (!labels.has(id)) labels.set(id, workspace.title);
          const query = req.query.trim().toLowerCase();
          return list.ids
            .flatMap((id) => {
              const row = list.byId[id];
              if (row === undefined || id === sessionId || archived.has(id)) return [];
              const reference = threadReferenceOf(row);
              if (reference === undefined) return [];
              const workspace =
                labels.get(id) ?? (workspaceTitleOf(row.cwd ?? "") || row.cwd || "");
              if (
                !reference.title.toLowerCase().includes(query) &&
                !workspace.toLowerCase().includes(query)
              )
                return [];
              return [{ id, reference, workspace, updatedAt: row.updatedAt }];
            })
            .sort(
              (a, b) =>
                b.updatedAt - a.updatedAt ||
                a.reference.threadId.localeCompare(b.reference.threadId),
            )
            .slice(0, query === "" ? 5 : undefined)
            .map(({ id, reference, workspace }) => ({
              name: id,
              label: reference.title,
              value: id,
              showAlias: false,
              section: t("discovery.sessions"),
              description: [workspace, reference.threadId].filter(Boolean).join(" · "),
              icon: "session" as const,
            }));
        },
        onPick: (pick) => {
          const id = pick.candidate.value as SessionId | undefined;
          if (id === undefined) return "handled";
          const list = ctx.sessions.list.getSnapshot();
          const row = !list.ids.includes(id) ? undefined : list.byId[id];
          const reference = row === undefined ? undefined : threadReferenceOf(row);
          if (
            !supported(pick.session.sessionId) ||
            reference === undefined ||
            id === pick.session.sessionId ||
            ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(id)
          )
            return "handled";
          return { insert: threadReferenceInsert(reference) };
        },
      }),
    "ui-codexhost: Thread reference discovery",
  );
}
