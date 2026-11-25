/** Per-mount cache keys for owner-resolved local Markdown images. */
let imageLoads = 0;

// Tree-position IDs can repeat between sessions; a module counter cannot.
export const nextImageLoad = (): number => ++imageLoads;

/**
 * Browsers may reuse a same-URL image within a document despite `no-store`.
 * A mounted image keeps its load tag across renders; a new mount reads fresh bytes.
 * @param url - Owner-resolved absolute URL; authored remote URLs do not use this helper.
 * @param load - Number allocated once per mounted image or image-file link.
 * @returns The URL with a load tag, preserving data/blob URLs and existing query encoding.
 */
export function freshImageUrl(url: string, load: number): string {
  let fresh: URL;
  try {
    fresh = new URL(url);
  } catch {
    return url;
  }
  if (fresh.protocol === "data:" || fresh.protocol === "blob:") return url;
  fresh.search = `${fresh.search === "" ? "?" : `${fresh.search}&`}load=${load}`;
  return fresh.href;
}
