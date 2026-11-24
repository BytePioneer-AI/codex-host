import { useEffect, useState, type ReactNode } from "react";
import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";

type Presentation = NonNullable<HarnessPluginDescriptor["iconStyle"]>;
type Presentations = Record<string, Presentation | null>;
type CatalogEntry = { icons: Presentations; stale: boolean; freshRevision: number };
const pending = new Map<string, Promise<CatalogEntry>>();
const resolved = new Map<string, CatalogEntry>();
const subscribers = new Map<string, Set<() => void>>();
const scheduledRetries = new Map<
  string,
  { attempt: number; timer: ReturnType<typeof setTimeout> | undefined }
>();
const CATALOG_RETRY_DELAYS_MS = [1_500, 3_000, 6_000, 12_000] as const;
const BITMAP_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;

function clearScheduledRetry(url: string): void {
  const state = scheduledRetries.get(url);
  if (!state) return;
  if (state.timer !== undefined) clearTimeout(state.timer);
  scheduledRetries.delete(url);
}

function scheduleCatalogFetch(url: string): void {
  const existing = resolved.get(url);
  if (existing && !existing.stale) {
    clearScheduledRetry(url);
    return;
  }
  const activeSubs = subscribers.get(url);
  if (!activeSubs || activeSubs.size === 0) {
    clearScheduledRetry(url);
    return;
  }
  let state = scheduledRetries.get(url);
  if (!state) {
    state = { attempt: 0, timer: undefined };
    scheduledRetries.set(url, state);
  }
  if (state.timer !== undefined) return;
  // While holding a stale snapshot with active subscribers, keep revalidating at the capped interval
  // until a fresh response lands; hard failures without any snapshot stay bounded.
  const delay = existing?.stale
    ? CATALOG_RETRY_DELAYS_MS[Math.min(state.attempt, CATALOG_RETRY_DELAYS_MS.length - 1)]
    : CATALOG_RETRY_DELAYS_MS[state.attempt];
  if (delay === undefined) return;
  state.attempt += 1;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (!subscribers.get(url)?.size) {
      scheduledRetries.delete(url);
      return;
    }
    void load(url).catch(() => undefined);
  }, delay);
}

function subscribeCatalog(url: string, listener: () => void): () => void {
  let set = subscribers.get(url);
  if (!set) {
    set = new Set();
    subscribers.set(url, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && subscribers.get(url) === set) {
      subscribers.delete(url);
      clearScheduledRetry(url);
    }
  };
}

function notifyCatalog(url: string): void {
  const set = subscribers.get(url);
  if (!set) return;
  for (const listener of [...set]) listener();
}

/** One metadata request per catalog URL, shared by rows and picker entries. */
function load(url: string): Promise<CatalogEntry> {
  const cached = resolved.get(url);
  if (cached && !cached.stale) return Promise.resolve(cached);
  const existing = pending.get(url);
  if (existing) return existing;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const request = fetch(url, {
    credentials: "same-origin",
    cache: cached?.stale ? "no-store" : "default",
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("Icon presentation unavailable");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid icon catalog");
      const stale = response.headers.get("x-codexhost-icon-stale") === "1";
      const prev = resolved.get(url);
      const freshRevision =
        !stale && prev?.stale ? prev.freshRevision + 1 : (prev?.freshRevision ?? 0);
      const entry: CatalogEntry = {
        icons: value as Presentations,
        stale,
        freshRevision,
      };
      resolved.set(url, entry);
      pending.delete(url);
      if (entry.stale) {
        scheduleCatalogFetch(url);
      } else {
        clearScheduledRetry(url);
      }
      notifyCatalog(url);
      return entry;
    })
    .catch((error) => {
      pending.delete(url);
      scheduleCatalogFetch(url);
      throw error;
    })
    .finally(() => clearTimeout(timeout));
  pending.set(url, request);
  return request;
}

/** A display-only consumer of validated plugin presentation data. Never insert
 * plugin SVG markup; render only the contract's path primitives. */
export function RemotePluginIcon({
  id,
  src,
  presentationUrl,
  size,
  className,
  fallback,
}: {
  id: string;
  src: string;
  presentationUrl: string;
  size: number;
  className?: string;
  fallback: ReactNode;
}): ReactNode {
  const [catalog, setCatalog] = useState<{
    url: string;
    icons: Presentations;
    freshRevision: number;
  } | null>(() => {
    const entry = resolved.get(presentationUrl);
    return entry
      ? { url: presentationUrl, icons: entry.icons, freshRevision: entry.freshRevision }
      : null;
  });
  useEffect(() => {
    let active = true;

    const unsubscribe = subscribeCatalog(presentationUrl, () => {
      if (!active) return;
      const entry = resolved.get(presentationUrl);
      if (entry) {
        setCatalog({
          url: presentationUrl,
          icons: entry.icons,
          freshRevision: entry.freshRevision,
        });
      }
    });

    const onOnline = () => {
      const entry = resolved.get(presentationUrl);
      if (!entry || entry.stale) {
        clearScheduledRetry(presentationUrl);
        void load(presentationUrl).catch(() => undefined);
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
    }

    const existing = resolved.get(presentationUrl);
    if (existing) {
      setCatalog({
        url: presentationUrl,
        icons: existing.icons,
        freshRevision: existing.freshRevision,
      });
      if (existing.stale) {
        scheduleCatalogFetch(presentationUrl);
      }
    } else {
      void load(presentationUrl).then(
        (entry) => {
          if (active)
            setCatalog({
              url: presentationUrl,
              icons: entry.icons,
              freshRevision: entry.freshRevision,
            });
        },
        () => {
          if (active) {
            setCatalog((current) => (current?.url === presentationUrl ? current : null));
          }
        },
      );
    }

    return () => {
      active = false;
      unsubscribe();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
    };
  }, [presentationUrl]);
  // Avoid flashing a fixed-black, padded source image while vector metadata loads.
  if (!catalog || catalog.url !== presentationUrl) return fallback;
  const presentation = catalog.icons[id];
  if (presentation?.vector) {
    const { paths, color, viewBox } = presentation.vector;
    return (
      <svg
        className={className}
        viewBox={viewBox}
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
        style={{ fill: color, flex: "none" }}
      >
        {paths.map((path, index) => (
          <path key={index} d={path.d} fillRule={path.fillRule} fill={path.fill} />
        ))}
      </svg>
    );
  }
  const bitmapSrc =
    catalog.freshRevision > 0
      ? `${src}${src.includes("?") ? "&" : "?"}v=${catalog.freshRevision}`
      : src;
  return (
    <BitmapIcon
      key={bitmapSrc}
      src={bitmapSrc}
      size={size}
      className={className}
      presentation={presentation}
      fallback={fallback}
    />
  );
}

function BitmapIcon({
  src,
  size,
  className,
  presentation,
  fallback,
}: {
  src: string;
  size: number;
  className: string | undefined;
  presentation: Presentation | null | undefined;
  fallback: ReactNode;
}): ReactNode {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const delay = BITMAP_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      setAttempt((value) => value + 1);
      setFailed(false);
    }, delay);
    return () => clearTimeout(timer);
  }, [attempt, failed]);
  if (failed) return fallback;
  const imgSrc = attempt === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}r=${attempt}`;
  return (
    <img
      src={imgSrc}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{
        objectFit: "contain",
        flex: "none",
        ...(presentation?.borderRadius === undefined
          ? {}
          : { borderRadius: `${presentation.borderRadius}%` }),
        ...(presentation?.background ? { background: presentation.background } : {}),
        ...(presentation?.paddingRatio
          ? {
              boxSizing: "border-box",
              padding: Math.max(1, Math.round(size * presentation.paddingRatio)),
            }
          : {}),
      }}
      onError={() => setFailed(true)}
    />
  );
}
