import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { createSnapshotStore, type ObservableSnapshot } from "@deepseek-ai/dsh-client-store";

/** One lock per source session, shared by sidebar placement and Composer reference actions. */
export class SessionMoveLock {
  private readonly store = createSnapshotStore<ReadonlySet<SessionId>>(new Set());
  readonly movingSessionIds: ObservableSnapshot<ReadonlySet<SessionId>> = this.store;

  readonly isMoving = (id: SessionId): boolean => this.movingSessionIds.getSnapshot().has(id);

  tryAcquire(id: SessionId): boolean {
    const current = this.movingSessionIds.getSnapshot();
    if (current.has(id)) return false;
    this.store.set(new Set(current).add(id));
    return true;
  }

  release(id: SessionId): void {
    const next = new Set(this.movingSessionIds.getSnapshot());
    next.delete(id);
    this.store.set(next);
  }
}
