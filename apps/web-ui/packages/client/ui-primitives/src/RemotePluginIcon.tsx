import { useEffect, useState, type ReactNode } from "react";
import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";

type Presentation = NonNullable<HarnessPluginDescriptor["iconStyle"]>;
type Presentations = Record<string, Presentation | null>;
const pending = new Map<string, Promise<Presentations>>();
const resolved = new Map<string, Presentations>();
const subscribers = new Map<string, Set<() => void>>();
const CATALOG_RETRY_DELAYS_MS = [1_500, 3_000, 6_000, 12_000] as const;
const BITMAP_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;

function subscribeCatalog(url: string, listener: () => void): () => void {
  let set = subscribers.get(url);
  if (!set) {
    set = new Set();
    subscribers.set(url, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && subscribers.get(url) === set) subscribers.delete(url);
  };
}

function notifyCatalog(url: string): void {
  const set = subscribers.get(url);
  if (!set) return;
  for (const listener of [...set]) listener();
}

/** One metadata request per catalog URL, shared by rows and picker entries. */
function load(url: string): Promise<Presentations> {
  const cached = resolved.get(url);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(url);
  if (existing) return existing;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const request = fetch(url, { credentials: "same-origin", signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error("Icon presentation unavailable");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid icon catalog");
      const icons = value as Presentations;
      resolved.set(url, icons);
      pending.delete(url);
      notifyCatalog(url);
      return icons;
    })
    .catch((error) => {
      pending.delete(url);
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
  const [catalog, setCatalog] = useState<{ url: string; icons: Presentations } | null>(() => {
    const icons = resolved.get(presentationUrl);
    return icons ? { url: presentationUrl, icons } : null;
  });
  useEffect(() => {
    let active = true;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const clearRetry = () => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const fetchCatalog = () => {
      if (!active) return;
      const already = resolved.get(presentationUrl);
      if (already) {
        setCatalog({ url: presentationUrl, icons: already });
        return;
      }
      void load(presentationUrl).then(
        (icons) => {
          if (active) setCatalog({ url: presentationUrl, icons });
        },
        () => {
          if (!active) return;
          setCatalog((current) => (current?.url === presentationUrl ? current : null));
          const delay = CATALOG_RETRY_DELAYS_MS[attempt];
          if (delay !== undefined) {
            attempt += 1;
            clearRetry();
            retryTimer = setTimeout(fetchCatalog, delay);
          }
        },
      );
    };

    const unsubscribe = subscribeCatalog(presentationUrl, () => {
      if (!active) return;
      const icons = resolved.get(presentationUrl);
      if (icons) {
        clearRetry();
        setCatalog({ url: presentationUrl, icons });
      }
    });

    const onOnline = () => {
      if (!resolved.has(presentationUrl)) {
        attempt = 0;
        clearRetry();
        fetchCatalog();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
    }

    fetchCatalog();
    return () => {
      active = false;
      clearRetry();
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
  return (
    <BitmapIcon
      key={src}
      src={src}
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
