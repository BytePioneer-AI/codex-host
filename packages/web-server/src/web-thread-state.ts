/** Per-Thread Web gateway state, keyed once by canonical Thread id. */
import type { ChThreadHistory } from "./ch-thread-history.ts";

export interface UsageLoad {
  view: ChThreadHistory;
  dirty: boolean;
  operation: Promise<void>;
}

/** Everything the gateway derives for one Thread. All of it is disposable except
 * `viewOrigin`, which outlives views so a rebuilt journal never looks stale. */
export interface WebThreadState {
  /** The memory-only history journal browsers follow. */
  view?: ChThreadHistory;
  /** The in-flight read that produces `view`. */
  reading?: Promise<ChThreadHistory>;
  /** The in-flight model/permission control load for `view`. */
  controls?: Promise<void>;
  /** Confirmed configuration writes supersede reads started at an older revision. */
  configurationRevision?: number;
  /** The in-flight usage load for `view`. */
  usage?: UsageLoad;
  usageReadAt?: number;
  historyReadAt?: number;
  /** Harness confirmed as owner by the last catalog or create. */
  harnessId?: string;
  /** First sequence a rebuilt journal may use. */
  viewOrigin?: number;
}

/** How long a view may go unfollowed before `discardIdleViews` drops it. */
export const IDLE_VIEW_MS = 10 * 60_000;

/**
 * Deleting, invalidating or superseding a Thread's view, and replacing the Host
 * generation, each touch one place. The catalog rows (replaced as a whole by each
 * directory read) and unsent drafts (not Host Threads yet) have other lifecycles
 * and stay in `ChSessions`.
 */
export class WebThreadStates {
  private readonly states = new Map<string, WebThreadState>();
  /** When a periodic check first found each view without a follower. */
  private readonly unfollowedSince = new WeakMap<ChThreadHistory, number>();
  /** Active `session/page` reads holding each view against idle eviction. */
  private readonly paging = new WeakMap<ChThreadHistory, number>();

  get(id: string): WebThreadState | undefined {
    return this.states.get(id);
  }

  ensure(id: string): WebThreadState {
    let state = this.states.get(id);
    if (!state) this.states.set(id, (state = {}));
    return state;
  }

  view(id: string): ChThreadHistory | undefined {
    return this.states.get(id)?.view;
  }

  harnessId(id: string): string | undefined {
    return this.states.get(id)?.harnessId;
  }

  hasHarness(id: string): boolean {
    return this.harnessId(id) !== undefined;
  }

  setHarness(id: string, harnessId: string): void {
    this.ensure(id).harnessId = harnessId;
  }

  /** Live views, in the order their Threads were first tracked. */
  views(): Array<[string, ChThreadHistory]> {
    return [...this.states].flatMap(([id, state]) => (state.view ? [[id, state.view]] : []));
  }

  /** Thread ids whose view was dropped and still have a reserved sequence floor. */
  droppedViewIds(): string[] {
    return [...this.states].flatMap(([id, state]) =>
      !state.view && state.viewOrigin !== undefined ? [id] : [],
    );
  }

  /** Reserve the next sequence below a dropped view's future origin so repeated
   * catalog updates and control reconnects strictly advance past prior watermarks. */
  reserveDroppedProjectionSeq(id: string): number | undefined {
    const state = this.states.get(id);
    if (!state || state.view || state.viewOrigin === undefined) return undefined;
    const seq = state.viewOrigin - 1;
    state.viewOrigin = seq + 2;
    return seq;
  }

  /** Protect an in-flight `session/page` read from idle eviction and refresh
   * `historyReadAt` once it settles on the same live view. */
  async trackPageRead<T>(
    id: string,
    view: ChThreadHistory,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.paging.set(view, (this.paging.get(view) ?? 0) + 1);
    this.unfollowedSince.delete(view);
    try {
      return await operation();
    } finally {
      const remaining = (this.paging.get(view) ?? 1) - 1;
      if (remaining > 0) this.paging.set(view, remaining);
      else this.paging.delete(view);
      const state = this.states.get(id);
      if (state?.view === view) {
        state.historyReadAt = Date.now();
        this.unfollowedSince.delete(view);
      }
    }
  }

  /** The catalog read replaces every confirmed owner at once. */
  replaceHarnesses(next: ReadonlyMap<string, string>): void {
    for (const [id, state] of this.states) {
      if (next.has(id)) continue;
      delete state.harnessId;
      this.prune(id);
    }
    for (const [id, harnessId] of next) this.setHarness(id, harnessId);
  }

  /** Retire a view and reserve sequence space above everything it published. */
  private retire(id: string, view: ChThreadHistory): void {
    view.retire();
    this.ensure(id).viewOrigin = view.log.lastSeq + 2;
  }

  /** The view's history was rewritten, or nobody follows it: drop it and what was
   * derived from it. An in-flight `reading` settles on its own. */
  discardView(id: string, view: ChThreadHistory): void {
    this.retire(id, view);
    const state = this.ensure(id);
    delete state.view;
    delete state.historyReadAt;
    delete state.controls;
    delete state.usage;
    delete state.usageReadAt;
  }

  /** Drop the views that no browser followed at any periodic check, and that nothing
   * read, for `IDLE_VIEW_MS`. Reopening such a Thread reads it as a first open. A
   * view with a read in flight, or whose Thread `running` names, starts over. */
  discardIdleViews(now: number, running: (id: string) => boolean): void {
    for (const [id, state] of this.states) {
      const { view } = state;
      if (!view) continue;
      if (
        view.log.hasFollowers ||
        state.reading ||
        (this.paging.get(view) ?? 0) > 0 ||
        running(id)
      ) {
        this.unfollowedSince.delete(view);
        continue;
      }
      let since = this.unfollowedSince.get(view);
      if (since === undefined) this.unfollowedSince.set(view, (since = now));
      // A follower that came and went between two checks still read the view.
      if (now - Math.max(since, state.historyReadAt ?? 0) >= IDLE_VIEW_MS)
        this.discardView(id, view);
    }
  }

  /** A new Host generation supersedes every view and in-flight read. Confirmed
   * owners remain: the catalog read after reconnect revalidates them. Returns the
   * retired views for the caller to reconnect their followers. */
  newHostGeneration(): ChThreadHistory[] {
    const retired: ChThreadHistory[] = [];
    for (const [id, state] of this.states) {
      const { view } = state;
      delete state.view;
      delete state.reading;
      delete state.controls;
      delete state.usage;
      delete state.usageReadAt;
      delete state.historyReadAt;
      if (view) {
        this.retire(id, view);
        retired.push(view);
      }
    }
    return retired;
  }

  /** Same Host, cursor not replayable: held Turns can no longer be trusted. */
  forgetKnownTurns(): void {
    for (const [, view] of this.views()) view.forgetKnownTurns();
  }

  /** Forget a Thread nothing is tracked for, so unknown ids cannot accumulate. */
  prune(id: string): void {
    const state = this.states.get(id);
    if (state && Object.values(state).every((value) => value === undefined)) this.states.delete(id);
  }
}
