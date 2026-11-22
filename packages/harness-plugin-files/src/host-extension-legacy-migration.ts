// Temporary one-release migration. Next release, delete this file, its export and startup call.
import { constants } from "node:fs";
import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SETTINGS_MAX_BYTES,
  hostExtensionConfigurationSchema,
  hostExtensionIdSchema,
  jsonObjectSchema,
  type HostExtensionConfiguration,
} from "@codexhost/shared-contracts";
import { stageHostExtension } from "./host-extension-files.js";
import {
  assertPrivateExtensionEntry,
  errorMessage,
  hostExtensionDataRoot,
  hostExtensionsRoot,
  ifMissing,
  privateExtensionDirectory,
  readHostFile,
  storeChild,
  storeRoot,
  utf8,
  writePrivateExtensionFile,
} from "./host-extension-io.js";
import { readLocalHostPackage } from "./host-extension-package.js";

async function createIfAbsent(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function readLegacySelection(root: string): Promise<HostExtensionConfiguration> {
  const bytes = await ifMissing(() =>
    readHostFile(root, "enabled.json", DESKTOP_EXTENSION_MANIFEST_MAX_BYTES),
  );
  if (!bytes) return { revision: 0, enabled: [] };
  const config: unknown = JSON.parse(utf8.decode(bytes));
  if (!config || typeof config !== "object" || !("version" in config) || config.version !== 1)
    throw new Error("Expected a v1 extension selection");
  if (!("revision" in config) || !("enabled" in config) || !Array.isArray(config.enabled))
    throw new Error("Expected an enabled list and revision");
  const enabled = new Set<string>();
  for (const id of config.enabled as unknown[]) {
    const parsed = hostExtensionIdSchema.safeParse(id);
    if (parsed.success) enabled.add(parsed.data);
  }
  return hostExtensionConfigurationSchema.parse({
    revision: config.revision,
    enabled: [...enabled],
  });
}

async function migrateData(dataDir: string, id: string) {
  const dataRoot = hostExtensionDataRoot(dataDir);
  const existingRoot = await ifMissing(() => storeRoot(dataRoot, false));
  if (existingRoot && (await ifMissing(() => lstat(path.join(existingRoot, id))))) return;
  const legacyRoot = await ifMissing(() =>
    privateExtensionDirectory(path.join(dataDir, "desktop-extension-data")),
  );
  if (!legacyRoot) return;
  const source = await ifMissing(() => storeChild(legacyRoot, id));
  if (!source) return;

  const bytes = await ifMissing(() =>
    readHostFile(source, "settings.json", DESKTOP_EXTENSION_SETTINGS_MAX_BYTES),
  );
  const settings =
    bytes &&
    JSON.stringify({
      settingsRevision: 0,
      values: jsonObjectSchema.parse(JSON.parse(utf8.decode(bytes))),
    });
  if (settings && Buffer.byteLength(settings) > DESKTOP_EXTENSION_SETTINGS_MAX_BYTES)
    throw new Error("Migrated settings exceed 1 MiB");

  const destination = path.join(existingRoot ?? (await storeRoot(dataRoot, true)), id);
  if (!(await createIfAbsent(destination))) return;
  try {
    for (const name of await readdir(source)) {
      if (name === "settings.json") continue;
      await cp(path.join(source, name), path.join(destination, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        mode: constants.COPYFILE_EXCL,
        async filter(file) {
          const info = await lstat(file);
          assertPrivateExtensionEntry(file, info, info.isDirectory());
          if (info.isFile() && info.nlink !== 1) throw new Error("Hard-linked extension data file");
          return true;
        },
      });
    }
    if (settings) await writePrivateExtensionFile(destination, "settings.json", settings);
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function migrateLegacyDesktopExtensionsOnce(
  dataDir: string,
  diagnose: (message: string) => void = () => undefined,
): Promise<void> {
  const destination = hostExtensionsRoot(dataDir);
  if (await ifMissing(() => lstat(destination))) return;
  const source = await ifMissing(() =>
    privateExtensionDirectory(path.join(dataDir, "desktop-extensions")),
  );
  if (!source || !(await createIfAbsent(destination))) return;

  const selection = await readLegacySelection(source).catch((error: unknown) => {
    diagnose(`Legacy Desktop extension selection: ${errorMessage(error)}`);
    return { revision: 0, enabled: [] };
  });
  const migrated = new Set<string>();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const id = entry.name;
    if (id === ".enabled.lock" || /^\.(?:staging|backup)-/u.test(id)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      hostExtensionIdSchema.parse(id);
      if (id === "enabled.json") throw new Error("Reserved extension ID");
      const prepared = await stageHostExtension({
        dataDir,
        files: await readLocalHostPackage(await storeChild(source, id), { owned: true }),
        expected: { id },
        source: { type: "localDir" },
      });
      await prepared.commit({ expectedDigest: null });
      migrated.add(id);
    } catch (error) {
      diagnose(`Legacy Desktop extension ${JSON.stringify(id)}: ${errorMessage(error)}`);
      continue;
    }
    await migrateData(dataDir, id).catch((error: unknown) => {
      diagnose(`Legacy Desktop extension data (${id}): ${errorMessage(error)}`);
    });
  }
  await writePrivateExtensionFile(
    destination,
    "enabled.json",
    JSON.stringify({
      revision: selection.revision,
      enabled: selection.enabled.filter((id) => migrated.has(id)),
    }),
  );
}
