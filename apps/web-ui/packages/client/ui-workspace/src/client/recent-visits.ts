/** Stable open-tab order; cache hints never own selection, history or Session references. */
import type {
  ISessions,
  SessionListState,
  SessionTarget,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionStatusSnapshot } from "@deepseek-ai/dsh-client-ui-session/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { RecentVisitCache, type RecentVisit } from "./recent-visit-cache.ts";
import { sessionActivity } from "./tree.ts";

export type { RecentVisit } from "./recent-visit-cache.ts";

export class RecentVisits {
  /** Only current-Host-confirmed records reach presentation. */
  readonly entries = createSnapshotStore<readonly RecentVisit[]>([]);
  private records: readonly RecentVisit[] = [];
  private current: RecentVisit | undefined;
  private awaitingFormalSession = false;
  private active = false;
  private headRevision = 0;
  private restoring = false;
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
    this.records = this.cache.read();
    this.cache.update([]);
    const stopSessions = this.sessions.list.subscribe(() => {
      const revision = this.sessions.list.getSnapshot().headRefreshRevision ?? 0;
      if (revision !== this.headRevision) {
        this.headRevision = revision;
        this.restoreSummaries(this.current?.sessionId ?? selectedId);
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
      this.cache.update([], (entry) => this.includesIdentity(entry, id));
      this.publish();
    });
    this.reconcile();
    this.restoreSummaries(selectedId);
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

  /** Only an accepted open can add a tab; revisiting updates its target without moving it. */
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
    this.reconcile(departed === undefined ? [] : [departed]);
  }

  clearCurrent(): void {
    const departed = this.depart(Date.now());
    if (departed !== undefined) this.remember(departed);
    this.current = undefined;
    this.awaitingFormalSession = false;
    this.reconcile(departed === undefined ? [] : [departed]);
  }

  private depart(now: number): RecentVisit | undefined {
    const current = this.current;
    // A closed tab must not be reinserted by the subsequent selection teardown.
    return current !== undefined &&
      this.records.some((entry) => entry.sessionId === current.sessionId) &&
      this.formal(current)
      ? { ...current, lastVisitedAt: now }
      : undefined;
  }

  /** Remove only the navigation entry, never the Session or its running resources. */
  close(sessionId: SessionId): void {
    this.records = this.records.filter((entry) => entry.sessionId !== sessionId);
    this.cache.update([], (entry) => entry.sessionId === sessionId);
    if (this.current?.sessionId === sessionId) this.awaitingFormalSession = false;
    this.publish();
  }

  /** Expiry only removes idle UI entries, using existing metadata and genuine interaction status. */
  expireInactive(timeoutMs: number, statuses: SessionStatusSnapshot, now = Date.now()): boolean {
    const list = this.sessions.list.getSnapshot();
    if (
      !this.active ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      list.phase !== "ready" ||
      list.loading === true ||
      list.listError != null ||
      this.workspaces.list.getSnapshot().phase !== "ready"
    )
      return false;
    const confirmed = new Set(this.entries.getSnapshot().map((entry) => entry.sessionId));
    const expired = (entry: RecentVisit): boolean => {
      const summary = list.byId[entry.sessionId];
      if (
        entry.sessionId === this.current?.sessionId ||
        !confirmed.has(entry.sessionId) ||
        summary === undefined ||
        summary.blank ||
        (summary.retainedBy.mainView ?? 0) > 0 ||
        summary.running ||
        statuses.get(entry.sessionId)?.pendingInteraction !== undefined ||
        (typeof entry.target !== "string" &&
          statuses.get(entry.sessionId)?.running === undefined) ||
        !Number.isFinite(summary.updatedAt)
      )
        return false;
      const activity = sessionActivity(summary, list, statuses);
      if (activity.running || activity.runningSubagentCount > 0) return false;
      return now - Math.max(entry.lastVisitedAt, summary.updatedAt) >= timeoutMs;
    };
    const removed = new Set(this.records.filter(expired).map((entry) => entry.sessionId));
    if (removed.size === 0) return false;
    this.records = this.records.filter((entry) => !removed.has(entry.sessionId));
    // Recheck the latest stored visit so another browser tab's fresh open is not erased.
    this.cache.update([], (entry) => removed.has(entry.sessionId) && expired(entry));
    this.publish();
    return true;
  }

  private remember(entry: RecentVisit): void {
    const index = this.records.findIndex((previous) => previous.sessionId === entry.sessionId);
    if (index === -1) {
      this.records = [...this.records, entry];
    } else {
      this.records = this.records.map((previous, position) =>
        position === index ? entry : previous,
      );
    }
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
    const mutations: RecentVisit[] = [...visits];
    const current = this.current;
    if (this.awaitingFormalSession && current !== undefined && this.formal(current)) {
      this.awaitingFormalSession = false;
      this.remember(current);
      mutations.push(current);
    }
    this.publish();
    if (mutations.length > 0 || removed.size > 0)
      this.cache.update(mutations, (entry) => removed.has(entry.sessionId));
  }

  private publish(): void {
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

  /** Restore metadata with bounded concurrency; never open history or recursively discover children. */
  private restoreSummaries(selectedId = this.current?.sessionId): void {
    if (this.restoring) return;
    const pending = this.records.filter(
      (entry) =>
        entry.sessionId !== selectedId &&
        this.sessions.list.getSnapshot().byId[entry.sessionId] === undefined,
    );
    if (pending.length === 0) return;
    this.restoring = true;
    let index = 0;
    const load = async (): Promise<void> => {
      while (this.active) {
        const entry = pending[index++];
        if (entry === undefined) return;
        const id = entry.sessionId;
        if (
          !this.records.some((entry) => entry.sessionId === id) ||
          this.sessions.list.getSnapshot().byId[id] !== undefined
        )
          continue;
        try {
          await this.sessions.loadSummary(id);
        } catch {
          // A failed lookup is not deletion evidence; a later head refresh may retry it.
        }
        if (this.active) this.reconcile();
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, load)).finally(() => {
      this.restoring = false;
    });
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
