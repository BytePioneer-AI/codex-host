import { useEffect, useState, type ReactNode } from "react";
import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";

type Presentation = NonNullable<HarnessPluginDescriptor["iconStyle"]>;
type Presentations = Record<string, Presentation | null>;
const pending = new Map<string, Promise<Presentations>>();
const resolved = new Map<string, Presentations>();

/** One metadata request per catalog URL, shared by rows and picker entries. */
function load(url: string): Promise<Presentations> {
  const existing = pending.get(url);
  if (existing) return existing;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const request = fetch(url, { credentials: "same-origin", signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error("Icon presentation unavailable");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid icon catalog");
      const icons = value as Presentations;
      resolved.set(url, icons);
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
    void load(presentationUrl).then(
      (icons) => {
        if (active) setCatalog({ url: presentationUrl, icons });
      },
      () => {
        if (active) setCatalog(null);
      },
    );
    return () => {
      active = false;
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
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      src={src}
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
