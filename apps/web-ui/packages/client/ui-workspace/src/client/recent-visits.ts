/** Small visit-only working set; cache hints never own selection, history or Session references. */
import type {
  ISessions,
  SessionListState,
  SessionTarget,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import {
  boundVisits,
  OTHER_VISIT_LIMIT,
  RecentVisitCache,
  VISIT_MAX_AGE_MS,
  type RecentVisit,
} from "./recent-visit-cache.ts";

export type { RecentVisit } from "./recent-visit-cache.ts";

export class RecentVisits {
  /** Only current-Host-confirmed records reach presentation. */
  readonly entries = createSnapshotStore<readonly RecentVisit[]>([]);
  private records: readonly RecentVisit[] = [];
  private current: RecentVisit | undefined;
  private awaitingFormalSession = false;
  private active = false;
  private headRevision = 0;
  private readonly loading = new Set<SessionId>();
  private readonly cache: RecentVisitCache;

  constructor(
    private readonly sessions: ISessions,
    private readonly workspaces: IWorkspaces,
    private readonly subscribeRemoved?: (listener: (id: SessionId) => void) => () => void,
    onStorageFailure: () => void = () => {},
  ) {
    this.cache = new RecentVisitCache(onStorageFailure);
  }

  start(selectedId?: SessionId): () => void {
    this.active = true;
    this.headRevision = this.sessions.list.getSnapshot().headRefreshRevision ?? 0;
    // Selection restoration remains navigation's responsibility, including its own summary load.
    this.records = this.cache
      .read()
      .filter((entry) => entry.sessionId !== selectedId)
      .slice(0, OTHER_VISIT_LIMIT);
    this.cache.update([], selectedId);
    const stopSessions = this.sessions.list.subscribe(() => {
      const revision = this.sessions.list.getSnapshot().headRefreshRevision ?? 0;
      if (revision !== this.headRevision) {
        this.headRevision = revision;
        this.expire();
        this.cache.update([], this.current?.sessionId);
        this.restoreSummaries();
      }
      this.reconcile();
    });
    const stopWorkspaces = this.workspaces.list.subscribe(() => this.reconcile());
    const stopRemoved = this.subscribeRemoved?.((id) => {
      // Withdrawing a subagent's live Agent is not deleting its readable history.
      if (
        this.sessions.subagentAddress(id) !== undefined ||
        this.sessions.list.getSnapshot().byId[id]?.origin === "subagent" ||
        this.records.some((entry) => entry.sessionId === id && typeof entry.target !== "string")
      )
        return;
      this.records = this.records.filter((entry) => !this.includesIdentity(entry, id));
      this.cache.update([], this.current?.sessionId, (entry) => this.includesIdentity(entry, id));
      this.publish();
    });
    this.reconcile();
    this.restoreSummaries();
    return () => {
      this.active = false;
      stopSessions();
      stopWorkspaces();
      stopRemoved?.();
      this.current = undefined;
      this.awaitingFormalSession = false;
      this.records = [];
      this.entries.set([]);
      // Disposal is not a visit or deletion and never clears the origin cache.
    };
  }

  /** Called only at accepted navigation commit; also renew the previous actual selection on departure. */
  visit(sessionId: SessionId, target: SessionTarget): void {
    const now = Date.now();
    const departed = this.depart(now);
    if (departed !== undefined) this.remember(departed);
    this.current = {
      sessionId,
      target:
        typeof target === "string" ? (this.sessions.subagentAddress(sessionId) ?? target) : target,
      lastVisitedAt: now,
    };
    this.awaitingFormalSession = true;
    this.expire(now);
    this.reconcile(departed === undefined ? [] : [departed]);
  }

  clearCurrent(): void {
    const departed = this.depart(Date.now());
    if (departed !== undefined) this.remember(departed);
    this.current = undefined;
    this.awaitingFormalSession = false;
    this.expire();
    this.reconcile(departed === undefined ? [] : [departed]);
  }

  private depart(now: number): RecentVisit | undefined {
    const current = this.current;
    return current !== undefined && this.formal(current)
      ? { ...current, lastVisitedAt: now }
      : undefined;
  }

  private remember(entry: RecentVisit): void {
    this.records = [
      entry,
      ...this.records.filter((previous) => previous.sessionId !== entry.sessionId),
    ];
  }

  private expire(now = Date.now()): void {
    this.records = this.records.filter(
      (entry) =>
        entry.sessionId === this.current?.sessionId ||
        (entry.lastVisitedAt <= now && now - entry.lastVisitedAt < VISIT_MAX_AGE_MS),
    );
  }

  private formal(entry: RecentVisit): boolean {
    const list = this.sessions.list.getSnapshot();
    return list.byId[entry.sessionId]?.blank === false && !this.invalid(entry, list);
  }

  private reconcile(visits: readonly RecentVisit[] = []): void {
    if (!this.active) return;
    const list = this.sessions.list.getSnapshot();
    const removed = new Set(
      this.records.filter((entry) => this.invalid(entry, list)).map((entry) => entry.sessionId),
    );
    this.records = this.records.filter((entry) => !removed.has(entry.sessionId));
    const mutations = [...visits];
    const current = this.current;
    if (this.awaitingFormalSession && current !== undefined && this.formal(current)) {
      this.awaitingFormalSession = false;
      this.remember(current);
      mutations.unshift(current);
    }
    this.publish();
    if (mutations.length > 0 || removed.size > 0)
      this.cache.update(mutations, current?.sessionId, (entry) => removed.has(entry.sessionId));
  }

  private publish(): void {
    this.records = boundVisits(this.records, this.current?.sessionId);
    const list = this.sessions.list.getSnapshot();
    const workspaceReady = this.workspaces.list.getSnapshot().phase === "ready";
    const confirmed = this.records.flatMap((entry) => {
      if (
        !workspaceReady ||
        list.byId[entry.sessionId]?.blank !== false ||
        this.invalid(entry, list)
      )
        return [];
      if (typeof entry.target === "string") return [entry];
      // A structurally valid saved address is only a hint; require the current Host's loaded catalog route.
      const actual = this.sessions.subagentAddress(entry.sessionId);
      if (
        actual === undefined ||
        actual.parentSessionId !== entry.target.parentSessionId ||
        actual.childSessionId !== entry.sessionId
      )
        return [];
      if (actual.mode === entry.target.mode) return [entry];
      const canonical = { ...entry, target: actual };
      this.records = this.records.map((previous) => (previous === entry ? canonical : previous));
      return [canonical];
    });
    const previous = this.entries.getSnapshot();
    if (
      confirmed.length !== previous.length ||
      confirmed.some((entry, index) => entry !== previous[index])
    )
      this.entries.set(confirmed);
  }

  /** At most the six restored working-set IDs; no page walks, history opening or recursive child discovery. */
  private restoreSummaries(): void {
    for (const entry of this.records
      .filter((record) => record.sessionId !== this.current?.sessionId)
      .slice(0, OTHER_VISIT_LIMIT)) {
      const id = entry.sessionId;
      if (this.sessions.list.getSnapshot().byId[id] !== undefined || this.loading.has(id)) continue;
      this.loading.add(id);
      void this.sessions
        .loadSummary(id)
        .catch(() => {
          // A failed lookup is not deletion evidence; a later head refresh may retry it.
        })
        .finally(() => {
          this.loading.delete(id);
          if (this.active) this.reconcile();
        });
    }
  }

  private includesIdentity(entry: RecentVisit, id: SessionId): boolean {
    if (entry.sessionId === id) return true;
    if (typeof entry.target === "string") return false;
    const seen = new Set<SessionId>();
    let parent: SessionId | undefined = entry.target.parentSessionId;
    while (parent !== undefined && !seen.has(parent)) {
      if (parent === id) return true;
      seen.add(parent);
      parent = this.sessions.subagentAddress(parent)?.parentSessionId;
    }
    return false;
  }

  private invalid(entry: RecentVisit, list: SessionListState): boolean {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds;
    const removed = (id: SessionId): boolean =>
      archived.includes(id) || this.sessions.binding(id)?.session.getSnapshot().removed === true;
    if (removed(entry.sessionId)) return true;
    // Page omissions, pending directories and unresolved summaries prove nothing.
    if (typeof entry.target === "string") return false;
    const seen = new Set<SessionId>([entry.sessionId]);
    let address = entry.target;
    while (!seen.has(address.parentSessionId)) {
      if (
        removed(address.parentSessionId) ||
        catalogRemovedChild(list, address.parentSessionId, address.childSessionId)
      )
        return true;
      seen.add(address.parentSessionId);
      const parent = this.sessions.subagentAddress(address.parentSessionId);
      if (parent === undefined) break;
      address = parent;
    }
    return false;
  }
}

function catalogRemovedChild(list: SessionListState, parent: SessionId, child: SessionId): boolean {
  const catalog = list.projectionsBySession[parent];
  return (
    list.phase === "ready" &&
    catalog?.state !== "loading" &&
    catalog?.state !== "error" &&
    catalog?.values.subagentCatalog !== undefined &&
    !catalog.values.subagentCatalog.some((entry) => entry.id === child)
  );
}
