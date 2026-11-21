import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import {
  hostExtensionIdSchema,
  hostExtensionResourcePathSchema,
} from "@codexhost/shared-contracts";
import { withDesktopExtensionDirectoryLock } from "./extension-configuration.js";
import { extensionFileMissing, privateExtensionDirectory } from "./extension-discovery.js";

export const hostExtensionsRoot = (dataDir: string) => path.join(dataDir, "host-extensions");
export const hostExtensionDataRoot = (dataDir: string) => path.join(dataDir, "host-extension-data");
export type HostExtensionLocation = { dataDir: string; id: string };
export const utf8 = new TextDecoder("utf-8", { fatal: true });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function ifMissing<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (!extensionFileMissing(error)) throw error;
    return undefined;
  }
}

export async function storeRoot(root: string, create: boolean) {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  return privateExtensionDirectory(root);
}
export async function storeChild(root: string, name: string, create = false) {
  const directory = path.join(root, name);
  if (create)
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  return privateExtensionDirectory(directory);
}
export async function hostExtensionDataDirectory(
  { dataDir, id }: HostExtensionLocation,
  create = false,
) {
  return storeChild(
    await storeRoot(hostExtensionDataRoot(dataDir), create),
    hostExtensionIdSchema.parse(id),
    create,
  );
}
export async function withHostExtensionWrite<T>(
  dataDir: string,
  operation: (root: string, assertLocked: () => void) => Promise<T>,
) {
  const root = await storeRoot(hostExtensionsRoot(dataDir), true);
  return withDesktopExtensionDirectoryLock(root, (assertLocked) => operation(root, assertLocked));
}

/** Check each segment before opening and verify the opened inode. The store root is owner-controlled. */
export async function readHostFile(
  root: string,
  relative: string,
  max: number,
  owned = true,
): Promise<Buffer> {
  const parts = hostExtensionResourcePathSchema.parse(relative).split("/");
  const leaf = parts.pop()!;
  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    const info = await lstat(directory);
    if (!info.isDirectory() || (owned && !privateMode(info)))
      throw new Error(`Unsafe directory for ${relative}`);
  }
  const target = path.join(directory, leaf);
  const info = await lstat(target);
  if (!info.isFile() || info.nlink !== 1 || (owned && !privateMode(info)))
    throw new Error(`Unsafe file: ${relative}`);
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.nlink !== 1 ||
      (owned && !privateMode(opened))
    )
      throw new Error(`File changed while opening: ${relative}`);
    if (opened.size > max) throw new Error(`File exceeds its size limit: ${relative}`);
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error(`File changed while reading: ${relative}`);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function privateMode({ uid, mode }: { uid: number; mode: number }) {
  return !process.getuid || (uid === process.getuid() && (mode & 0o022) === 0);
}
