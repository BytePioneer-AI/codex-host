/** Browser-root data retention, independent of mounted Session views. */
import type {
  ISessions,
  SessionBinding,
  SessionReference,
  SessionTarget,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { IWorkspaces } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap {
    /** Live data only; does not mark a Session as viewed. */
    backgroundWarm: unknown;
  }
}

interface HeldSession {
  readonly reference: SessionReference;
  readonly binding: SessionBinding;
}

/** One background reference per running catalog Session or bounded recent visit/completion. */
export class SessionKeepalive {
  private readonly held = new Map<SessionId, HeldSession>();
  private readonly recent = new Map<SessionId, SessionTarget>();
  private running = new Set<SessionId>();
  /** Invalid bindings and rejected acquisitions stay suppressed until leaving the targets or a visit. */
  private readonly failed = new Set<SessionId>();
  private active = false;
  private reconciling = false;
  private dirty = false;

  constructor(
    private readonly sessions: ISessions,
    private readonly workspaces: IWorkspaces,
  ) {}

  start(): () => void {
    this.active = true;
    const stopSessions = this.sessions.list.subscribe(() => this.reconcile());
    const stopWorkspaces = this.workspaces.list.subscribe(() => this.reconcile());
    this.reconcile();
    return () => {
      this.active = false;
      stopSessions();
      stopWorkspaces();
      const held = [...this.held.values()];
      this.held.clear();
      this.recent.clear();
      this.running.clear();
      this.failed.clear();
      for (const { reference } of held) reference.release();
    };
  }

  /** Called only after accepted navigation, before releasing the previous main-view reference. */
  visit(reference: SessionReference, target: SessionTarget): void {
    if (!this.active) return;
    this.failed.delete(reference.sessionId);
    this.remember(
      reference.sessionId,
      typeof target === "string"
        ? (this.sessions.subagentAddress(reference.sessionId) ?? target)
        : target,
    );
    this.reconcile();
  }

  private remember(id: SessionId, target: SessionTarget): void {
    this.recent.delete(id);
    this.recent.set(id, target);
  }

  private reconcile(): void {
    if (!this.active) return;
    // retain/release publish list changes synchronously, before retain returns its handle.
    this.dirty = true;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      while (this.dirty && this.active) {
        this.dirty = false;
        this.update();
      }
    } finally {
      this.reconciling = false;
    }
  }

  private update(): void {
    const list = this.sessions.list.getSnapshot();
    const catalog = new Set(list.ids);
    const summaryOnly = new Set(list.summaryOnlyIds ?? []);
    const archived = new Set(this.workspaces.list.getSnapshot().archivedSessionIds);
    const running = new Set<SessionId>();
    for (const id of list.ids) {
      const row = list.byId[id];
      // Child catalogs and metadata-only lookups do not discover new history subscriptions.
      if (
        row?.running &&
        row.origin !== "subagent" &&
        !archived.has(id) &&
        (!summaryOnly.has(id) || this.recent.has(id))
      )
        running.add(id);
    }
    if (list.phase === "pending") {
      for (const id of this.running) if (!archived.has(id)) running.add(id);
    } else {
      for (const id of this.running) {
        if (!running.has(id) && catalog.has(id) && !archived.has(id)) this.remember(id, id);
      }
    }
    this.running = running;

    for (const [id, target] of this.recent) {
      if (
        archived.has(id) ||
        this.sessions.binding(id)?.session.getSnapshot().removed ||
        (list.phase === "ready" && !catalog.has(id) && typeof target === "string")
      )
        this.recent.delete(id);
    }
    // Running Sessions never consume one of the eight stopped warm slots, including the main view.
    const stopped = [...this.recent.keys()].filter((id) => !running.has(id));
    for (const id of stopped.slice(0, Math.max(0, stopped.length - 8))) this.recent.delete(id);
    const targets = new Map(this.recent);
    for (const id of running) targets.set(id, id);
    for (const id of this.failed) if (!targets.has(id)) this.failed.delete(id);

    for (const [id, held] of this.held) {
      const invalid = this.sessions.binding(id) !== held.binding;
      if (!targets.has(id) || invalid) {
        this.held.delete(id);
        if (invalid) {
          this.recent.delete(id);
          this.failed.add(id);
        }
        held.reference.release();
      }
    }
    for (const [id, target] of targets) {
      if (this.held.has(id) || this.failed.has(id)) continue;
      let reference: SessionReference | undefined;
      try {
        reference = this.sessions.retain(target, { source: "backgroundWarm" });
        const held = { reference, binding: reference.binding };
        this.held.set(id, held);
        // Session.open records sync failures in its snapshot. Keep that valid generation
        // for the Controller's reconnect resync; release rejected acquisition waiters only.
        void reference.ready.catch(() => this.fail(id, held));
      } catch {
        this.failed.add(id);
        reference?.release();
      }
    }
  }

  private fail(id: SessionId, held: HeldSession): void {
    if (!this.active || this.held.get(id) !== held) return;
    this.failed.add(id);
    this.held.delete(id);
    held.reference.release();
  }
}
