/** Explicit tool-output reads; successful values and concurrent reads share one session-local LRU cache. */
import type { WebToolOutputReference } from "@codexhost/shared-contracts";
import { estimateToolOutputEntryBytes } from "./memory-budget.ts";
import type { SessionRemotes } from "./sessions/remotes.ts";

/** Per-session byte budget for expanded tool outputs (8 MiB). */
export const MAX_TOOL_OUTPUT_CACHE_BYTES = 8 * 1024 * 1024;

export interface ToolOutputCacheOptions {
  readonly maxBytes?: number;
}

export class ToolOutputCache {
  readonly values = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(
    private readonly readRemote: SessionRemotes["session"]["toolOutput"],
    initial?: ReadonlyMap<string, string>,
    options: ToolOutputCacheOptions = {},
  ) {
    this.maxBytes = Math.max(0, options.maxBytes ?? MAX_TOOL_OUTPUT_CACHE_BYTES);
    if (initial !== undefined) {
      for (const [key, value] of initial) {
        this.remember(key, value);
      }
    }
  }

  /** Current estimated byte size of cached tool-output strings. */
  get estimatedBytes(): number {
    return this.totalBytes;
  }

  read(ref: WebToolOutputReference): Promise<string> {
    const key = JSON.stringify([
      ref.sessionId,
      ref.epoch,
      ref.turn,
      ref.seq,
      ref.callId,
      ref.part,
      ref.version,
    ]);
    const held = this.values.get(key);
    if (held !== undefined) {
      // Refresh LRU order on hit without changing totalBytes.
      this.values.delete(key);
      this.values.set(key, held);
      return Promise.resolve(held);
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.readRemote(ref)
      .then((result) => {
        if (!result.ok) throw result.error;
        this.remember(key, result.value.text);
        return result.value.text;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }

  private remember(key: string, value: string): void {
    const existing = this.values.get(key);
    if (existing !== undefined) {
      this.totalBytes -= estimateToolOutputEntryBytes(key, existing);
      this.values.delete(key);
    }
    const bytes = estimateToolOutputEntryBytes(key, value);
    if (bytes > this.maxBytes) return;
    this.values.set(key, value);
    this.totalBytes += bytes;
    while (this.totalBytes > this.maxBytes && this.values.size > 0) {
      const oldest = this.values.entries().next().value as [string, string];
      if (oldest[0] === key) break;
      this.values.delete(oldest[0]);
      this.totalBytes -= estimateToolOutputEntryBytes(oldest[0], oldest[1]);
    }
  }
}
