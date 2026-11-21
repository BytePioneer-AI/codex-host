import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  DESKTOP_EXTENSION_SETTINGS_MAX_BYTES,
  desktopExtensionAssetMimeType,
  desktopExtensionAssetPathSchema,
  desktopExtensionIdSchema,
  jsonObjectSchema,
} from "@codexhost/shared-contracts";
import { withDesktopExtensionInstallationDirectory } from "./extension-configuration.js";
import {
  extensionFileMissing,
  privateExtensionDirectory,
  readExtensionResource,
} from "./extension-discovery.js";

export async function readDesktopExtensionAsset({
  dataDir,
  id,
  assetPath,
}: {
  dataDir: string;
  id: string;
  assetPath: string;
}) {
  const resource = desktopExtensionAssetPathSchema.parse(assetPath);
  const mimeType = desktopExtensionAssetMimeType(resource);
  if (!mimeType) throw new Error("Unsupported Desktop extension asset type");
  const bytes = await withDesktopExtensionInstallationDirectory(dataDir, id, (directory) =>
    readExtensionResource(directory, resource, DESKTOP_EXTENSION_ASSET_MAX_BYTES),
  );
  return { mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
}

type SettingsLocation = { dataDir: string; id: string };
const SETTINGS_FILE = "settings.json";
const WINDOWS_RENAME_DELAYS_MS = [10, 30, 70, 150, 300] as const;

async function replaceSettingsFile(temporary: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const wait = WINDOWS_RENAME_DELAYS_MS[attempt];
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        wait === undefined ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")
      )
        throw error;
      await delay(wait);
    }
  }
}

export function desktopExtensionDataDirectory({ dataDir, id }: SettingsLocation, create: boolean) {
  desktopExtensionIdSchema.parse(id);
  return extensionDataDirectory(path.join(dataDir, "desktop-extension-data"), id, create);
}

export async function extensionDataDirectory(root: string, id: string, create: boolean) {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = path.join(await privateExtensionDirectory(root), id);
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return privateExtensionDirectory(directory);
}

export function readDesktopExtensionSettings(location: SettingsLocation) {
  return readExtensionSettings(desktopExtensionDataDirectory(location, false));
}

export async function readExtensionSettings(location: Promise<string>) {
  try {
    const directory = await location;
    const bytes = await readExtensionResource(
      directory,
      SETTINGS_FILE,
      DESKTOP_EXTENSION_SETTINGS_MAX_BYTES,
    );
    return jsonObjectSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (extensionFileMissing(error)) return {};
    throw error;
  }
}

export function writeDesktopExtensionSettings({
  values,
  ...location
}: SettingsLocation & { values: unknown }) {
  return writeExtensionSettings(() => desktopExtensionDataDirectory(location, true), values);
}

export async function writeExtensionSettings(
  directory: () => Promise<string>,
  values: unknown,
  label = "Desktop extension",
) {
  const object = jsonObjectSchema.parse(values);
  const text = JSON.stringify(object);
  if (Buffer.byteLength(text) > DESKTOP_EXTENSION_SETTINGS_MAX_BYTES)
    throw new RangeError(`${label} settings exceed 1 MiB`);
  await writePrivateExtensionFile(await directory(), SETTINGS_FILE, text);
  return object;
}

export async function writePrivateExtensionFile(directory: string, name: string, text: string) {
  const temporary = path.join(directory, `.write-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await replaceSettingsFile(temporary, path.join(directory, name));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
