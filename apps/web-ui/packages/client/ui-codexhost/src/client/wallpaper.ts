/**
 * Browser-local custom wallpaper controller.
 *
 * Persists the uploaded image Blob and opacity per browser origin (IndexedDB +
 * lightweight localStorage metadata for live opacity sync) without uploading
 * image bytes or mutating Host/server settings.
 */

export const WALLPAPER_DB_NAME = "codexhost.web.wallpaper.v1";
const WALLPAPER_STORE_NAME = "wallpaper";
const WALLPAPER_RECORD_KEY = "current";
export const WALLPAPER_META_STORAGE_KEY = "codexhost.web.wallpaper-meta.v1";
const WALLPAPER_CHANNEL_NAME = "codexhost.web.wallpaper.v1";

export const WALLPAPER_ACTIVE_ATTRIBUTE = "data-codexhost-wallpaper";
export const WALLPAPER_PREVIEWING_ATTRIBUTE = "data-codexhost-wallpaper-previewing";
export const WALLPAPER_LAYER_ATTRIBUTE = "data-codexhost-wallpaper-layer";
export const WALLPAPER_OPACITY_VARIABLE = "--ch-wallpaper-opacity";

export const WALLPAPER_OPACITY_MIN = 0;
export const WALLPAPER_OPACITY_MAX = 100;
export const DEFAULT_WALLPAPER_OPACITY = 25;
export const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024;

export const ACCEPTED_WALLPAPER_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

const ACCEPTED_MIME_SET = new Set<string>(ACCEPTED_WALLPAPER_MIME_TYPES);

export type WallpaperErrorCode =
  "unsupported-storage" | "invalid-format" | "file-too-large" | "decode-failed" | "storage-failed";

export interface WallpaperSnapshot {
  readonly hasImage: boolean;
  readonly imageUrl: string | null;
  readonly name: string | null;
  readonly opacity: number;
  readonly loading: boolean;
  readonly error: WallpaperErrorCode | null;
}

interface StoredWallpaperRecord {
  blob: Blob;
  name: string;
  opacity: number;
  updatedAt: number;
}

interface StoredWallpaperMeta {
  hasImage: boolean;
  opacity: number;
  updatedAt: number;
}

type WallpaperChannelMessage =
  { type: "reload"; updatedAt: number } | { type: "opacity"; opacity: number; updatedAt: number };

function clampOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WALLPAPER_OPACITY;
  const rounded = Math.round(value);
  if (rounded < WALLPAPER_OPACITY_MIN) return WALLPAPER_OPACITY_MIN;
  if (rounded > WALLPAPER_OPACITY_MAX) return WALLPAPER_OPACITY_MAX;
  return rounded;
}

function readMetaStorage(): StoredWallpaperMeta | null {
  try {
    const raw = localStorage.getItem(WALLPAPER_META_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<StoredWallpaperMeta>;
    if (typeof record.hasImage !== "boolean") return null;
    if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) return null;
    return {
      hasImage: record.hasImage,
      opacity: clampOpacity(record.opacity),
      updatedAt: record.updatedAt,
    };
  } catch {
    return null;
  }
}

function writeMetaStorage(meta: StoredWallpaperMeta): void {
  try {
    localStorage.setItem(WALLPAPER_META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // Quota or private-mode restrictions on localStorage do not block IndexedDB.
  }
}

function openWallpaperDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(WALLPAPER_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WALLPAPER_STORE_NAME)) {
        db.createObjectStore(WALLPAPER_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function readStoredWallpaper(): Promise<StoredWallpaperRecord | null> {
  const db = await openWallpaperDb();
  try {
    return await new Promise<StoredWallpaperRecord | null>((resolve, reject) => {
      const tx = db.transaction(WALLPAPER_STORE_NAME, "readonly");
      const req = tx.objectStore(WALLPAPER_STORE_NAME).get(WALLPAPER_RECORD_KEY);
      req.onsuccess = () => {
        const result = req.result as Partial<StoredWallpaperRecord> | undefined;
        if (!result || !(result.blob instanceof Blob) || result.blob.size === 0) {
          resolve(null);
          return;
        }
        resolve({
          blob: result.blob,
          name: typeof result.name === "string" && result.name.trim() !== "" ? result.name : "",
          opacity: clampOpacity(result.opacity),
          updatedAt:
            typeof result.updatedAt === "number" && Number.isFinite(result.updatedAt)
              ? result.updatedAt
              : 0,
        });
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    });
  } finally {
    db.close();
  }
}

async function writeStoredWallpaper(record: StoredWallpaperRecord): Promise<void> {
  const db = await openWallpaperDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WALLPAPER_STORE_NAME, "readwrite");
      tx.objectStore(WALLPAPER_STORE_NAME).put(record, WALLPAPER_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
  } finally {
    db.close();
  }
}

async function deleteStoredWallpaper(): Promise<void> {
  const db = await openWallpaperDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WALLPAPER_STORE_NAME, "readwrite");
      tx.objectStore(WALLPAPER_STORE_NAME).delete(WALLPAPER_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB delete aborted"));
    });
  } finally {
    db.close();
  }
}

async function verifyImageDecodes(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const valid = bitmap.width > 0 && bitmap.height > 0;
      bitmap.close();
      return valid;
    } catch {
      return false;
    }
  }
  if (typeof Image === "undefined") return false;
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
      img.onerror = () => resolve(false);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class WallpaperController {
  private readonly listeners = new Set<() => void>();
  private snapshot: WallpaperSnapshot;
  private objectUrl: string | null = null;
  private activeBlob: Blob | null = null;
  private layerElement: HTMLDivElement | null = null;
  private channel: BroadcastChannel | null = null;
  private opacityFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private opSeq = 0;
  private lastUpdatedAt = 0;
  private disposed = false;

  constructor() {
    const meta = readMetaStorage();
    this.snapshot = Object.freeze({
      hasImage: false,
      imageUrl: null,
      name: null,
      opacity: meta?.opacity ?? DEFAULT_WALLPAPER_OPACITY,
      loading: true,
      error: null,
    });

    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.channel = new BroadcastChannel(WALLPAPER_CHANNEL_NAME);
        this.channel.onmessage = (event: MessageEvent<unknown>) => {
          this.handleChannelMessage(event.data);
        };
      } catch {
        this.channel = null;
      }
    }

    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.handleStorageEvent);
    }

    void this.reloadFromStorage();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): WallpaperSnapshot => this.snapshot;

  async upload(file: File): Promise<boolean> {
    if (this.disposed) return false;
    if (typeof indexedDB === "undefined") {
      this.updateSnapshot({ error: "unsupported-storage", loading: false });
      return false;
    }
    if (!ACCEPTED_MIME_SET.has(file.type)) {
      this.updateSnapshot({ error: "invalid-format", loading: false });
      return false;
    }
    if (file.size === 0 || file.size > MAX_WALLPAPER_BYTES) {
      this.updateSnapshot({
        error: file.size > MAX_WALLPAPER_BYTES ? "file-too-large" : "decode-failed",
        loading: false,
      });
      return false;
    }

    const seq = ++this.opSeq;
    this.updateSnapshot({ loading: true, error: null });

    const decodes = await verifyImageDecodes(file);
    if (this.disposed || seq !== this.opSeq) return false;
    if (!decodes) {
      this.updateSnapshot({ loading: false, error: "decode-failed" });
      return false;
    }

    const nextOpacity =
      this.snapshot.opacity > 0 ? this.snapshot.opacity : DEFAULT_WALLPAPER_OPACITY;
    const updatedAt = this.nextTimestamp();
    const blob = file.slice(0, file.size, file.type);
    const name = file.name.trim();

    try {
      await writeStoredWallpaper({
        blob,
        name,
        opacity: nextOpacity,
        updatedAt,
      });
    } catch {
      if (!this.disposed && seq === this.opSeq) {
        this.updateSnapshot({ loading: false, error: "storage-failed" });
      }
      return false;
    }
    if (this.disposed || seq !== this.opSeq) return false;

    this.clearPendingOpacityFlush();
    this.lastUpdatedAt = updatedAt;
    this.replaceObjectUrl(blob);
    this.updateSnapshot({
      hasImage: true,
      imageUrl: this.objectUrl,
      name: name || null,
      opacity: nextOpacity,
      loading: false,
      error: null,
    });
    this.applyDom();
    writeMetaStorage({ hasImage: true, opacity: nextOpacity, updatedAt });
    this.postChannel({ type: "reload", updatedAt });
    return true;
  }

  setOpacity(value: number): void {
    if (this.disposed) return;
    const opacity = clampOpacity(value);
    if (this.snapshot.opacity === opacity && this.snapshot.error === null) return;
    const updatedAt = this.nextTimestamp();
    this.lastUpdatedAt = updatedAt;
    this.updateSnapshot({ opacity, error: null });
    this.applyDom();
    writeMetaStorage({ hasImage: this.snapshot.hasImage, opacity, updatedAt });
    this.postChannel({ type: "opacity", opacity, updatedAt });

    if (this.snapshot.hasImage && this.activeBlob !== null) {
      this.scheduleOpacityFlush(opacity, updatedAt);
    }
  }

  async remove(): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.opSeq;
    this.clearPendingOpacityFlush();
    this.setPreviewing(false);

    if (typeof indexedDB !== "undefined") {
      try {
        await deleteStoredWallpaper();
      } catch {
        if (!this.disposed && seq === this.opSeq) {
          this.updateSnapshot({ loading: false, error: "storage-failed" });
        }
        return;
      }
    }
    if (this.disposed || seq !== this.opSeq) return;

    const updatedAt = this.nextTimestamp();
    this.lastUpdatedAt = updatedAt;
    this.replaceObjectUrl(null);
    this.updateSnapshot({
      hasImage: false,
      imageUrl: null,
      name: null,
      loading: false,
      error: null,
    });
    this.applyDom();
    writeMetaStorage({ hasImage: false, opacity: this.snapshot.opacity, updatedAt });
    this.postChannel({ type: "reload", updatedAt });
  }

  setPreviewing(previewing: boolean): void {
    if (typeof document === "undefined") return;
    if (!this.disposed && previewing && this.snapshot.hasImage) {
      document.body.setAttribute(WALLPAPER_PREVIEWING_ATTRIBUTE, "");
    } else {
      document.body.removeAttribute(WALLPAPER_PREVIEWING_ATTRIBUTE);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opSeq += 1;
    this.clearPendingOpacityFlush();
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", this.handleStorageEvent);
    }
    this.channel?.close();
    this.channel = null;
    this.replaceObjectUrl(null);
    if (typeof document !== "undefined") {
      document.body.removeAttribute(WALLPAPER_ACTIVE_ATTRIBUTE);
      document.body.removeAttribute(WALLPAPER_PREVIEWING_ATTRIBUTE);
      document.body.style.removeProperty(WALLPAPER_OPACITY_VARIABLE);
    }
    this.layerElement?.remove();
    this.layerElement = null;
    this.listeners.clear();
  }

  private readonly handleStorageEvent = (event: StorageEvent): void => {
    if (this.disposed || event.key !== WALLPAPER_META_STORAGE_KEY) return;
    const meta = readMetaStorage();
    if (!meta || meta.updatedAt <= this.lastUpdatedAt) return;
    if (meta.hasImage !== this.snapshot.hasImage) {
      void this.reloadFromStorage();
      return;
    }
    this.lastUpdatedAt = meta.updatedAt;
    this.updateSnapshot({ opacity: meta.opacity, error: null });
    this.applyDom();
  };

  private handleChannelMessage(data: unknown): void {
    if (this.disposed || typeof data !== "object" || data === null) return;
    const message = data as Partial<WallpaperChannelMessage>;
    if (typeof message.updatedAt !== "number" || message.updatedAt <= this.lastUpdatedAt) return;
    if (message.type === "reload") {
      void this.reloadFromStorage();
      return;
    }
    if (message.type === "opacity") {
      this.lastUpdatedAt = message.updatedAt;
      this.updateSnapshot({ opacity: clampOpacity(message.opacity), error: null });
      this.applyDom();
    }
  }

  private async reloadFromStorage(): Promise<void> {
    if (this.disposed) return;
    if (typeof indexedDB === "undefined") {
      this.updateSnapshot({ loading: false });
      return;
    }
    const seq = ++this.opSeq;
    try {
      const record = await readStoredWallpaper();
      if (this.disposed || seq !== this.opSeq) return;
      const meta = readMetaStorage();
      if (!record) {
        this.replaceObjectUrl(null);
        const opacity = meta?.opacity ?? this.snapshot.opacity;
        this.lastUpdatedAt = Math.max(this.lastUpdatedAt, meta?.updatedAt ?? 0);
        this.updateSnapshot({
          hasImage: false,
          imageUrl: null,
          name: null,
          opacity,
          loading: false,
          error: null,
        });
        this.applyDom();
        return;
      }
      const opacity =
        meta && meta.updatedAt > record.updatedAt ? meta.opacity : clampOpacity(record.opacity);
      this.lastUpdatedAt = Math.max(record.updatedAt, meta?.updatedAt ?? 0);
      this.replaceObjectUrl(record.blob);
      this.updateSnapshot({
        hasImage: true,
        imageUrl: this.objectUrl,
        name: record.name || null,
        opacity,
        loading: false,
        error: null,
      });
      this.applyDom();
    } catch {
      if (!this.disposed && seq === this.opSeq) {
        this.updateSnapshot({ loading: false });
      }
    }
  }

  private scheduleOpacityFlush(opacity: number, updatedAt: number): void {
    this.clearPendingOpacityFlush();
    this.opacityFlushTimer = setTimeout(() => {
      this.opacityFlushTimer = null;
      if (this.disposed || !this.snapshot.hasImage || this.activeBlob === null) return;
      void writeStoredWallpaper({
        blob: this.activeBlob,
        name: this.snapshot.name ?? "",
        opacity,
        updatedAt,
      }).catch(() => {
        // localStorage metadata already holds the latest opacity on this origin.
      });
    }, 150);
  }

  private nextTimestamp(): number {
    return Math.max(Date.now(), this.lastUpdatedAt + 1);
  }

  private clearPendingOpacityFlush(): void {
    if (this.opacityFlushTimer !== null) {
      clearTimeout(this.opacityFlushTimer);
      this.opacityFlushTimer = null;
    }
  }

  private postChannel(message: WallpaperChannelMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // Closed or unavailable BroadcastChannel falls back to storage events.
    }
  }

  private replaceObjectUrl(blob: Blob | null): void {
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.activeBlob = blob;
    if (blob !== null && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      this.objectUrl = URL.createObjectURL(blob);
    }
  }

  private applyDom(): void {
    if (typeof document === "undefined" || this.disposed) return;
    const body = document.body;
    const { hasImage, imageUrl, opacity } = this.snapshot;

    if (!hasImage || imageUrl === null) {
      body.removeAttribute(WALLPAPER_ACTIVE_ATTRIBUTE);
      body.removeAttribute(WALLPAPER_PREVIEWING_ATTRIBUTE);
      body.style.removeProperty(WALLPAPER_OPACITY_VARIABLE);
      this.layerElement?.remove();
      this.layerElement = null;
      return;
    }

    if (this.layerElement === null) {
      const layer = document.createElement("div");
      layer.setAttribute(WALLPAPER_LAYER_ATTRIBUTE, "");
      layer.setAttribute("aria-hidden", "true");
      this.layerElement = layer;
    }
    this.layerElement.style.backgroundImage = `url(${JSON.stringify(imageUrl)})`;
    if (!this.layerElement.isConnected) {
      body.prepend(this.layerElement);
    }

    body.style.setProperty(WALLPAPER_OPACITY_VARIABLE, String(opacity / 100));
    if (opacity > 0) {
      body.setAttribute(WALLPAPER_ACTIVE_ATTRIBUTE, "");
    } else {
      body.removeAttribute(WALLPAPER_ACTIVE_ATTRIBUTE);
    }
  }

  private updateSnapshot(patch: Partial<WallpaperSnapshot>): void {
    const next: WallpaperSnapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
    });
    if (
      next.hasImage === this.snapshot.hasImage &&
      next.imageUrl === this.snapshot.imageUrl &&
      next.name === this.snapshot.name &&
      next.opacity === this.snapshot.opacity &&
      next.loading === this.snapshot.loading &&
      next.error === this.snapshot.error
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
