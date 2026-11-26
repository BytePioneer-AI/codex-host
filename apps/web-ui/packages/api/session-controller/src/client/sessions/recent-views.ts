/** Bounded recently released conversation views; no scopes, streams, or assemblers. */
import type { SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session/types";
import type { SessionHistoryRecord } from "../../types.ts";
import type { SessionEventLikeEntry } from "../contract/events.ts";
import { estimateSessionViewBytes } from "../memory-budget.ts";

/** Maximum number of detached session views retained in page memory. */
export const MAX_RECENT_SESSION_VIEWS = 8;

/** Maximum estimated byte budget across all detached session views (24 MiB). */
export const MAX_RECENT_SESSION_VIEW_BYTES = 24 * 1024 * 1024;

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

export interface RecentSessionViewsOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly estimateBytes?: (view: SessionViewData) => number;
}

interface CachedSessionView {
  readonly view: SessionViewData;
  readonly bytes: number;
}

export class RecentSessionViews {
  private readonly views = new Map<SessionId, CachedSessionView>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly estimateBytes: (view: SessionViewData) => number;
  private cachedBytes = 0;

  constructor(options: RecentSessionViewsOptions = {}) {
    this.maxEntries = Math.max(0, options.maxEntries ?? MAX_RECENT_SESSION_VIEWS);
    this.maxBytes = Math.max(0, options.maxBytes ?? MAX_RECENT_SESSION_VIEW_BYTES);
    this.estimateBytes = options.estimateBytes ?? estimateSessionViewBytes;
  }

  /** Number of cached detached session views. */
  get size(): number {
    return this.views.size;
  }

  /** Sum of estimated bytes across all cached detached session views. */
  get totalBytes(): number {
    return this.cachedBytes;
  }

  take(id: SessionId): SessionViewData | undefined {
    const entry = this.views.get(id);
    if (entry === undefined) return undefined;
    this.views.delete(id);
    this.cachedBytes -= entry.bytes;
    return entry.view;
  }

  /**
   * Cache a detached view under both entry-count and byte budgets.
   * Rejects a single view that exceeds `maxBytes` on its own without disturbing existing entries.
   * @returns evicted session ids (including `id` itself when rejected for exceeding `maxBytes`).
   */
  remember(id: SessionId, view: SessionViewData): SessionId[] {
    const existing = this.views.get(id);
    if (existing !== undefined) {
      this.views.delete(id);
      this.cachedBytes -= existing.bytes;
    }
    const bytes = Math.max(0, this.estimateBytes(view));
    if (this.maxEntries === 0 || bytes > this.maxBytes) {
      return [id];
    }
    this.views.set(id, { view, bytes });
    this.cachedBytes += bytes;
    const evicted: SessionId[] = [];
    while (this.views.size > this.maxEntries || this.cachedBytes > this.maxBytes) {
      const oldest = this.views.entries().next().value as [SessionId, CachedSessionView];
      if (oldest[0] === id) break;
      this.views.delete(oldest[0]);
      this.cachedBytes -= oldest[1].bytes;
      evicted.push(oldest[0]);
    }
    return evicted;
  }

  delete(id: SessionId): void {
    const entry = this.views.get(id);
    if (entry === undefined) return;
    this.views.delete(id);
    this.cachedBytes -= entry.bytes;
  }

  clear(): void {
    this.views.clear();
    this.cachedBytes = 0;
  }
}
