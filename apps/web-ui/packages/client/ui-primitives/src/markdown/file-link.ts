/** Local Markdown destinations accepted by the file-preview callback. */

/**
 * Decode a local file destination with a line fragment, range, or line/column suffix.
 * Fragments take precedence over colon suffixes; invalid locations open the file
 * without selecting a line. Columns are consumed but not selected. Literal `?`,
 * `#`, and numeric colon suffixes in filenames must be percent-encoded.
 * @param value - Parsed Markdown link destination.
 * @returns A local path (including local file URLs) and optional first line, or undefined for other URLs,
 * fragment-only links, queries, network paths, or malformed escapes.
 */
export function parseFileLink(value: string): { path: string; line?: number } | undefined {
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (
        !/^file:\/\//i.test(value) ||
        (url.hostname && url.hostname !== "localhost") ||
        url.search
      )
        return undefined;
      value = url.pathname + url.hash;
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    } catch {
      return undefined;
    }
  }
  const hash = value.indexOf("#");
  const destination = hash < 0 ? value : value.slice(0, hash);
  if (destination.includes("?")) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(destination);
  } catch (_error) {
    // Malformed percent escapes cannot identify a file unambiguously.
    return undefined;
  }
  if (
    path.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    /^[\\/]{2}/.test(path) ||
    (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))
  )
    return undefined;
  // Identify locations in the authored destination, not decoded filename characters.
  // Validate URL schemes first so a URL's numeric tail is never treated as a line.
  const suffix = hash < 0 ? /:(\d+)(?::\d+|-(\d+))?$/.exec(destination) : null;
  if (suffix !== null) path = path.slice(0, -suffix[0].length);
  if (path.length === 0) return undefined;
  const match = suffix ?? (hash < 0 ? null : /^L(\d+)(?:-L(\d+))?$/.exec(value.slice(hash + 1)));
  if (match === null) return { path };
  const line = Number(match[1]);
  const end = match[2] === undefined ? line : Number(match[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || line < 1 || end < line)
    return { path };
  return { path, line };
}
