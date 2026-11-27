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

const EMPTY_QUERY_THREAD_LIMIT = 5;
/** Maximum matching Threads rendered for non-empty queries to bound menu DOM size. */
export const NON_EMPTY_QUERY_THREAD_LIMIT = 25;

interface IndexedThreadReference {
  readonly id: SessionId;
  readonly title: string;
  readonly titleLower: string;
  readonly workspace: string;
  readonly workspaceLower: string;
  readonly threadId: string;
  readonly updatedAt: number;
}

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
  type SessionsSnapshot = ReturnType<typeof ctx.sessions.list.getSnapshot>;
  type WorkspacesSnapshot = ReturnType<typeof ctx.workspaces.list.getSnapshot>;
  let cachedWorkspaces: WorkspacesSnapshot | undefined;
  let cachedArchived: ReadonlySet<SessionId> = new Set();
  let cachedLabels: ReadonlyMap<SessionId, string> = new Map();
  let cachedList: SessionsSnapshot | undefined;
  let cachedIndexWorkspaces: WorkspacesSnapshot | undefined;
  let cachedIndex: readonly IndexedThreadReference[] = [];

  const workspaceMetaOf = (workspaces: WorkspacesSnapshot) => {
    if (cachedWorkspaces !== workspaces) {
      cachedWorkspaces = workspaces;
      cachedArchived = new Set(workspaces.archivedSessionIds);
      const labels = new Map<SessionId, string>();
      for (const workspace of workspaces.items)
        for (const id of workspace.sessionIds) if (!labels.has(id)) labels.set(id, workspace.title);
      cachedLabels = labels;
    }
    return { archived: cachedArchived, labels: cachedLabels };
  };

  const threadIndexOf = (
    list: SessionsSnapshot,
    workspaces: WorkspacesSnapshot,
  ): readonly IndexedThreadReference[] => {
    if (cachedList === list && cachedIndexWorkspaces === workspaces) return cachedIndex;
    const { archived, labels } = workspaceMetaOf(workspaces);
    const entries: IndexedThreadReference[] = [];
    for (const id of list.ids) {
      const row = list.byId[id];
      if (row === undefined || archived.has(id)) continue;
      const reference = threadReferenceOf(row);
      if (reference === undefined) continue;
      const workspace = labels.get(id) ?? (workspaceTitleOf(row.cwd ?? "") || row.cwd || "");
      entries.push({
        id,
        title: reference.title,
        titleLower: reference.title.toLowerCase(),
        workspace,
        workspaceLower: workspace.toLowerCase(),
        threadId: reference.threadId,
        updatedAt: row.updatedAt,
      });
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId));
    cachedList = list;
    cachedIndexWorkspaces = workspaces;
    cachedIndex = entries;
    return entries;
  };

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
          const index = threadIndexOf(list, workspaces);
          const query = req.query.trim().toLowerCase();
          const limit = query === "" ? EMPTY_QUERY_THREAD_LIMIT : NON_EMPTY_QUERY_THREAD_LIMIT;
          const section = t("discovery.sessions");
          const rows = [];
          for (const entry of index) {
            if (entry.id === sessionId) continue;
            if (
              query !== "" &&
              !entry.titleLower.includes(query) &&
              !entry.workspaceLower.includes(query)
            )
              continue;
            rows.push({
              name: entry.id,
              label: entry.title,
              value: entry.id,
              showAlias: false,
              section,
              description: entry.workspace,
              icon: "session" as const,
            });
            if (rows.length >= limit) break;
          }
          return rows;
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
