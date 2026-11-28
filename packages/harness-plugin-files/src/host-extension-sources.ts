import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  HOST_EXTENSION_CATALOG_MIRROR_URL,
  HOST_EXTENSION_CATALOG_URL,
  HOST_EXTENSION_ZIP_MAX_BYTES,
  desktopExtensionHttpUrlSchema,
  hostExtensionCatalogSchema,
  hostExtensionIdSchema,
  hostExtensionInstallSourceSchema,
  hostExtensionResourcePathSchema,
  hostExtensionsCatalogResultSchema,
  type HostExtensionInstallSource,
  type HostExtensionProvenance,
  type HostExtensionsCatalogResult,
} from "@codexhost/shared-contracts";
import {
  downloadExtensionBytes,
  ExtensionDownloadError,
  ExtensionHttpError,
} from "./desktop-extension-download.js";
import { readExtensionZip } from "./extension-zip.js";
import { stageHostExtension, type HostExtensionCommitExpectation } from "./host-extension-files.js";
import { privateExtensionDirectory, readHostFile, utf8 } from "./host-extension-io.js";
import { readLocalHostPackage, sha256 } from "./host-extension-package.js";
import { renameWithWindowsRetry } from "./rename-with-windows-retry.js";

const TTL = 5 * 60 * 1000;
const STALE_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000;
const DISK_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 12_000;
const CATALOG_RETRIES = 1;
const GITHUB_RELEASE_TIMEOUT_MS = 15_000;
const GITHUB_RELEASE_RETRIES = 1;
const ZIP_TIMEOUT_MS = 60_000;
const ZIP_IDLE_TIMEOUT_MS = 15_000;
const ZIP_RETRIES = 2;
const ICON_TIMEOUT_MS = 12_000;
const ICON_RETRIES = 1;
const ICON_MEMORY_LIMIT = 200;
const ICON_FAIL_BACKOFF_MS = 60_000;
const STATS_MAX_BYTES = 256 * 1024;
const STATS_TIMEOUT_MS = 2_000;
const STATS_INLINE_GRACE_MS = 600;
const httpsDownload = (url: URL) => url.protocol === "https:" && !url.username && !url.password;
const githubDownload = (url: URL) =>
  httpsDownload(url) &&
  [
    "https://github.com",
    "https://api.github.com",
    "https://codeload.github.com",
    "https://objects.githubusercontent.com",
    "https://release-assets.githubusercontent.com",
  ].includes(url.origin);
let cache: { result: HostExtensionsCatalogResult; expires: number; staleUntil: number } | undefined;
let pending: { forceRefresh: boolean; promise: Promise<HostExtensionsCatalogResult> } | undefined;
let catalogGeneration = 0;
let cacheWrittenGeneration = 0;
let lastKnownDownloadStats:
  { url: string; downloads: ReadonlyMap<string, number>; expires: number } | undefined;

export type CatalogIconMimeType = "image/png" | "image/jpeg" | "image/webp";
export interface CachedCatalogIcon {
  readonly mimeType: CatalogIconMimeType;
  readonly bytes: Buffer;
}

const iconMemoryCache = new Map<string, CachedCatalogIcon>();
const iconPending = new Map<string, Promise<CachedCatalogIcon>>();
const iconRetryAt = new Map<string, number>();

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const RIFF_SIG = Buffer.from("RIFF");
const WEBP_SIG = Buffer.from("WEBP");

function detectRasterMimeType(bytes: Buffer): CatalogIconMimeType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIG)) return "image/png";
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_SIG)) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(RIFF_SIG) &&
    bytes.subarray(8, 12).equals(WEBP_SIG)
  ) {
    return "image/webp";
  }
  return null;
}

function rememberIcon(hash: string, icon: CachedCatalogIcon): CachedCatalogIcon {
  iconMemoryCache.delete(hash);
  iconMemoryCache.set(hash, icon);
  if (iconMemoryCache.size > ICON_MEMORY_LIMIT) {
    const oldest = iconMemoryCache.keys().next().value;
    if (oldest !== undefined) iconMemoryCache.delete(oldest);
  }
  return icon;
}

async function atomicWriteFile(filePath: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tempPath, data);
    await renameWithWindowsRetry(tempPath, filePath);
  } catch {
    await unlink(tempPath).catch(() => undefined);
  }
}

function catalogDiskCachePath(dataDir: string): string {
  return path.join(dataDir, "cache", "host-extension-catalog.v2.json");
}

function iconDiskCachePath(dataDir: string, hash: string): string {
  return path.join(dataDir, "cache", "extension-icons", `${hash}.img`);
}

async function readDiskCatalogCache(
  dataDir: string,
): Promise<HostExtensionsCatalogResult | undefined> {
  try {
    const raw = await readFile(catalogDiskCachePath(dataDir), "utf8");
    const parsed = hostExtensionsCatalogResultSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const fetchedAtMs = Date.parse(parsed.data.fetchedAt);
    if (Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs > DISK_CATALOG_MAX_AGE_MS) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

async function writeDiskCatalogCache(
  dataDir: string | undefined,
  result: HostExtensionsCatalogResult,
): Promise<void> {
  if (!dataDir) return;
  await atomicWriteFile(catalogDiskCachePath(dataDir), JSON.stringify(result));
}

export async function fetchCachedCatalogIcon({
  dataDir,
  iconUrl,
  signal,
}: {
  dataDir: string;
  iconUrl: string;
  signal?: AbortSignal | undefined;
}): Promise<CachedCatalogIcon> {
  const parsedUrl = desktopExtensionHttpUrlSchema.safeParse(iconUrl);
  if (!parsedUrl.success) {
    throw new ExtensionDownloadError("Expected a credential-free HTTP(S) URL");
  }
  const targetUrl = new URL(parsedUrl.data);
  if (!httpsDownload(targetUrl)) {
    throw new ExtensionDownloadError("Catalog icon must use HTTPS");
  }
  const hash = sha256(Buffer.from(targetUrl.href, "utf8"));
  const memoryHit = iconMemoryCache.get(hash);
  if (memoryHit) {
    return rememberIcon(hash, memoryHit);
  }

  const diskFile = iconDiskCachePath(dataDir, hash);
  const diskBytes = await readFile(diskFile).catch(() => undefined);
  if (diskBytes && diskBytes.length <= DESKTOP_EXTENSION_ICON_MAX_BYTES) {
    const mimeType = detectRasterMimeType(diskBytes);
    if (mimeType) {
      return rememberIcon(hash, { mimeType, bytes: diskBytes });
    }
  }

  const retryUntil = iconRetryAt.get(hash);
  if (retryUntil !== undefined && Date.now() < retryUntil) {
    throw new ExtensionDownloadError("Catalog icon temporarily unavailable");
  }

  let flight = iconPending.get(hash);
  if (!flight) {
    const created: Promise<CachedCatalogIcon> = (async (): Promise<CachedCatalogIcon> => {
      try {
        const bytes = await downloadExtensionBytes(
          targetUrl.href,
          DESKTOP_EXTENSION_ICON_MAX_BYTES,
          { accept: "image/webp,image/png,image/jpeg,*/*;q=0.5" },
          {
            allowUrl: httpsDownload,
            timeoutMs: ICON_TIMEOUT_MS,
            retries: ICON_RETRIES,
          },
        );
        const mimeType = detectRasterMimeType(bytes);
        if (!mimeType) {
          throw new ExtensionDownloadError("Unsupported catalog icon image signature");
        }
        iconRetryAt.delete(hash);
        const entry = rememberIcon(hash, { mimeType, bytes });
        void atomicWriteFile(diskFile, bytes);
        return entry;
      } catch (error) {
        iconRetryAt.set(hash, Date.now() + ICON_FAIL_BACKOFF_MS);
        throw error;
      }
    })().finally(() => {
      if (iconPending.get(hash) === created) iconPending.delete(hash);
    });
    created.catch(() => undefined);
    iconPending.set(hash, created);
    flight = created;
  }

  return raceWithSignal(flight, signal);
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new ExtensionDownloadError("Download aborted", { cause: signal.reason }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new ExtensionDownloadError("Download aborted", { cause: signal.reason }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function catalogGeneratedAtMs(result: HostExtensionsCatalogResult): number {
  const parsed = Date.parse(result.generatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchCatalogFrom(
  catalogUrl: string,
  signal: AbortSignal,
  forceRefresh: boolean,
): Promise<HostExtensionsCatalogResult> {
  const bytes = await downloadExtensionBytes(
    catalogUrl,
    2 * 1024 * 1024,
    {
      accept: "application/json",
      ...(forceRefresh ? { "cache-control": "no-cache" } : {}),
    },
    {
      signal,
      allowUrl: (url) => url.origin === new URL(catalogUrl).origin && httpsDownload(url),
      timeoutMs: CATALOG_TIMEOUT_MS,
      retries: CATALOG_RETRIES,
    },
  );
  return {
    ...hostExtensionCatalogSchema.parse(JSON.parse(utf8.decode(bytes))),
    catalogUrl,
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
}

async function raceCatalog(
  forceRefresh: boolean,
  onPrimaryFresher?: (result: HostExtensionsCatalogResult) => void,
): Promise<HostExtensionsCatalogResult> {
  const primaryController = new AbortController();
  const mirrorController = new AbortController();
  const primaryPromise = fetchCatalogFrom(
    HOST_EXTENSION_CATALOG_URL,
    primaryController.signal,
    forceRefresh,
  );
  const mirrorPromise = fetchCatalogFrom(
    HOST_EXTENSION_CATALOG_MIRROR_URL,
    mirrorController.signal,
    forceRefresh,
  );
  // Prevent unhandled rejection when one branch wins before the other settles.
  primaryPromise.catch(() => undefined);
  mirrorPromise.catch(() => undefined);

  try {
    const first = await Promise.any([
      primaryPromise.then((result) => ({ source: "primary" as const, result })),
      mirrorPromise.then((result) => ({ source: "mirror" as const, result })),
    ]);
    if (first.source === "primary") {
      mirrorController.abort();
      return first.result;
    }
    // Mirror responded first: return immediately without blocking on primary,
    // and let primary finish in the background to refresh cache if newer.
    if (onPrimaryFresher) {
      void primaryPromise.then(
        (primaryResult) => {
          if (catalogGeneratedAtMs(primaryResult) > catalogGeneratedAtMs(first.result)) {
            onPrimaryFresher(primaryResult);
          }
        },
        () => undefined,
      );
    } else {
      primaryController.abort();
    }
    return first.result;
  } catch (cause) {
    primaryController.abort();
    mirrorController.abort();
    throw new Error("Host extension catalog unavailable", { cause });
  }
}

async function fetchLiveDownloadStats(
  statsUrl: string | undefined,
  forceRefresh: boolean,
): Promise<ReadonlyMap<string, number> | undefined> {
  try {
    const parsed = desktopExtensionHttpUrlSchema.safeParse(statsUrl);
    if (!parsed.success) return undefined;
    const target = new URL(parsed.data);
    target.pathname = `${target.pathname.replace(/\/+$/u, "")}/stats.json`;
    target.search = "";
    target.hash = "";
    const bytes = await downloadExtensionBytes(
      target.href,
      STATS_MAX_BYTES,
      {
        accept: "application/json",
        ...(forceRefresh ? { "cache-control": "no-cache" } : {}),
      },
      {
        signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
        allowUrl: (url) => url.href === target.href,
      },
    );
    const payload: unknown = JSON.parse(utf8.decode(bytes));
    if (!payload || typeof payload !== "object" || !("downloads" in payload)) return undefined;
    const rawDownloads = payload.downloads;
    if (!rawDownloads || typeof rawDownloads !== "object" || Array.isArray(rawDownloads))
      return undefined;
    const downloads = new Map<string, number>();
    for (const [id, count] of Object.entries(rawDownloads)) {
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
        downloads.set(id, count);
      }
    }
    return downloads;
  } catch {
    return undefined;
  }
}

function mergeLiveDownloadStats(
  catalog: HostExtensionsCatalogResult,
  liveDownloads: ReadonlyMap<string, number> | undefined,
): HostExtensionsCatalogResult {
  if (!liveDownloads || liveDownloads.size === 0) return catalog;
  return {
    ...catalog,
    extensions: catalog.extensions.map((entry) => {
      const live = liveDownloads.get(entry.id);
      return live === undefined ? entry : { ...entry, downloads: live };
    }),
  };
}

function startCatalogFetch(
  forceRefresh: boolean,
  dataDir: string | undefined,
): Promise<HostExtensionsCatalogResult> {
  if (pending && (!forceRefresh || pending.forceRefresh)) {
    return pending.promise;
  }
  const generation = ++catalogGeneration;
  const statsUrl = resolveHostExtensionStatsUrl();
  const statsPromise = fetchLiveDownloadStats(statsUrl, forceRefresh);
  const commitCache = (merged: HostExtensionsCatalogResult) => {
    if (generation >= cacheWrittenGeneration) {
      cacheWrittenGeneration = generation;
      const now = Date.now();
      cache = {
        result: merged,
        expires: now + TTL,
        staleUntil: now + STALE_FALLBACK_MAX_AGE_MS,
      };
      void writeDiskCatalogCache(dataDir, merged);
    }
  };
  const created = raceCatalog(forceRefresh, (fresherPrimary) => {
    const knownStats =
      statsUrl && lastKnownDownloadStats?.url === statsUrl
        ? lastKnownDownloadStats.downloads
        : undefined;
    commitCache(mergeLiveDownloadStats(fresherPrimary, knownStats));
  })
    .then(async (catalog) => {
      // Wait briefly for stats if already nearly ready; never block the catalog on a slow stats host.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const statsOutcome = await Promise.race([
        statsPromise.then((downloads) => ({ settled: true as const, downloads })),
        new Promise<{ settled: false }>((resolve) => {
          timer = setTimeout(() => resolve({ settled: false }), STATS_INLINE_GRACE_MS);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });

      let initialDownloads: ReadonlyMap<string, number> | undefined;
      if (statsOutcome.settled) {
        if (statsOutcome.downloads && statsUrl) {
          lastKnownDownloadStats = {
            url: statsUrl,
            downloads: statsOutcome.downloads,
            expires: Date.now() + TTL,
          };
        }
        initialDownloads = statsOutcome.downloads;
      } else {
        // Use previously known stats if fresh & not forceRefresh, and backfill once stats resolves.
        if (
          !forceRefresh &&
          statsUrl &&
          lastKnownDownloadStats?.url === statsUrl &&
          Date.now() < lastKnownDownloadStats.expires
        ) {
          initialDownloads = lastKnownDownloadStats.downloads;
        }
        void statsPromise.then((lateDownloads) => {
          if (!lateDownloads || !statsUrl) return;
          lastKnownDownloadStats = {
            url: statsUrl,
            downloads: lateDownloads,
            expires: Date.now() + TTL,
          };
          if (cache && generation >= cacheWrittenGeneration) {
            const updated = mergeLiveDownloadStats(cache.result, lateDownloads);
            cache = { ...cache, result: updated };
            void writeDiskCatalogCache(dataDir, updated);
          }
        });
      }

      const merged = mergeLiveDownloadStats(catalog, initialDownloads);
      commitCache(merged);
      return merged;
    })
    .finally(() => {
      if (pending?.promise === created) pending = undefined;
    });
  // Prevent unhandled rejections if every waiter aborts before the shared fetch settles.
  created.catch(() => undefined);
  pending = { forceRefresh, promise: created };
  return created;
}

export async function fetchHostExtensionCatalog({
  dataDir,
  forceRefresh = false,
  fallbackToCache = false,
  staleWhileRevalidate = false,
  signal,
}: {
  dataDir?: string | undefined;
  forceRefresh?: boolean | undefined;
  fallbackToCache?: boolean | undefined;
  staleWhileRevalidate?: boolean | undefined;
  signal?: AbortSignal | undefined;
} = {}): Promise<HostExtensionsCatalogResult> {
  if (!forceRefresh && cache && Date.now() < cache.expires)
    return { ...structuredClone(cache.result), cached: true };
  if (signal?.aborted)
    throw new ExtensionDownloadError("Download aborted", { cause: signal.reason });

  if (!forceRefresh && staleWhileRevalidate) {
    const staleEntry =
      cache && Date.now() <= cache.staleUntil
        ? cache.result
        : dataDir
          ? await readDiskCatalogCache(dataDir)
          : undefined;
    if (staleEntry) {
      const now = Date.now();
      if (!cache) {
        cache = {
          result: staleEntry,
          expires: now,
          staleUntil: now + STALE_FALLBACK_MAX_AGE_MS,
        };
      }
      void startCatalogFetch(false, dataDir);
      return { ...structuredClone(staleEntry), cached: true, stale: true };
    }
  }

  const request = startCatalogFetch(forceRefresh, dataDir);
  try {
    const result = await raceWithSignal(request, signal);
    return structuredClone(result);
  } catch (error) {
    if (fallbackToCache && !signal?.aborted) {
      if (cache && Date.now() <= cache.staleUntil) {
        return { ...structuredClone(cache.result), cached: true };
      }
      if (dataDir) {
        const diskFallback = await readDiskCatalogCache(dataDir);
        if (diskFallback) return { ...structuredClone(diskFallback), cached: true };
      }
    }
    throw error;
  }
}

async function resolveGitHubSource(
  source: Extract<HostExtensionInstallSource, { type: "github" }>,
  signal?: AbortSignal,
) {
  const { repository, ref, tag, asset } = source;
  const api = `https://api.github.com/repos/${repository}`;
  const zipball = (name?: string) => `${api}/zipball${name ? `/${encodeURIComponent(name)}` : ""}`;
  if (ref) return zipball(ref);
  const releaseUrl = tag
    ? `${api}/releases/tags/${encodeURIComponent(tag)}`
    : `${api}/releases/latest`;
  let release: unknown;
  try {
    release = JSON.parse(
      utf8.decode(
        await downloadExtensionBytes(
          releaseUrl,
          1024 * 1024,
          { accept: "application/vnd.github+json" },
          {
            signal,
            allowUrl: githubDownload,
            timeoutMs: GITHUB_RELEASE_TIMEOUT_MS,
            retries: GITHUB_RELEASE_RETRIES,
          },
        ),
      ),
    );
  } catch (error) {
    if (error instanceof ExtensionHttpError && error.status === 404 && !asset) return zipball(tag);
    throw error;
  }
  if (
    release &&
    typeof release === "object" &&
    "assets" in release &&
    Array.isArray(release.assets)
  ) {
    for (const row of release.assets) {
      if (
        !row ||
        typeof row.name !== "string" ||
        !/\.zip$/iu.test(row.name) ||
        (asset && row.name !== asset) ||
        typeof row.browser_download_url !== "string"
      )
        continue;
      const url = new URL(row.browser_download_url);
      if (
        url.origin === "https://github.com" &&
        httpsDownload(url) &&
        url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/releases/download/`) &&
        /\.zip$/iu.test(url.pathname)
      )
        return url.href;
    }
  }
  if (asset) throw new Error("Requested GitHub Release ZIP asset was not found");
  return zipball(tag);
}

function assertAbsoluteLocalPath(file: string) {
  if (
    !path.isAbsolute(file) ||
    file.split(/[/\\]/u).some((component) => component === "." || component === "..")
  )
    throw new Error("Expected an absolute local path without dot segments");
}

async function checkedLocalDirectory(file: string) {
  assertAbsoluteLocalPath(file);
  const { root } = path.parse(file);
  let current = root;
  for (const segment of file.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    // macOS exposes its system temporary paths through these root-level aliases.
    if (
      process.platform === "darwin" &&
      ["/tmp", "/var"].includes(current) &&
      (await realpath(current)) === `/private${current}`
    ) {
      current = `/private${current}`;
    } else if (!(await lstat(current)).isDirectory())
      throw new Error("Local package path must not traverse symlinks or special files");
  }
  return current;
}

export interface HostExtensionPrepareOptions {
  dataDir: string;
  source: HostExtensionInstallSource | { type: "zip"; zipBuffer: Buffer };
  /** Required for localZipPath. Set by the Host, never from RPC params. */
  localZipRoot?: string | undefined;
  expected?: { id: string; version?: string | undefined; sha256?: string | undefined } | undefined;
  forceRefreshCatalog?: boolean | undefined;
  fallbackToCacheOnCatalogError?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export async function prepareHostExtension({
  dataDir,
  source: input,
  expected,
  localZipRoot,
  forceRefreshCatalog,
  fallbackToCacheOnCatalogError,
  signal,
}: HostExtensionPrepareOptions) {
  if (signal?.aborted)
    throw new ExtensionDownloadError("Download aborted", { cause: signal.reason });
  let zip: Buffer;
  let subpath: string | undefined;
  let source: HostExtensionProvenance;
  if (input.type === "zip" && "zipBuffer" in input) {
    if (input.zipBuffer.length > HOST_EXTENSION_ZIP_MAX_BYTES)
      throw new Error("Extension ZIP exceeds 64 MiB");
    zip = Buffer.from(input.zipBuffer);
    source = { type: "zip" };
  } else {
    const checked = hostExtensionInstallSourceSchema.parse(input);
    switch (checked.type) {
      case "localDir": {
        if (expected?.sha256)
          throw new Error("An archive SHA-256 cannot be checked against a local directory");
        const directory = await checkedLocalDirectory(checked.localDir);
        return stageHostExtension({
          dataDir,
          expected,
          files: await readLocalHostPackage(directory),
          source: { type: "localDir" },
          signal,
        });
      }
      case "zip": {
        source = { type: "zip" };
        if ("base64" in checked) {
          zip = Buffer.from(checked.base64, "base64");
          break;
        }
        if (!localZipRoot) throw new Error("A controlled local ZIP root is required");
        assertAbsoluteLocalPath(checked.localZipPath);
        const lexicalRoot = path.resolve(localZipRoot);
        const relative = path.relative(lexicalRoot, checked.localZipPath).split(path.sep).join("/");
        hostExtensionResourcePathSchema.parse(relative);
        if (!/\.zip$/iu.test(relative)) throw new Error("Expected a local .zip file");
        zip = await readHostFile(
          await privateExtensionDirectory(lexicalRoot),
          relative,
          HOST_EXTENSION_ZIP_MAX_BYTES,
        );
        break;
      }
      case "github": {
        source = checked;
        zip = await downloadExtensionBytes(
          await resolveGitHubSource(checked, signal),
          HOST_EXTENSION_ZIP_MAX_BYTES,
          undefined,
          {
            signal,
            allowUrl: githubDownload,
            timeoutMs: ZIP_TIMEOUT_MS,
            idleTimeoutMs: ZIP_IDLE_TIMEOUT_MS,
            retries: ZIP_RETRIES,
          },
        );
        subpath = checked.subpath;
        break;
      }
      case "catalog": {
        source = checked;
        let catalog = await fetchHostExtensionCatalog({
          forceRefresh: forceRefreshCatalog,
          fallbackToCache: fallbackToCacheOnCatalogError,
          signal,
        });
        let entry = catalog.extensions.find(({ id }) => id === checked.id);
        if (!entry && catalog.cached && !forceRefreshCatalog) {
          catalog = await fetchHostExtensionCatalog({ forceRefresh: true, signal });
          entry = catalog.extensions.find(({ id }) => id === checked.id);
        }
        if (!entry) throw new Error("Extension is not in the catalog");
        if (
          expected &&
          (expected.id !== entry.id ||
            (expected.version !== undefined && expected.version !== entry.version) ||
            (expected.sha256 !== undefined && expected.sha256 !== entry.sha256))
        )
          throw new Error("Requested package does not match the catalog entry");
        expected = entry;
        zip = await downloadExtensionBytes(
          entry.downloadUrl,
          HOST_EXTENSION_ZIP_MAX_BYTES,
          undefined,
          {
            signal,
            allowUrl: httpsDownload,
            timeoutMs: ZIP_TIMEOUT_MS,
            idleTimeoutMs: ZIP_IDLE_TIMEOUT_MS,
            retries: ZIP_RETRIES,
          },
        );
        break;
      }
    }
  }
  if (signal?.aborted)
    throw new ExtensionDownloadError("Download aborted", { cause: signal.reason });
  if (expected?.sha256 && sha256(zip) !== expected.sha256)
    throw new Error("Extension ZIP SHA-256 mismatch");
  return stageHostExtension({
    dataDir,
    expected,
    source,
    files: await readExtensionZip(zip, subpath, DESKTOP_EXTENSION_ASSET_MAX_BYTES),
    signal,
  });
}

export const DEFAULT_HOST_EXTENSION_STATS_URL = "https://ext-stats.chost.dev";

export function resolveHostExtensionStatsUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment.CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL;
  if (configured !== undefined) {
    const trimmed = configured.trim();
    if (!trimmed || /^(?:off|none|false|0)$/iu.test(trimmed)) return undefined;
    return trimmed;
  }
  if (environment.CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL?.trim()) return undefined;
  return DEFAULT_HOST_EXTENSION_STATS_URL;
}

export async function reportHostExtensionInstall(
  id: string,
  statsUrl: string | undefined,
): Promise<void> {
  try {
    if (!hostExtensionIdSchema.safeParse(id).success) return;
    const { data } = desktopExtensionHttpUrlSchema.safeParse(statsUrl);
    if (data === undefined) return;
    const url = new URL(data);
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/install/${encodeURIComponent(id)}`;
    url.search = "";
    url.hash = "";
    const response = await fetch(url, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
  } catch {
    // Best effort only: the install or update has already succeeded.
  }
}

/** Convenience wrapper. For backend updates, prepare first and stop the old runtime before commit. */
export async function installHostExtension(
  options: HostExtensionPrepareOptions & Partial<HostExtensionCommitExpectation>,
) {
  const prepared = await prepareHostExtension(options);
  return prepared.commit({
    expectedDigest: options.expectedDigest ?? null,
    expectedActivationId: options.expectedActivationId,
  });
}
