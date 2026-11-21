import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import {
  DESKTOP_EXTENSION_LIMIT,
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  desktopExtensionHttpUrlSchema,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  type DesktopExtensionsInstallParams,
  type DesktopExtensionsInstallResult,
  type DesktopExtensionsUninstallResult,
} from "@codexhost/shared-contracts";
import { fetchDesktopExtensionCatalog, type CatalogOptions } from "./desktop-extension-catalog.js";
import {
  DesktopExtensionPackageError,
  downloadExtensionBytes,
  resolveDesktopExtensionDownload,
} from "./desktop-extension-download.js";
import { readDesktopExtensionZip } from "./extension-zip.js";
import { withDesktopExtensionConfiguration } from "./extension-configuration.js";
import {
  desktopExtensionsRoot,
  extensionFileMissing,
  isDesktopExtensionTransactionEntry,
  privateExtensionDirectory,
  readDesktopExtensionBackend,
  readDesktopExtensionIcon,
  readDesktopExtensionScreenshot,
  readExtensionResource,
} from "./extension-discovery.js";
import { listDesktopExtensions } from "./extension-management.js";

type InstallResult = Omit<DesktopExtensionsInstallResult, "list">;
type ZipOptions = {
  extensionsRoot: string;
  zipBuffer: Buffer;
  expectedSha256?: string | undefined;
  subpath?: string | undefined;
};
const utf8 = new TextDecoder("utf-8", { fatal: true });

function assertPortableId(id: string) {
  if (
    !desktopExtensionIdSchema.safeParse(id).success ||
    id === "enabled.json" ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(id)
  )
    throw new DesktopExtensionPackageError("Invalid or reserved extension ID");
}

async function pathExists(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isDirectory() && !info.isSymbolicLink())
      throw new DesktopExtensionPackageError(
        "Extension installation path must be a directory or symlink",
      );
    return true;
  } catch (error) {
    if (extensionFileMissing(error)) return false;
    throw error;
  }
}

async function withInstallationBackup<T>(
  installed: string,
  operation: (replaced: boolean) => Promise<T>,
) {
  const backup = path.join(
    path.dirname(installed),
    `.backup-${path.basename(installed)}-${randomUUID()}`,
  );
  const replaced = await pathExists(installed);
  if (replaced) await rename(installed, backup);
  let result: T;
  try {
    result = await operation(replaced);
  } catch (error) {
    if (replaced) {
      try {
        await rename(backup, installed);
      } catch (rollbackError) {
        throw new Error(`Rollback failed; previous extension preserved at ${backup}`, {
          cause: new AggregateError([error, rollbackError]),
        });
      }
    }
    throw error;
  }
  // After commit a cleanup failure must not turn a successful update into a failed request.
  if (replaced) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  return result;
}

export async function installFromZipBuffer(
  { extensionsRoot, zipBuffer, expectedSha256, subpath }: ZipOptions,
  expected?: { id: string; version: string },
): Promise<InstallResult> {
  if (
    expectedSha256 !== undefined &&
    createHash("sha256").update(zipBuffer).digest("hex") !== expectedSha256
  )
    throw new DesktopExtensionPackageError("Desktop extension ZIP SHA-256 mismatch");
  let files: Map<string, Buffer>;
  try {
    files = readDesktopExtensionZip(zipBuffer, subpath);
  } catch (error) {
    throw new DesktopExtensionPackageError(error instanceof Error ? error.message : "Invalid ZIP", {
      cause: error,
    });
  }
  await mkdir(extensionsRoot, { recursive: true, mode: 0o700 });
  const root = await privateExtensionDirectory(extensionsRoot);
  const staging = await mkdtemp(path.join(root, ".staging-"));
  try {
    for (const [relative, bytes] of files) {
      const target = path.join(staging, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    const manifest = await (async () => {
      try {
        const bytes = await readExtensionResource(
          staging,
          "manifest.json",
          DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
        );
        const manifest = desktopExtensionManifestSchema.parse(JSON.parse(utf8.decode(bytes)));
        if (expected && (manifest.id !== expected.id || manifest.version !== expected.version))
          throw new Error("Manifest id or version does not match the catalog entry");
        if (manifest.desktop) {
          const { script, style } = manifest.desktop;
          const scriptBytes = await readExtensionResource(
            staging,
            script,
            DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
          ).catch((error: unknown) => {
            if (!extensionFileMissing(error)) throw error;
            throw new Error(
              `Missing entry file ${script}. Commit the built JavaScript entry or publish a Release .zip.`,
              { cause: error },
            );
          });
          const source = utf8.decode(scriptBytes);
          new Script(`(function(define) { "use strict";\n${source}\n})`);
          if (style)
            utf8.decode(
              await readExtensionResource(staging, style, DESKTOP_EXTENSION_STYLE_MAX_BYTES),
            );
        }
        if (manifest.backend) await readDesktopExtensionBackend(staging, manifest.backend.script);
        if (manifest.icon) await readDesktopExtensionIcon(staging, manifest.icon);
        for (const screenshot of manifest.screenshots ?? [])
          await readDesktopExtensionScreenshot(staging, screenshot);
        return manifest;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Invalid manifest or resources";
        throw new DesktopExtensionPackageError(
          `Invalid extension package: ${reason.slice(0, 768)}`,
          { cause: error },
        );
      }
    })();
    const { id, version } = manifest;
    assertPortableId(id);
    return await withDesktopExtensionConfiguration(
      root,
      async ({ directory, configuration, save }) => {
        const installedPath = path.join(directory, id);
        if (!(await pathExists(installedPath))) {
          const entries = await readdir(directory, { withFileTypes: true });
          if (
            entries.filter(
              (entry) =>
                !isDesktopExtensionTransactionEntry(entry.name) &&
                (entry.isDirectory() || entry.isSymbolicLink()),
            ).length >= DESKTOP_EXTENSION_LIMIT
          )
            throw new DesktopExtensionPackageError(
              `At most ${DESKTOP_EXTENSION_LIMIT} extensions are supported`,
            );
        }
        // Commit the revision (not a new selection) before touching the live package.
        // Readers take this same lock, so they cannot scan during the directory swap.
        await save({ enabled: configuration.enabled });
        return withInstallationBackup(installedPath, async (replaced) => {
          await rename(staging, installedPath);
          return { extensionId: id, version, replaced, installedPath };
        });
      },
    );
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installFromUrl({
  extensionsRoot,
  url,
  expectedSha256,
}: {
  extensionsRoot: string;
  url: string;
  expectedSha256?: string | undefined;
}) {
  const download = await resolveDesktopExtensionDownload(url);
  const zipBuffer = await downloadExtensionBytes(download.url, DESKTOP_EXTENSION_ZIP_MAX_BYTES);
  return installFromZipBuffer({
    extensionsRoot,
    zipBuffer,
    expectedSha256,
    subpath: download.subpath,
  });
}

export const DEFAULT_DESKTOP_EXTENSION_STATS_URL = "https://ext-stats.chost.dev";

export function resolveDesktopExtensionStatsUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment.CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL;
  if (configured !== undefined) {
    const trimmed = configured.trim();
    if (!trimmed || /^(?:off|none|false|0)$/iu.test(trimmed)) return undefined;
    return trimmed;
  }
  if (environment.CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL?.trim()) return undefined;
  return DEFAULT_DESKTOP_EXTENSION_STATS_URL;
}

export async function reportDesktopExtensionInstall(id: string, statsUrl: string | undefined) {
  try {
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
    // Best effort only: the install has already succeeded.
  }
}

export async function installFromCatalog({
  extensionsRoot,
  id,
  ...options
}: { extensionsRoot: string; id: string } & CatalogOptions) {
  const { extensions } = await fetchDesktopExtensionCatalog(options);
  const entry = extensions.find((entry) => entry.id === id);
  if (!entry) throw new DesktopExtensionPackageError("Extension ID was not found in the catalog");
  const zipBuffer = await downloadExtensionBytes(
    entry.downloadUrl,
    DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  );
  const installed = await installFromZipBuffer(
    { extensionsRoot, zipBuffer, expectedSha256: entry.sha256 },
    entry,
  );
  void reportDesktopExtensionInstall(
    installed.extensionId,
    resolveDesktopExtensionStatsUrl(options.environment ?? process.env),
  );
  return installed;
}

export async function installDesktopExtension(
  dataDir: string,
  { source }: DesktopExtensionsInstallParams,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DesktopExtensionsInstallResult> {
  const extensionsRoot = desktopExtensionsRoot(dataDir);
  const installed =
    source.type === "catalog"
      ? await installFromCatalog({ extensionsRoot, id: source.id, environment })
      : source.type === "url"
        ? await installFromUrl({ extensionsRoot, ...source })
        : await installFromZipBuffer({
            extensionsRoot,
            zipBuffer: Buffer.from(source.contentBase64, "base64"),
          });
  return { ...installed, list: await listDesktopExtensions(dataDir) };
}

export async function uninstallDesktopExtension({
  dataDir,
  id,
}: {
  dataDir: string;
  id: string;
}): Promise<DesktopExtensionsUninstallResult> {
  assertPortableId(id);
  await withDesktopExtensionConfiguration(
    desktopExtensionsRoot(dataDir),
    async ({ directory, configuration, save }) => {
      await withInstallationBackup(path.join(directory, id), async () => {
        await save({ enabled: configuration.enabled.filter((entry) => entry !== id) });
      });
    },
  );
  return { removedId: id, list: await listDesktopExtensions(dataDir) };
}
