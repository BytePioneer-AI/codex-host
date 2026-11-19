/** Eight recently released conversation views; no scopes, streams, or assemblers. */
import type { SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session/types";
import type { SessionHistoryRecord } from "../../types.ts";
import type { SessionEventLikeEntry } from "../contract/events.ts";

/** Confirmed durable transport state, independent of visible transient Assistant rows. */
export interface SessionJournalCache {
  readonly epoch: string;
  readonly cursor: number;
  readonly records: readonly SessionHistoryRecord[];
  readonly hasMore: boolean;
}

export interface SessionViewData {
  readonly journal?: SessionJournalCache;
  readonly toolOutputs?: ReadonlyMap<string, string>;
  readonly entries: readonly SessionEventLikeEntry[];
  readonly baseSeq: SessionLogOffset;
  readonly hasMore: boolean;
  readonly projections: Readonly<Record<string, unknown>>;
  readonly lastSyncedAt: number;
}

export class RecentSessionViews {
  private readonly views = new Map<SessionId, SessionViewData>();

  take(id: SessionId): SessionViewData | undefined {
    const view = this.views.get(id);
    this.views.delete(id);
    return view;
  }

  remember(id: SessionId, view: SessionViewData): SessionId | undefined {
    this.views.delete(id);
    this.views.set(id, view);
    if (this.views.size <= 8) return;
    const oldest = this.views.keys().next().value as SessionId;
    this.views.delete(oldest);
    return oldest;
  }

  delete(id: SessionId): void {
    this.views.delete(id);
  }

  clear(): void {
    this.views.clear();
  }
}
