/** Public project links are read as metadata, without importing installed package code. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const address = value
    .trim()
    .replace(/^git\+/iu, "")
    .replace(/^github:/iu, "https://github.com/")
    .replace(/^git@github\.com:/iu, "https://github.com/")
    .replace(/^(?:ssh:\/\/git@|git:\/\/)github\.com\//iu, "https://github.com/");
  try {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    if (url.hostname === "github.com") {
      url.protocol = "https:";
      url.pathname = url.pathname.replace(/\.git\/?$/u, "");
      url.hash = "";
    }
    return url.href;
  } catch {
    return undefined;
  }
}

/** Prefer any declared GitHub address, then a homepage, repository, or web install source. */
export function extensionProjectUrl(directory: string, source: string): string | undefined {
  let manifest: { repository?: unknown; homepage?: unknown } = {};
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (value && typeof value === "object") manifest = value;
  } catch {
    // An unavailable manifest must not prevent managing or removing its installation.
  }
  const repository =
    manifest.repository && typeof manifest.repository === "object" && "url" in manifest.repository
      ? manifest.repository.url
      : manifest.repository;
  const candidates = [source, repository, manifest.homepage].map(webUrl);
  return (
    candidates.find((url) => url !== undefined && new URL(url).hostname === "github.com") ??
    webUrl(manifest.homepage) ??
    webUrl(repository) ??
    webUrl(source)
  );
}
