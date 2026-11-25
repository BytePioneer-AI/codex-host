import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  HOST_EXTENSION_CATALOG_MIRROR_URL,
  HOST_EXTENSION_CATALOG_URL,
  HOST_EXTENSION_ZIP_MAX_BYTES,
  desktopExtensionHttpUrlSchema,
  hostExtensionCatalogSchema,
  hostExtensionIdSchema,
  hostExtensionInstallSourceSchema,
  hostExtensionResourcePathSchema,
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

const TTL = 5 * 60 * 1000;
const STALE_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 12_000;
const CATALOG_RETRIES = 1;
const GITHUB_RELEASE_TIMEOUT_MS = 15_000;
const GITHUB_RELEASE_RETRIES = 1;
const ZIP_TIMEOUT_MS = 60_000;
const ZIP_IDLE_TIMEOUT_MS = 15_000;
const ZIP_RETRIES = 2;
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

const PRIMARY_GRACE_MS = 1_500;
const PRIMARY_FORCE_REFRESH_GRACE_MS = 3_000;
const STATS_MAX_BYTES = 256 * 1024;
const STATS_TIMEOUT_MS = 2_000;

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

function pickFresherCatalog(
  primary: HostExtensionsCatalogResult,
  mirror: HostExtensionsCatalogResult,
): HostExtensionsCatalogResult {
  return catalogGeneratedAtMs(mirror) > catalogGeneratedAtMs(primary) ? mirror : primary;
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

async function raceCatalog(forceRefresh: boolean): Promise<HostExtensionsCatalogResult> {
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
    const graceMs = forceRefresh ? PRIMARY_FORCE_REFRESH_GRACE_MS : PRIMARY_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const primaryWithinGrace = await Promise.race([
      primaryPromise.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (primaryWithinGrace) {
      return pickFresherCatalog(primaryWithinGrace, first.result);
    }
    primaryController.abort();
    return first.result;
  } catch (cause) {
    throw new Error("Host extension catalog unavailable", { cause });
  } finally {
    primaryController.abort();
    mirrorController.abort();
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

export async function fetchHostExtensionCatalog({
  forceRefresh = false,
  fallbackToCache = false,
  signal,
}: {
  forceRefresh?: boolean | undefined;
  fallbackToCache?: boolean | undefined;
  signal?: AbortSignal | undefined;
} = {}): Promise<HostExtensionsCatalogResult> {
  if (!forceRefresh && cache && Date.now() < cache.expires)
    return { ...structuredClone(cache.result), cached: true };
  if (signal?.aborted)
    throw new ExtensionDownloadError("Download aborted", { cause: signal.reason });
  let request: Promise<HostExtensionsCatalogResult>;
  if (pending && (!forceRefresh || pending.forceRefresh)) {
    request = pending.promise;
  } else {
    const generation = ++catalogGeneration;
    const created = Promise.all([
      raceCatalog(forceRefresh),
      fetchLiveDownloadStats(resolveHostExtensionStatsUrl(), forceRefresh),
    ])
      .then(([catalog, liveDownloads]) => {
        const merged = mergeLiveDownloadStats(catalog, liveDownloads);
        if (generation >= cacheWrittenGeneration) {
          cacheWrittenGeneration = generation;
          const now = Date.now();
          cache = {
            result: merged,
            expires: now + TTL,
            staleUntil: now + STALE_FALLBACK_MAX_AGE_MS,
          };
        }
        return merged;
      })
      .finally(() => {
        if (pending?.promise === created) pending = undefined;
      });
    // Prevent unhandled rejections if every waiter aborts before the shared fetch settles.
    created.catch(() => undefined);
    pending = { forceRefresh, promise: created };
    request = created;
  }
  try {
    const result = await raceWithSignal(request, signal);
    return structuredClone(result);
  } catch (error) {
    if (fallbackToCache && !signal?.aborted && cache && Date.now() <= cache.staleUntil)
      return { ...structuredClone(cache.result), cached: true };
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
