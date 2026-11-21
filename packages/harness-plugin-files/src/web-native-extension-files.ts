import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  DESKTOP_EXTENSION_LIMIT,
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  desktopExtensionAssetMimeType,
  desktopExtensionHashSchema,
  extensionBackendTargets,
  extensionManifestTargets,
  parseCodexHostExtensionManifest,
  webExtensionActivationIdSchema,
  webExtensionResourcePathSchema,
  webNativeExtensionIdSchema,
  type CodexHostExtensionManifestV2,
} from "@codexhost/shared-contracts";
import {
  extensionDataDirectory,
  readExtensionSettings,
  writeExtensionSettings,
  writePrivateExtensionFile,
} from "./desktop-extension-data.js";
import {
  extensionFileMissing,
  privateExtensionDirectory,
  readDesktopExtensionBackend,
  readDesktopExtensionIcon,
  readDesktopExtensionScreenshot,
  readExtensionResource,
} from "./extension-discovery.js";
import { readExtensionZip } from "./extension-zip.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const ACTIVE_FILE = "active.json";
const discard = (directory: string) =>
  rm(directory, { recursive: true, force: true }).catch(() => undefined);

export const webNativeExtensionsRoot = (dataDir: string) =>
  path.join(dataDir, "web-native-extensions");
type Location = { dataDir: string; id: string };
export async function webNativeExtensionDataDirectory({ dataDir, id }: Location, create: boolean) {
  return extensionDataDirectory(
    path.join(dataDir, "web-native-extension-data"),
    webNativeExtensionIdSchema.parse(id),
    create,
  );
}
export function readWebNativeExtensionSettings(location: Location) {
  return readExtensionSettings(webNativeExtensionDataDirectory(location, false));
}
export function writeWebNativeExtensionSettings({
  values,
  ...location
}: Location & { values: unknown }) {
  return writeExtensionSettings(
    () => webNativeExtensionDataDirectory(location, true),
    values,
    "Web extension",
  );
}

/** Read a package manifest without importing any entry. v1 is Desktop-only. */
export async function readCodexHostExtensionManifest(directory: string) {
  const root = await privateExtensionDirectory(directory);
  const bytes = await readExtensionResource(
    root,
    "manifest.json",
    DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
    { noSymlinks: true },
  );
  return parseCodexHostExtensionManifest(JSON.parse(utf8.decode(bytes)));
}

async function readWebManifest(directory: string): Promise<CodexHostExtensionManifestV2> {
  const parsed = await readCodexHostExtensionManifest(directory);
  if (parsed.state !== "valid") throw new Error(parsed.error);
  if (
    parsed.manifest.manifestVersion !== 2 ||
    !extensionManifestTargets(parsed.manifest).includes("web")
  )
    throw new Error("Expected a manifest v2 package targeting Web");
  return parsed.manifest;
}

export type WebNativeExtensionInstallation = {
  directory: string;
  digest: string;
  manifest: CodexHostExtensionManifestV2;
};

export class WebNativeExtensionInstallConflict extends Error {}

async function readActive(directory: string) {
  try {
    const bytes = await readExtensionResource(directory, ACTIVE_FILE, 1024, { noSymlinks: true });
    const data: unknown = JSON.parse(utf8.decode(bytes));
    if (!data || typeof data !== "object" || !("packageId" in data) || !("digest" in data))
      throw new Error("Invalid Web extension installation pointer");
    return {
      packageId: webExtensionActivationIdSchema.parse(data.packageId),
      digest: desktopExtensionHashSchema.parse(data.digest),
    };
  } catch (error) {
    if (extensionFileMissing(error)) return undefined;
    throw error;
  }
}

async function getInstalledDirectory(root: string, id: string): Promise<string | undefined> {
  try {
    return await privateExtensionDirectory(path.join(await privateExtensionDirectory(root), id));
  } catch (error) {
    if (extensionFileMissing(error)) return undefined;
    throw error;
  }
}

async function readInstallation(
  root: string,
  id: string,
): Promise<WebNativeExtensionInstallation | undefined> {
  const installed = await getInstalledDirectory(root, id);
  if (!installed) return undefined;
  const active = await readActive(installed);
  if (!active) return undefined;
  const directory = await privateExtensionDirectory(path.join(installed, active.packageId));
  const manifest = await readWebManifest(directory);
  if (manifest.id !== id) throw new Error("Manifest id must match the installation id");
  return { directory, manifest, digest: active.digest };
}

export function readWebNativeExtension(location: Location) {
  return readInstallation(
    webNativeExtensionsRoot(location.dataDir),
    webNativeExtensionIdSchema.parse(location.id),
  );
}

export async function discoverWebNativeExtensions(dataDir: string) {
  const root = webNativeExtensionsRoot(dataDir);
  const installations: WebNativeExtensionInstallation[] = [];
  const diagnostics: { id: string; error: string }[] = [];
  const names = await privateExtensionDirectory(root)
    .then((directory) => readdir(directory))
    .catch((error: unknown) => {
      if (extensionFileMissing(error)) return [];
      throw error;
    });
  for (const id of names.sort()) {
    if (!webNativeExtensionIdSchema.safeParse(id).success) continue;
    try {
      const installation = await readInstallation(root, id);
      if (installation) installations.push(installation);
    } catch (error) {
      diagnostics.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { installations, diagnostics };
}

export function readWebNativeExtensionBackend({
  directory,
  manifest,
}: WebNativeExtensionInstallation) {
  if (manifest.backend && extensionBackendTargets(manifest).includes("web"))
    return readDesktopExtensionBackend(directory, manifest.backend.entry);
  return Promise.resolve(undefined);
}

/** Resolve only the declared UI entries and allowed media under assets/. */
export async function readWebNativeExtensionAsset(
  installation: WebNativeExtensionInstallation,
  resourcePath: string,
) {
  const resource = webExtensionResourcePathSchema.parse(resourcePath);
  const {
    directory,
    manifest: { web, backend, desktop },
  } = installation;
  const canonical = (value: string) => value.normalize("NFC").toLowerCase();
  if (
    [backend?.entry, desktop?.script, desktop?.style].some(
      (privatePath) => privatePath && canonical(resource) === canonical(privatePath),
    ) ||
    !web
  )
    throw new Error("Resource is not a public Web extension asset");
  const [mimeType, limit] =
    resource === web.entry
      ? (["text/javascript", DESKTOP_EXTENSION_SCRIPT_MAX_BYTES] as const)
      : resource === web.style
        ? (["text/css", DESKTOP_EXTENSION_STYLE_MAX_BYTES] as const)
        : ([
            resource.startsWith("assets/") ? desktopExtensionAssetMimeType(resource) : undefined,
            DESKTOP_EXTENSION_ASSET_MAX_BYTES,
          ] as const);
  if (!mimeType || mimeType === "image/svg+xml")
    throw new Error("Resource is not a public Web extension asset");
  return {
    mimeType,
    bytes: await readExtensionResource(directory, resource, limit, { noSymlinks: true }),
  };
}

export interface PreparedWebNativeExtension {
  readonly manifest: CodexHostExtensionManifestV2;
  readonly digest: string;
  /** null means fresh install. The owner serializes commit/uninstall and stops the old generation first. */
  commit(expectedDigest: string | null): Promise<WebNativeExtensionInstallation>;
  dispose(): Promise<void>;
}

export async function prepareWebNativeExtension({
  dataDir,
  zipBuffer,
  expected,
}: {
  dataDir: string;
  zipBuffer: Buffer;
  expected?: { id: string; version: string; sha256: string };
}): Promise<PreparedWebNativeExtension> {
  if (zipBuffer.length > DESKTOP_EXTENSION_ZIP_MAX_BYTES)
    throw new Error("Web extension ZIP exceeds 64 MiB");
  const zip = Buffer.from(zipBuffer);
  const hash = createHash("sha256");
  for (let i = 0; i < zip.length; i += 1024 * 1024) {
    hash.update(zip.subarray(i, i + 1024 * 1024));
    await yieldToEventLoop();
  }
  const digest = hash.digest("hex");
  if (expected && digest !== expected.sha256) throw new Error("Web extension ZIP SHA-256 mismatch");
  const files = await readExtensionZip(zip);
  const configuredRoot = webNativeExtensionsRoot(dataDir);
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const root = await privateExtensionDirectory(configuredRoot);
  const staging = await mkdtemp(path.join(root, ".staging-"));
  try {
    for (const [relative, bytes] of files) {
      const target = path.join(staging, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    const manifest = await readWebManifest(staging);
    const { id, version, web, desktop, backend, icon, screenshots } = manifest;
    if (expected && (id !== expected.id || version !== expected.version))
      throw new Error("Manifest id or version does not match the market entry");
    for (const [file, max] of [
      [desktop?.script, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES],
      [desktop?.style, DESKTOP_EXTENSION_STYLE_MAX_BYTES],
      [backend?.entry, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES],
    ] as const)
      if (file) utf8.decode(await readExtensionResource(staging, file, max));
    for (const file of [web?.entry, web?.style])
      if (file)
        utf8.decode(
          (await readWebNativeExtensionAsset({ directory: staging, manifest, digest }, file)).bytes,
        );
    if (icon) await readDesktopExtensionIcon(staging, icon);
    for (const image of screenshots ?? []) await readDesktopExtensionScreenshot(staging, image);

    let used = false;
    return {
      manifest: structuredClone(manifest),
      digest,
      async commit(expectedDigest) {
        if (used) throw new Error("Prepared extension was already consumed");
        used = true;
        try {
          const installed = await getInstalledDirectory(root, id);
          const active = installed ? await readActive(installed) : undefined;
          if ((active?.digest ?? null) !== expectedDigest)
            throw new WebNativeExtensionInstallConflict("Web extension installation changed");
          if (
            !installed &&
            (await readdir(root)).filter(
              (name) => webNativeExtensionIdSchema.safeParse(name).success,
            ).length >= DESKTOP_EXTENSION_LIMIT
          )
            throw new Error(`At most ${DESKTOP_EXTENSION_LIMIT} Web extensions are supported`);
          const directory = installed ?? (await extensionDataDirectory(root, id, true));
          const packageId = randomUUID();
          const destination = path.join(directory, packageId);
          await rename(staging, destination);
          try {
            await writePrivateExtensionFile(
              directory,
              ACTIVE_FILE,
              JSON.stringify({ digest, packageId }),
            );
          } catch (error) {
            await discard(destination);
            throw error;
          }
          if (active) await discard(path.join(directory, active.packageId));
          return { directory: destination, manifest, digest };
        } finally {
          await discard(staging);
        }
      },
      async dispose() {
        if (used) return;
        used = true;
        await discard(staging);
      },
    };
  } catch (error) {
    await discard(staging);
    throw error;
  }
}

/** Unpublish the package in one rename; settings and extension-owned data are retained. */
export async function uninstallWebNativeExtension({ dataDir, id }: Location): Promise<boolean> {
  const root = webNativeExtensionsRoot(dataDir);
  const directory = await getInstalledDirectory(root, webNativeExtensionIdSchema.parse(id));
  if (!directory) return false;
  const tombstone = path.join(path.dirname(directory), `.removed-${randomUUID()}`);
  await rename(directory, tombstone);
  await discard(tombstone);
  return true;
}
