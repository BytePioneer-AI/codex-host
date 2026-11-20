import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  DESKTOP_EXTENSION_SETTINGS_MAX_BYTES,
  desktopExtensionAssetMimeType,
  desktopExtensionAssetPathSchema,
  desktopExtensionIdSchema,
  jsonObjectSchema,
} from "@codexhost/shared-contracts";
import {
  desktopExtensionDirectory,
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
  const mimeType = desktopExtensionAssetMimeType(resource)!;
  const directory = await desktopExtensionDirectory(dataDir, id);
  const bytes = await readExtensionResource(directory, resource, DESKTOP_EXTENSION_ASSET_MAX_BYTES);
  return { mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
}

type SettingsLocation = { dataDir: string; id: string };
const SETTINGS_FILE = "settings.json";

export async function desktopExtensionDataDirectory(
  { dataDir, id }: SettingsLocation,
  create: boolean,
) {
  desktopExtensionIdSchema.parse(id);
  const root = path.join(dataDir, "desktop-extension-data");
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = path.join(await privateExtensionDirectory(root), id);
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return privateExtensionDirectory(directory);
}

export async function readDesktopExtensionSettings(location: SettingsLocation) {
  try {
    const directory = await desktopExtensionDataDirectory(location, false);
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

export async function writeDesktopExtensionSettings({
  values,
  ...location
}: SettingsLocation & { values: unknown }) {
  const object = jsonObjectSchema.parse(values);
  const text = JSON.stringify(object);
  if (Buffer.byteLength(text) > DESKTOP_EXTENSION_SETTINGS_MAX_BYTES)
    throw new RangeError("Desktop extension settings exceed 1 MiB");
  const directory = await desktopExtensionDataDirectory(location, true);
  const temporary = path.join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path.join(directory, SETTINGS_FILE));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return object;
}
