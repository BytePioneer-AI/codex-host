/** Cross-session bounded LRU image URL cache shared by Conversation targets. */
import type { Context } from "@deepseek-ai/cordis";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { bytesToBase64 } from "@deepseek-ai/dsh-util-crypto";

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const WEB_IMAGE_PREFIX = "web-image:";

/** Memory budget configuration for the shared browser image URL cache. */
export interface HistoricalImageCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

/** Locally uploaded image bytes indexed for immediate post-send transcript reuse. */
export interface UploadedImageCacheEntry {
  readonly attachmentId: string;
  readonly blob: Blob;
  readonly name?: string;
  readonly bytes?: number;
}

interface CacheRecord {
  readonly url: string;
  readonly bytes: number;
  readonly keys: Set<string>;
  readonly leafKeys: Set<string>;
  readonly nameBytesKeys: Set<string>;
  readonly pendingNameKeys: Set<string>;
}

/**
 * Resolve durable Conversation images into browser URLs with a cross-session
 * bounded LRU budget. Entries survive background Session eviction and reuse
 * locally uploaded image blobs without re-fetching over RPC.
 */
export class HistoricalImageCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly lru = new Set<CacheRecord>();
  private readonly byKey = new Map<string, CacheRecord>();
  private readonly byLeaf = new Map<string, CacheRecord>();
  private readonly byNameBytes = new Map<string, Set<CacheRecord>>();
  private readonly byPendingName = new Map<string, Set<CacheRecord>>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly urls = new Set<string>();
  private totalBytes = 0;
  private disposed = false;

  /**
   * @param ctx - Owning ui-conversation fiber.
   * @param sessions - Session Controller object layer.
   * @param options - Optional LRU entry and byte budget overrides.
   */
  constructor(
    ctx: Context,
    private readonly sessions: ISessions,
    options: HistoricalImageCacheOptions = {},
  ) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
    ctx.effect(
      () => () => {
        this.dispose();
      },
      "ui-conversation historical image cache",
    );
  }

  /**
   * Resolve and cache one session-authorized image URL.
   * @param sessionId - Session authorization scope.
   * @param attachment - Durable image reference.
   * @returns browser URL valid while retained in the bounded LRU cache.
   */
  resolve(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("ui-conversation image cache is disposed"));
    const binding = this.sessions.binding(sessionId);
    if (binding === undefined) {
      return Promise.reject(new Error(`ui-conversation: unknown session "${sessionId}"`));
    }
    const existing = this.lookup(sessionId, attachment, true);
    if (existing !== undefined) return Promise.resolve(existing.url);

    const key = cacheKey(sessionId, attachment.attachmentId);
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;

    const load = binding.session
      .readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
        if (this.disposed) {
          throw new Error("ui-conversation image cache was disposed before loading completed");
        }
        const alreadyCached = this.byKey.get(key);
        if (alreadyCached !== undefined) {
          this.touch(alreadyCached);
          return alreadyCached.url;
        }
        let url: string;
        if (typeof URL.createObjectURL !== "function") {
          url = `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`;
        } else {
          const bytes = Uint8Array.from(result.value.data);
          url = URL.createObjectURL(
            new Blob([bytes.buffer], { type: result.value.attachment.mediaType }),
          );
        }
        const size = normalizeBytes(result.value.data.byteLength);
        const record = this.insertRecord(key, url, size);
        return record.url;
      })
      .finally(() => {
        if (this.inflight.get(key) === load) this.inflight.delete(key);
      });

    this.inflight.set(key, load);
    return load;
  }

  /**
   * Return an already-displayable URL without starting a read.
   * @param sessionId - Session authorization scope.
   * @param attachment - Durable image reference.
   * @returns cached browser URL when present.
   */
  peek(sessionId: SessionId, attachment: ImageAttachmentRef): string | undefined {
    if (this.disposed || this.sessions.binding(sessionId) === undefined) return undefined;
    return this.lookup(sessionId, attachment, true)?.url;
  }

  /**
   * Store a locally uploaded image Blob in the shared LRU cache before the
   * user message is even observed, indexed by both exact `attachmentId` and
   * session-scoped fallback keys for remote peer placeholder refs.
   */
  cacheUploaded(sessionId: SessionId, uploaded: UploadedImageCacheEntry): boolean {
    if (this.disposed || this.sessions.binding(sessionId) === undefined) return false;
    if (typeof URL.createObjectURL !== "function") return false;
    const key = cacheKey(sessionId, uploaded.attachmentId);
    const bytes = normalizeBytes(uploaded.bytes ?? uploaded.blob.size);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      this.touch(existing);
      this.indexUploadedFallbacks(sessionId, uploaded.attachmentId, uploaded.name, bytes, existing);
      return true;
    }
    const url = URL.createObjectURL(uploaded.blob);
    const record = this.insertRecord(key, url, bytes);
    this.indexUploadedFallbacks(sessionId, uploaded.attachmentId, uploaded.name, bytes, record);
    return true;
  }

  /**
   * Bind an observed durable reference to an already-cached uploaded record so
   * remote peer placeholder IDs share the local Blob URL without re-fetching.
   */
  aliasUploaded(
    sessionId: SessionId,
    uploadedAttachmentId: string,
    target: ImageAttachmentRef,
  ): boolean {
    if (this.disposed || this.sessions.binding(sessionId) === undefined) return false;
    const source = this.byKey.get(cacheKey(sessionId, uploadedAttachmentId));
    if (source === undefined) return false;
    this.bindKey(cacheKey(sessionId, target.attachmentId), source);
    this.clearPendingNameIndexes(source);
    this.touch(source);
    return true;
  }

  /**
   * Remove pending-name fallback matching for a discarded draft upload so a
   * later upload with the same filename in this session remains unambiguous.
   */
  clearPendingUploaded(sessionId: SessionId, uploadedAttachmentId: string): void {
    if (this.disposed) return;
    const record = this.byKey.get(cacheKey(sessionId, uploadedAttachmentId));
    if (record !== undefined) this.clearPendingNameIndexes(record);
  }

  /**
   * Adopt a ready browser URL for an admitted image reference directly into the
   * shared LRU cache without triggering a canonical RPC re-download.
   * @param sessionId - Session authorization scope.
   * @param attachment - Durable image reference the URL displays.
   * @param url - browser URL to adopt.
   * @param bytes - optional byte size of the backing image for LRU accounting.
   * @returns whether the cache took URL ownership.
   */
  seed(sessionId: SessionId, attachment: ImageAttachmentRef, url: string, bytes?: number): boolean {
    if (this.disposed || this.sessions.binding(sessionId) === undefined) return false;
    const key = cacheKey(sessionId, attachment.attachmentId);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      this.touch(existing);
      return false;
    }
    const size = normalizeBytes(bytes ?? attachment.bytes);
    this.insertRecord(key, url, size);
    return true;
  }

  private lookup(
    sessionId: SessionId,
    attachment: ImageAttachmentRef,
    bindOnFallback: boolean,
  ): CacheRecord | undefined {
    const key = cacheKey(sessionId, attachment.attachmentId);
    const direct = this.byKey.get(key);
    if (direct !== undefined) {
      this.touch(direct);
      return direct;
    }
    const fallback = this.findUploadedFallback(sessionId, attachment);
    if (fallback === undefined) return undefined;
    if (bindOnFallback) {
      this.bindKey(key, fallback.record);
      if (fallback.consumedPendingName) this.clearPendingNameIndexes(fallback.record);
    }
    this.touch(fallback.record);
    return fallback.record;
  }

  private findUploadedFallback(
    sessionId: SessionId,
    attachment: ImageAttachmentRef,
  ): { readonly record: CacheRecord; readonly consumedPendingName: boolean } | undefined {
    const name = attachment.name;
    if (name === undefined || name === "") return undefined;

    const leafHit = this.byLeaf.get(fallbackLeafKey(sessionId, name));
    if (leafHit !== undefined) {
      return { record: leafHit, consumedPendingName: true };
    }

    const bytes = normalizeBytes(attachment.bytes);
    if (bytes > 0) {
      const candidates = this.byNameBytes.get(fallbackNameBytesKey(sessionId, name, bytes));
      const unique = singleRecord(candidates);
      if (unique !== undefined) {
        return { record: unique, consumedPendingName: true };
      }
    }

    // Remote peer placeholders carry bytes === 0 until fetched; match only an
    // unambiguous unconsumed upload with the same filename in this session.
    if (bytes === 0) {
      const candidates = this.byPendingName.get(fallbackPendingNameKey(sessionId, name));
      const unique = singleRecord(candidates);
      if (unique !== undefined) {
        return { record: unique, consumedPendingName: true };
      }
    }

    return undefined;
  }

  private indexUploadedFallbacks(
    sessionId: SessionId,
    attachmentId: string,
    name: string | undefined,
    bytes: number,
    record: CacheRecord,
  ): void {
    if (attachmentId.startsWith(WEB_IMAGE_PREFIX)) {
      const leaf = attachmentId.slice(WEB_IMAGE_PREFIX.length);
      if (leaf !== "") {
        const leafKey = fallbackLeafKey(sessionId, leaf);
        this.byLeaf.set(leafKey, record);
        record.leafKeys.add(leafKey);
      }
    }
    if (name !== undefined && name !== "") {
      if (bytes > 0) {
        const nameBytesKey = fallbackNameBytesKey(sessionId, name, bytes);
        addIndexedRecord(this.byNameBytes, nameBytesKey, record);
        record.nameBytesKeys.add(nameBytesKey);
      }
      const pendingKey = fallbackPendingNameKey(sessionId, name);
      addIndexedRecord(this.byPendingName, pendingKey, record);
      record.pendingNameKeys.add(pendingKey);
    }
  }

  private insertRecord(key: string, url: string, bytes: number): CacheRecord {
    const record: CacheRecord = {
      url,
      bytes,
      keys: new Set([key]),
      leafKeys: new Set(),
      nameBytesKeys: new Set(),
      pendingNameKeys: new Set(),
    };
    this.urls.add(url);
    this.byKey.set(key, record);
    this.lru.add(record);
    this.totalBytes += bytes;
    this.enforceBudget(record);
    return record;
  }

  private bindKey(key: string, record: CacheRecord): void {
    const existing = this.byKey.get(key);
    if (existing === record) return;
    if (existing !== undefined) {
      existing.keys.delete(key);
      if (existing.keys.size === 0) this.deleteRecord(existing);
    }
    this.byKey.set(key, record);
    record.keys.add(key);
  }

  private touch(record: CacheRecord): void {
    if (!this.lru.delete(record)) return;
    this.lru.add(record);
  }

  private enforceBudget(protectedRecord?: CacheRecord): void {
    for (const candidate of this.lru) {
      if (this.lru.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      if (candidate === protectedRecord) continue;
      this.deleteRecord(candidate);
    }
  }

  private clearPendingNameIndexes(record: CacheRecord): void {
    for (const key of record.pendingNameKeys) {
      removeIndexedRecord(this.byPendingName, key, record);
    }
    record.pendingNameKeys.clear();
  }

  private deleteRecord(record: CacheRecord): void {
    if (!this.lru.delete(record)) return;
    this.totalBytes = Math.max(0, this.totalBytes - record.bytes);
    for (const key of record.keys) {
      if (this.byKey.get(key) === record) this.byKey.delete(key);
    }
    record.keys.clear();
    for (const key of record.leafKeys) {
      if (this.byLeaf.get(key) === record) this.byLeaf.delete(key);
    }
    record.leafKeys.clear();
    for (const key of record.nameBytesKeys) {
      removeIndexedRecord(this.byNameBytes, key, record);
    }
    record.nameBytesKeys.clear();
    this.clearPendingNameIndexes(record);
    this.releaseUrl(record.url);
  }

  private releaseUrl(url: string): void {
    if (!this.urls.delete(url)) return;
    revokeUrl(url);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inflight.clear();
    for (const url of this.urls) revokeUrl(url);
    this.urls.clear();
    this.lru.clear();
    this.byKey.clear();
    this.byLeaf.clear();
    this.byNameBytes.clear();
    this.byPendingName.clear();
    this.totalBytes = 0;
  }
}

function cacheKey(sessionId: SessionId, attachmentId: string): string {
  return `${sessionId}\0${attachmentId}`;
}

function fallbackLeafKey(sessionId: SessionId, leaf: string): string {
  return `${sessionId}\0${leaf}`;
}

function fallbackNameBytesKey(sessionId: SessionId, name: string, bytes: number): string {
  return `${sessionId}\0${bytes}\0${name}`;
}

function fallbackPendingNameKey(sessionId: SessionId, name: string): string {
  return `${sessionId}\0${name}`;
}

function normalizeBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function addIndexedRecord(
  index: Map<string, Set<CacheRecord>>,
  key: string,
  record: CacheRecord,
): void {
  let set = index.get(key);
  if (set === undefined) {
    set = new Set();
    index.set(key, set);
  }
  set.add(record);
}

function removeIndexedRecord(
  index: Map<string, Set<CacheRecord>>,
  key: string,
  record: CacheRecord,
): void {
  const set = index.get(key);
  if (set === undefined) return;
  set.delete(record);
  if (set.size === 0) index.delete(key);
}

function singleRecord(set: ReadonlySet<CacheRecord> | undefined): CacheRecord | undefined {
  if (set === undefined || set.size !== 1) return undefined;
  return set.values().next().value;
}

function revokeUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
