import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  desktopExtensionCatalogSchema,
  type DesktopExtensionsCatalogResult,
} from "@codexhost/shared-contracts";
import seed from "./desktop-extension-seed-catalog.json" with { type: "json" };
import { downloadExtensionBytes } from "./desktop-extension-download.js";

const PRIMARY =
  "https://raw.githubusercontent.com/BytePioneer-AI/codexhost-extensions-registry/main/catalog.json";
const MIRROR =
  "https://cdn.jsdelivr.net/gh/BytePioneer-AI/codexhost-extensions-registry@main/catalog.json";
const MAX_BYTES = 2 * 1024 * 1024;
const TTL = 5 * 60 * 1000;
const fallback = desktopExtensionCatalogSchema.parse(seed).extensions;
export type CatalogOptions = {
  forceRefresh?: boolean | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
};

async function readLocalCatalog(file: string) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Invalid local catalog file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) throw new Error("Local catalog exceeds the size limit");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function fetchCandidate(catalogUrl: string): Promise<DesktopExtensionsCatalogResult> {
  const data = path.isAbsolute(catalogUrl)
    ? await readLocalCatalog(catalogUrl)
    : await downloadExtensionBytes(catalogUrl, MAX_BYTES, { accept: "application/json" });
  const { extensions } = desktopExtensionCatalogSchema.parse(JSON.parse(data.toString("utf8")));
  return {
    catalogUrl,
    source: "remote",
    fetchedAt: new Date().toISOString(),
    cached: false,
    extensions,
  };
}

async function refreshCatalog(
  override: string | undefined,
): Promise<DesktopExtensionsCatalogResult> {
  const candidates = override ? [override] : [PRIMARY, MIRROR];
  try {
    return await Promise.any(candidates.map(fetchCandidate));
  } catch {
    // An invalid or unavailable mirror is never used as installation metadata.
  }
  return {
    catalogUrl: override ?? PRIMARY,
    source: "fallback",
    fetchedAt: new Date().toISOString(),
    cached: false,
    extensions: fallback,
    error: "Desktop extension catalog unavailable",
  };
}

let cache:
  { key: string | undefined; expires: number; result: DesktopExtensionsCatalogResult } | undefined;
let pending:
  { key: string | undefined; promise: Promise<DesktopExtensionsCatalogResult> } | undefined;

export async function fetchDesktopExtensionCatalog({
  forceRefresh,
  environment = process.env,
}: CatalogOptions = {}): Promise<DesktopExtensionsCatalogResult> {
  const key = environment.CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL?.trim() || undefined;
  if (!forceRefresh && cache && cache.key === key && Date.now() < cache.expires)
    return { ...structuredClone(cache.result), cached: true };
  if (!forceRefresh && pending && pending.key === key)
    return structuredClone(await pending.promise);
  const request = { key, promise: refreshCatalog(key) };
  pending = request;
  try {
    const result = await request.promise;
    if (pending === request) cache = { key, result, expires: Date.now() + TTL };
    return structuredClone(result);
  } finally {
    if (pending === request) pending = undefined;
  }
}
