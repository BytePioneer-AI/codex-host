import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_LIMIT,
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  desktopExtensionIdSchema,
  parseDesktopExtensionManifest,
  type DesktopExtensionManifest,
} from "@codexhost/shared-contracts";
import { pluginResourcePath, readPluginFile } from "./plugin-files.js";

export type DesktopExtensionInstallation = { id: string } & (
  | {
      state: "valid";
      manifest: DesktopExtensionManifest;
      hash: string;
      script: string;
      style?: string;
    }
  | { state: "invalid" | "incompatible"; error: string }
);

export const DESKTOP_EXTENSION_CONFIGURATION_LOCK = ".enabled.lock";

export function desktopExtensionsRoot(dataDirectory: string): string {
  return path.join(dataDirectory, "desktop-extensions");
}

export function desktopExtensionsStatusPath(dataDirectory: string): string {
  return path.join(dataDirectory, "diagnostics", "desktop-extensions-v1.json");
}

export function extensionFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function privateEntry(file: string, directory: boolean): Promise<void> {
  const info = await lstat(file);
  if (directory ? !info.isDirectory() : !info.isFile())
    throw new Error(`${path.basename(file)} must be a regular ${directory ? "directory" : "file"}`);
  if (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))
    throw new Error(
      `${path.basename(file)} must belong to the current user and not permit group/other writes`,
    );
}

export async function privateExtensionDirectory(directory: string): Promise<string> {
  await privateEntry(directory, true);
  return realpath(directory);
}

export async function readExtensionResource(
  root: string,
  relative: string,
  max: number,
): Promise<Buffer> {
  const resource = await pluginResourcePath(root, relative);
  // Check every traversed directory, not only the resource's mode. A writable
  // intermediate directory would let another user replace an owned file.
  for (const candidate of new Set([resource, path.resolve(root, relative)])) {
    let dir = path.dirname(candidate);
    while (dir !== root) {
      await privateEntry(dir, true);
      dir = path.dirname(dir);
    }
  }
  await privateEntry(resource, false);
  return readPluginFile(resource, max);
}

async function discover(root: string, id: string): Promise<DesktopExtensionInstallation> {
  try {
    if (!desktopExtensionIdSchema.safeParse(id).success)
      throw new Error("Invalid extension directory name");
    const directory = await privateExtensionDirectory(path.join(root, id));
    const bytes = await readExtensionResource(
      directory,
      "manifest.json",
      DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
    );
    const data: unknown = JSON.parse(bytes.toString("utf8"));
    if (!data || typeof data !== "object" || !("id" in data) || data.id !== id)
      throw new Error("Manifest id must match the directory name");
    const parsed = parseDesktopExtensionManifest(data);
    if (parsed.state !== "valid") return { id, ...parsed };
    const { desktop } = parsed.manifest;
    const [script, style] = await Promise.all([
      readExtensionResource(directory, desktop.script, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES),
      desktop.style
        ? readExtensionResource(directory, desktop.style, DESKTOP_EXTENSION_STYLE_MAX_BYTES)
        : undefined,
    ]);
    const zero = Buffer.from([0]);
    const hash = createHash("sha256").update(bytes).update(zero).update(script).update(zero);
    if (style) hash.update(style);
    return {
      id,
      state: "valid",
      manifest: parsed.manifest,
      hash: hash.digest("hex"),
      script: new TextDecoder("utf-8", { fatal: true }).decode(script),
      ...(style ? { style: new TextDecoder("utf-8", { fatal: true }).decode(style) } : {}),
    };
  } catch (error) {
    return { id, state: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function discoverDesktopExtensions(configuredRoot: string): Promise<{
  extensions: DesktopExtensionInstallation[];
  diagnostic?: string;
}> {
  try {
    const root = await privateExtensionDirectory(configuredRoot);
    const names = (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.name !== DESKTOP_EXTENSION_CONFIGURATION_LOCK &&
          (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .map((entry) => entry.name)
      .sort();
    if (names.length > DESKTOP_EXTENSION_LIMIT)
      return {
        extensions: [],
        diagnostic: `At most ${DESKTOP_EXTENSION_LIMIT} extensions are supported`,
      };
    const extensions: DesktopExtensionInstallation[] = [];
    for (const id of names) extensions.push(await discover(root, id));
    return { extensions };
  } catch (error) {
    return {
      extensions: [],
      ...(extensionFileMissing(error)
        ? {}
        : { diagnostic: error instanceof Error ? error.message : String(error) }),
    };
  }
}
