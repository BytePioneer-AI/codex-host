import type {
  HOST_EXTENSIONS_RPC,
  HostExtensionCatalogEntry,
  HostExtensionsRpcParams,
  HostExtensionsRpcResult,
} from "@codexhost/shared-contracts";
import { parseSafeExtensionIconUrl } from "./desktop-extensions-shared.js";

export type ReadHostExtensionCatalogIconFn = (
  input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.catalogIcon>,
) => Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.catalogIcon>>;

export interface DesktopCatalogIconLoader {
  readonly isAvailable: () => boolean;
  readonly getCached: (entry: HostExtensionCatalogEntry) => string | undefined;
  readonly load: (entry: HostExtensionCatalogEntry) => Promise<string | null>;
}

const MAX_CACHE_ENTRIES = 200;
const FAILED_RETRY_DELAY_MS = 60_000;

function iconCacheKey(entry: HostExtensionCatalogEntry): string {
  return `${entry.id}@${entry.version}`;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * In-memory cache and single-flight deduplicator for `codexhost/extensions/catalogIcon` RPCs.
 * Keyed by `${id}@${version}` so marketplace cards, community rows, and detail modals share
 * the same proxied `data:` URL without duplicate Host requests.
 */
export function createDesktopCatalogIconLoader(
  getReader: () => ReadHostExtensionCatalogIconFn | undefined,
): DesktopCatalogIconLoader {
  const resolved = new Map<string, string>();
  const failedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<string | null>>();

  return {
    isAvailable: () => typeof getReader() === "function",
    getCached(entry) {
      return resolved.get(iconCacheKey(entry));
    },
    async load(entry) {
      if (!entry.icon) return null;
      const key = iconCacheKey(entry);
      const cached = resolved.get(key);
      if (cached) return cached;

      const lastFailure = failedAt.get(key);
      if (lastFailure !== undefined && Date.now() - lastFailure < FAILED_RETRY_DELAY_MS) {
        return null;
      }

      const existing = inFlight.get(key);
      if (existing) return existing;

      const reader = getReader();
      if (!reader) return null;

      const task = (async (): Promise<string | null> => {
        try {
          const result = await reader({ id: entry.id });
          const dataUrl = `data:${result.mimeType};base64,${result.base64}`;
          const safe = parseSafeExtensionIconUrl(dataUrl);
          if (!safe) {
            setBounded(failedAt, key, Date.now());
            return null;
          }
          failedAt.delete(key);
          setBounded(resolved, key, safe);
          return safe;
        } catch {
          setBounded(failedAt, key, Date.now());
          return null;
        } finally {
          inFlight.delete(key);
        }
      })();

      inFlight.set(key, task);
      return task;
    },
  };
}
