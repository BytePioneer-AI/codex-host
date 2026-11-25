import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_LIMIT,
  DESKTOP_EXTENSION_LIST_SCREENSHOTS_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  hostExtensionActivationIdSchema,
  hostExtensionCanonicalPath,
  hostExtensionConfigurationSchema,
  hostExtensionIdSchema,
  hostExtensionInstallationSchema,
  hostExtensionResourcePathSchema,
  hostExtensionStaticAssetMimeType,
  resolveDesktopExtensionSlots,
  type HostExtensionConfiguration,
  type HostExtensionInstallation,
  type HostExtensionListItem,
  type HostExtensionProvenance,
  type HostExtensionsRpcParams,
  type HostExtensionsRpcResult,
  type HOST_EXTENSIONS_RPC,
} from "@codexhost/shared-contracts";
import {
  errorMessage,
  hostExtensionDataDirectory,
  hostExtensionsRoot,
  ifMissing,
  readHostFile,
  renamePrivateExtensionPath,
  storeChild,
  storeRoot,
  utf8,
  withHostExtensionWrite,
  writePrivateExtensionFile,
  type HostExtensionLocation,
} from "./host-extension-io.js";
import {
  hostFrontendEntries,
  hostFrontendStyles,
  indexedRead,
  indexHostPackage,
  InvalidHostExtensionManifest,
  PACKAGE_INDEX,
  readHostManifest,
  readHostPackageIndex,
  validateHostPackageEntries,
  verifyHostPackage,
} from "./host-extension-package.js";

const ACTIVE = "active.json";
const ENABLED = "enabled.json";
const activeFields = hostExtensionInstallationSchema.omit({ manifest: true, id: true });
const activeSchema = activeFields.extend({ generation: hostExtensionActivationIdSchema });
export type HostExtensionActivePointer = ReturnType<typeof activeSchema.parse>;
export type HostExtensionDiskInstallation = HostExtensionInstallation & {
  generation: string;
  directory: string;
};
export function hostExtensionInstallationMetadata({
  id,
  activationId,
  digest,
  manifest,
  installedAt,
  source,
}: HostExtensionDiskInstallation): HostExtensionInstallation {
  return { id, activationId, digest, manifest, installedAt, ...(source ? { source } : {}) };
}
export class HostExtensionInstallConflict extends Error {}
export class HostExtensionRevisionConflict extends Error {
  constructor(readonly revision: number) {
    super("Extension selection changed; refresh and try again");
  }
}

const discard = (directory: string) =>
  rm(directory, { recursive: true, force: true }).catch(() => undefined);
const readPointer = (directory: string) =>
  ifMissing(async () =>
    activeSchema.parse(JSON.parse(utf8.decode(await readHostFile(directory, ACTIVE, 8192)))),
  );

async function installationAt(parent: string, id: string, active: HostExtensionActivePointer) {
  const directory = await storeChild(parent, active.generation);
  const index = await readHostPackageIndex(directory, active.digest);
  const read = indexedRead(directory, index);
  const manifest = await readHostManifest(read);
  if (id !== manifest.id) throw new Error("Manifest id must match the installation directory");
  const installation: HostExtensionDiskInstallation = { ...active, directory, id, manifest };
  return { installation, read, index };
}

async function currentAt(root: string, id: string) {
  const parent = await ifMissing(() => storeChild(root, id));
  if (!parent) return;
  const active = await readPointer(parent);
  if (active) return { parent, active, ...(await installationAt(parent, id, active)) };
}
async function current({ dataDir, id }: HostExtensionLocation) {
  hostExtensionIdSchema.parse(id);
  const root = await ifMissing(() => storeRoot(hostExtensionsRoot(dataDir), false));
  return root ? currentAt(root, id) : undefined;
}
export async function readHostExtension(location: HostExtensionLocation) {
  return (await current(location))?.installation;
}

const emptyConfiguration = (): HostExtensionConfiguration => ({ revision: 0, enabled: [] });
async function readConfiguration(root: string) {
  return (
    (await ifMissing(async () =>
      hostExtensionConfigurationSchema.parse(
        JSON.parse(utf8.decode(await readHostFile(root, ENABLED, 32 * 1024))),
      ),
    )) ?? emptyConfiguration()
  );
}
export async function readHostExtensionConfiguration(dataDir: string) {
  const root = await ifMissing(() => storeRoot(hostExtensionsRoot(dataDir), false));
  return root ? readConfiguration(root) : emptyConfiguration();
}
async function saveConfiguration(
  root: string,
  current: HostExtensionConfiguration,
  enabled: string[],
  assertLocked: () => void,
) {
  const next = hostExtensionConfigurationSchema.parse({ revision: current.revision + 1, enabled });
  await writePrivateExtensionFile(root, ENABLED, JSON.stringify(next), assertLocked);
  return next;
}
type Selection = ({ action: "enable" | "disable"; id: string } | { action: "disableAll" }) & {
  expectedRevision?: number | undefined;
};
export async function updateHostExtensionConfiguration(dataDir: string, change: Selection) {
  return withHostExtensionWrite(dataDir, async (root, assertLocked) => {
    // Recovery can replace an unreadable configuration, but only unconditionally.
    const current = await readConfiguration(root).catch((error: unknown) => {
      if (change.action === "disableAll" && change.expectedRevision === undefined)
        return emptyConfiguration();
      throw error;
    });
    if (change.expectedRevision !== undefined && change.expectedRevision !== current.revision)
      throw new HostExtensionRevisionConflict(current.revision);
    if (change.action === "disableAll") return saveConfiguration(root, current, [], assertLocked);
    const id = hostExtensionIdSchema.parse(change.id);
    if (change.action === "enable" && !(await currentAt(root, id)))
      throw new Error("Extension is not installed");
    const enabled =
      change.action === "enable"
        ? [...new Set([...current.enabled, id])]
        : current.enabled.filter((entry) => entry !== id);
    return saveConfiguration(root, current, enabled, assertLocked);
  });
}

export async function discoverHostExtensions(dataDir: string): Promise<{
  configuration: HostExtensionConfiguration;
  installations: HostExtensionDiskInstallation[];
  extensions: HostExtensionListItem[];
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  const configuration = await readHostExtensionConfiguration(dataDir).catch((error: unknown) => {
    diagnostics.push(`Invalid extension configuration: ${errorMessage(error)}`);
    return emptyConfiguration();
  });
  const installations: HostExtensionDiskInstallation[] = [];
  const extensions: HostExtensionListItem[] = [];
  const root = await ifMissing(() => storeRoot(hostExtensionsRoot(dataDir), false));
  if (!root) return { configuration, installations, extensions, diagnostics };
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map(({ name }) => name)
    .sort();
  let screenshotBudget = DESKTOP_EXTENSION_LIST_SCREENSHOTS_MAX_BYTES;
  let omitted = false;
  for (const id of ids) {
    const enabled = configuration.enabled.includes(id);
    try {
      hostExtensionIdSchema.parse(id);
      const resolved = await currentAt(root, id);
      if (!resolved) continue;
      const { installation, read } = resolved;
      const metadata = hostExtensionInstallationMetadata(installation);
      const { icon, screenshots } = await validateHostPackageEntries(metadata.manifest, read);
      const toDataUrl = ({ mime, bytes }: { mime: string | undefined; bytes: Buffer }) =>
        `data:${mime};base64,${bytes.toString("base64")}`;
      const size = screenshots.reduce((sum, { bytes }) => sum + bytes.length, 0);
      const fits = size <= screenshotBudget;
      if (fits) screenshotBudget -= size;
      else omitted = true;
      extensions.push({
        state: "valid",
        ...metadata,
        enabled,
        ...(icon ? { iconDataUrl: toDataUrl(icon) } : {}),
        ...(fits && screenshots.length ? { screenshotDataUrls: screenshots.map(toDataUrl) } : {}),
      });
      installations.push(installation);
    } catch (error) {
      extensions.push({
        id,
        enabled,
        state: error instanceof InvalidHostExtensionManifest ? error.state : "invalid",
        error: errorMessage(error),
      });
    }
  }
  if (omitted) diagnostics.push("Extension screenshot budget exceeded; some previews were omitted");
  const { conflicts } = resolveDesktopExtensionSlots(
    configuration.enabled,
    installations
      .filter(({ manifest }) => manifest.desktop)
      .map(({ id, manifest }) => ({ id, slots: manifest.slots ?? [] })),
  );
  for (const extension of extensions) {
    const conflict = conflicts.get(extension.id);
    if (extension.state === "valid" && conflict) extension.desktopConflictWith = conflict;
  }
  return { configuration, installations, extensions, diagnostics };
}

export type HostExtensionCommitExpectation = {
  expectedDigest: string | null;
  expectedActivationId?: string | undefined;
};
export interface PreparedHostExtension {
  readonly manifest: HostExtensionInstallation["manifest"];
  readonly digest: string;
  /** null means a fresh install. The Host stops the old runtime before committing. */
  commit(
    expectation: HostExtensionCommitExpectation,
  ): Promise<HostExtensionDiskInstallation & { replaced: boolean }>;
  dispose(): Promise<void>;
}

function checkActivation(
  active: HostExtensionActivePointer | undefined,
  expected: { activationId?: string | undefined; digest?: string | undefined },
) {
  if (
    (expected.activationId !== undefined && expected.activationId !== active?.activationId) ||
    (expected.digest !== undefined && expected.digest !== active?.digest)
  )
    throw new HostExtensionInstallConflict("Extension activation changed");
}

export async function stageHostExtension({
  dataDir,
  files,
  expected,
  source,
  signal,
}: {
  dataDir: string;
  files: Map<string, Buffer>;
  expected?: { id: string; version?: string | undefined } | undefined;
  source?: HostExtensionProvenance | undefined;
  signal?: AbortSignal | undefined;
}): Promise<PreparedHostExtension> {
  if (signal?.aborted) throw new Error("Extension staging aborted", { cause: signal.reason });
  const index = indexHostPackage(files);
  const read = (filename: string, max: number) => {
    const bytes = files.get(filename);
    if (!bytes) throw new Error(`Missing required extension file: ${filename}`);
    if (bytes.length > max) throw new Error(`Extension file exceeds size limit: ${filename}`);
    return bytes;
  };
  const manifest = await readHostManifest(read);
  if (
    expected &&
    (manifest.id !== expected.id ||
      (expected.version !== undefined && manifest.version !== expected.version))
  )
    throw new Error("Manifest id or version does not match the expected package");
  await validateHostPackageEntries(manifest, read);
  if (signal?.aborted) throw new Error("Extension staging aborted", { cause: signal.reason });
  const root = await storeRoot(hostExtensionsRoot(dataDir), true);
  const staging = await mkdtemp(path.join(root, ".staging-"));
  try {
    for (const [resource, bytes] of files) {
      if (signal?.aborted) throw new Error("Extension staging aborted", { cause: signal.reason });
      const target = path.join(staging, resource);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(path.join(staging, PACKAGE_INDEX), index.bytes, { flag: "wx", mode: 0o600 });
    if (signal?.aborted) throw new Error("Extension staging aborted", { cause: signal.reason });
  } catch (error) {
    await discard(staging);
    throw error;
  }
  let used = false;
  return {
    manifest: structuredClone(manifest),
    digest: index.digest,
    async commit({ expectedDigest, expectedActivationId }) {
      if (used) throw new Error("Prepared extension was already consumed");
      used = true;
      try {
        return await withHostExtensionWrite(dataDir, async (root, assertLocked) => {
          const { id } = manifest;
          const existing = await ifMissing(() => storeChild(root, id));
          const previous = existing ? await readPointer(existing) : undefined;
          if ((previous?.digest ?? null) !== expectedDigest)
            throw new HostExtensionInstallConflict("Extension installation changed");
          checkActivation(previous, { activationId: expectedActivationId });
          if (
            !existing &&
            (await readdir(root)).filter((name) => hostExtensionIdSchema.safeParse(name).success)
              .length >= DESKTOP_EXTENSION_LIMIT
          )
            throw new Error(`At most ${DESKTOP_EXTENSION_LIMIT} Host extensions are supported`);
          const parent = existing ?? (await storeChild(root, id, true));
          const active = activeSchema.parse({
            generation: randomUUID(),
            activationId: randomUUID(),
            digest: index.digest,
            installedAt: new Date().toISOString(),
            source,
          });
          const destination = path.join(parent, active.generation);
          assertLocked();
          await renamePrivateExtensionPath(staging, destination);
          try {
            await writePrivateExtensionFile(parent, ACTIVE, JSON.stringify(active), assertLocked);
          } catch (error) {
            await discard(destination);
            throw error;
          }
          // Keep exactly the active generation and its rollback candidate.
          for (const name of await readdir(parent).catch(() => []))
            if (
              name !== active.generation &&
              name !== previous?.generation &&
              hostExtensionActivationIdSchema.safeParse(name).success
            )
              await discard(path.join(parent, name));
          return { ...active, directory: destination, manifest, id, replaced: Boolean(previous) };
        });
      } finally {
        await discard(staging);
      }
    },
    async dispose() {
      if (!used) {
        used = true;
        await discard(staging);
      }
    },
  };
}

/** The caller supplies a retained pointer captured before the update; rollback revalidates the entire package. */
export async function rollbackHostExtension({
  dataDir,
  id,
  previous,
  expectedActivationId,
}: HostExtensionLocation & {
  previous: HostExtensionActivePointer;
  expectedActivationId: string;
}) {
  hostExtensionIdSchema.parse(id);
  const target = activeSchema.strip().parse({ ...previous, activationId: randomUUID() });
  return withHostExtensionWrite(dataDir, async (root, assertLocked) => {
    const parent = await storeChild(root, id);
    checkActivation(await readPointer(parent), {
      activationId: hostExtensionActivationIdSchema.parse(expectedActivationId),
    });
    const { installation, index } = await installationAt(parent, id, target);
    await verifyHostPackage(installation.directory, index);
    await writePrivateExtensionFile(parent, ACTIVE, JSON.stringify(target), assertLocked);
    return installation;
  });
}

export async function uninstallHostExtension({
  dataDir,
  id,
  removeData = false,
  expectedDigest,
}: HostExtensionLocation & {
  removeData?: boolean | undefined;
  expectedDigest?: string | undefined;
}) {
  hostExtensionIdSchema.parse(id);
  return withHostExtensionWrite(dataDir, async (root, assertLocked) => {
    const parent = await ifMissing(() => storeChild(root, id));
    if (expectedDigest !== undefined)
      checkActivation(parent ? await readPointer(parent) : undefined, { digest: expectedDigest });
    const data = removeData
      ? await ifMissing(() => hostExtensionDataDirectory({ dataDir, id }))
      : undefined;
    const configuration = await readConfiguration(root);
    if (configuration.enabled.includes(id))
      await saveConfiguration(
        root,
        configuration,
        configuration.enabled.filter((entry) => entry !== id),
        assertLocked,
      );
    if (parent) {
      const tombstone = path.join(root, `.removed-${randomUUID()}`);
      assertLocked();
      await renamePrivateExtensionPath(parent, tombstone);
      await discard(tombstone);
    }
    if (data) await rm(data, { recursive: true, force: true });
    return Boolean(parent);
  });
}

/** Authorization and enabled-state policy are owned by the Host. This checks the current disk activation. */
export async function readHostExtensionAsset({
  dataDir,
  id,
  path: resource,
  ...expected
}: { dataDir: string } & HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.asset>): Promise<
  HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.asset>
> {
  hostExtensionResourcePathSchema.parse(resource);
  const resolved = await current({ dataDir, id });
  if (!resolved) throw new Error("Extension is not installed");
  const {
    installation: { manifest, digest },
    parent,
    active,
    read,
  } = resolved;
  checkActivation(active, expected);
  if (
    manifest.backend &&
    hostExtensionCanonicalPath(resource) === hostExtensionCanonicalPath(manifest.backend.entry)
  )
    throw new Error("Resource is not a public extension asset");
  let mimeType: string | undefined;
  let max = DESKTOP_EXTENSION_ASSET_MAX_BYTES;
  if (resource.endsWith(".mjs") || hostFrontendEntries(manifest).includes(resource)) {
    mimeType = "text/javascript";
    max = DESKTOP_EXTENSION_SCRIPT_MAX_BYTES;
  } else if (hostFrontendStyles(manifest).includes(resource)) {
    mimeType = "text/css";
    max = DESKTOP_EXTENSION_STYLE_MAX_BYTES;
  } else if (resource === manifest.icon) {
    mimeType = hostExtensionStaticAssetMimeType(resource);
    max = DESKTOP_EXTENSION_ICON_MAX_BYTES;
  } else if (manifest.screenshots?.includes(resource)) {
    mimeType = hostExtensionStaticAssetMimeType(resource);
    max = DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES;
  } else if (resource.startsWith("assets/")) mimeType = hostExtensionStaticAssetMimeType(resource);
  if (!mimeType) throw new Error("Resource is not a public extension asset");
  const bytes = await read(resource, max);
  checkActivation(await readPointer(parent), active);
  return { mimeType, base64: bytes.toString("base64"), digest };
}

/** Host-only loader input. This never imports or executes the backend. */
export async function readHostExtensionBackend(
  location: HostExtensionLocation & {
    activationId?: string | undefined;
    digest?: string | undefined;
  },
) {
  const resolved = await current(location);
  checkActivation(resolved?.active, location);
  const backend = resolved?.installation.manifest.backend;
  if (!resolved || !backend) return;
  const { parent, active, installation, index } = resolved;
  const hash = index.get(backend.entry);
  if (!hash) throw new Error(`Missing backend entry: ${backend.entry}`);
  await verifyHostPackage(installation.directory, index);
  checkActivation(await readPointer(parent), active);
  return {
    directory: installation.directory,
    scriptPath: path.join(installation.directory, backend.entry),
    hash,
    ...active,
  };
}
