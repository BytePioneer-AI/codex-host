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
  /** The in-flight usage load for `view`. */
  usage?: UsageLoad;
  usageReadAt?: number;
  historyReadAt?: number;
  /** Harness confirmed as owner by the last catalog or create. */
  harnessId?: string;
  /** First sequence a rebuilt journal may use. */
  viewOrigin?: number;
}

/**
 * Deleting, invalidating or superseding a Thread's view, and replacing the Host
 * generation, each touch one place. The catalog rows (replaced as a whole by each
 * directory read) and unsent drafts (not Host Threads yet) have other lifecycles
 * and stay in `ChSessions`.
 */
export class WebThreadStates {
  private readonly states = new Map<string, WebThreadState>();

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

  /** The view's history was rewritten: drop it and what was derived from it. An
   * in-flight `reading` settles on its own. */
  discardView(id: string, view: ChThreadHistory): void {
    this.retire(id, view);
    const state = this.ensure(id);
    delete state.view;
    delete state.historyReadAt;
    delete state.controls;
    delete state.usage;
    delete state.usageReadAt;
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
