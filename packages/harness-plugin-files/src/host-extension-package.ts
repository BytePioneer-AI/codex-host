import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  desktopExtensionScreenshotMimeType,
  hostExtensionCanonicalPath,
  hostExtensionDigestSchema,
  hostExtensionResourcePathSchema,
  parseHostExtensionManifest,
  type HostExtensionManifest,
  type HostExtensionManifestResult,
} from "@codexhost/shared-contracts";
import { assertPrivateExtensionEntry, readHostFile, utf8 } from "./host-extension-io.js";

export const PACKAGE_INDEX = ".host-extension-generation.json";
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const allowedSuffix =
  /\.(?:js|mjs|cjs|css|json|png|jpe?g|webp|gif|woff2|md|txt|svg|ts|tsx|ya?ml)$/iu;

function packageLimit(resource: string): number {
  if (
    hostExtensionCanonicalPath(resource) === PACKAGE_INDEX ||
    !(
      allowedSuffix.test(resource) ||
      /^(?:licen[cs]e|notice|\.gitignore|\.gitattributes)$/iu.test(path.posix.basename(resource))
    )
  )
    throw new Error(`Unsupported extension package file: ${resource}`);
  if (resource === "manifest.json") return DESKTOP_EXTENSION_MANIFEST_MAX_BYTES;
  if (/\.[cm]?js$/iu.test(resource)) return DESKTOP_EXTENSION_SCRIPT_MAX_BYTES;
  if (/\.css$/iu.test(resource)) return DESKTOP_EXTENSION_STYLE_MAX_BYTES;
  return DESKTOP_EXTENSION_ASSET_MAX_BYTES;
}

type Index = Map<string, string>;
export function indexHostPackage(files: Map<string, Buffer>) {
  let total = 0;
  if (files.size > MAX_ENTRIES) throw new Error("Too many extension package files");
  const entries = [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([resource, bytes]) => {
      hostExtensionResourcePathSchema.parse(resource);
      total += bytes.length;
      if (bytes.length > packageLimit(resource) || total > MAX_PACKAGE_BYTES)
        throw new Error(`Extension package size limit exceeded: ${resource}`);
      return [resource, sha256(bytes)] as const;
    });
  const bytes = Buffer.from(JSON.stringify(entries));
  if (bytes.length > MAX_INDEX_BYTES) throw new Error("Extension index exceeds size limit");
  return { bytes, digest: sha256(bytes) };
}

/** Walk without following links; count directory entries as well as files. */
async function* packageFiles(
  root: string,
  skipIndex = false,
  owned = false,
): AsyncGenerator<string> {
  let count = 0;
  const canonical = new Set<string>();
  async function* walk(prefix: string): AsyncGenerator<string> {
    for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
      const resource = hostExtensionResourcePathSchema.parse(
        prefix ? `${prefix}/${entry.name}` : entry.name,
      );
      if (++count > MAX_ENTRIES + Number(skipIndex))
        throw new Error("Too many extension package entries");
      const key = hostExtensionCanonicalPath(resource);
      if (canonical.has(key)) throw new Error(`Conflicting extension package paths at ${resource}`);
      canonical.add(key);
      if (entry.isDirectory()) {
        const directory = path.join(root, resource);
        const info = await lstat(directory);
        if (owned) assertPrivateExtensionEntry(directory, info, true);
        if (!info.isDirectory()) throw new Error(`Unsafe directory for ${resource}`);
        yield* walk(resource);
      } else if (entry.isFile()) {
        if (!skipIndex || resource !== PACKAGE_INDEX) yield resource;
      } else throw new Error(`Symlink or special file in extension package: ${resource}`);
    }
  }
  yield* walk("");
}
export async function readLocalHostPackage(root: string, { owned = false } = {}) {
  const files = new Map<string, Buffer>();
  let size = 0;
  for await (const resource of packageFiles(root, false, owned)) {
    const bytes = await readHostFile(
      root,
      resource,
      Math.min(packageLimit(resource), MAX_PACKAGE_BYTES - size),
      owned,
    );
    size += bytes.length;
    files.set(resource, bytes);
  }
  return files;
}

export async function readHostPackageIndex(directory: string, digest: string): Promise<Index> {
  const bytes = await readHostFile(directory, PACKAGE_INDEX, MAX_INDEX_BYTES);
  if (sha256(bytes) !== digest) throw new Error("Extension package index digest mismatch");
  const entries: unknown = JSON.parse(utf8.decode(bytes));
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES)
    throw new Error("Invalid extension package index");
  const index: Index = new Map();
  for (const row of entries) {
    if (!Array.isArray(row) || row.length !== 2)
      throw new Error("Invalid extension package index entry");
    const resource = hostExtensionResourcePathSchema.parse(row[0]);
    packageLimit(resource);
    if (index.has(resource)) throw new Error("Duplicate extension package index entry");
    index.set(resource, hostExtensionDigestSchema.parse(row[1]));
  }
  return index;
}
export function indexedRead(directory: string, index: Index) {
  return async (resource: string, limit: number) => {
    const hash = index.get(resource);
    if (!hash) throw new Error(`File is missing from the package index: ${resource}`);
    const bytes = await readHostFile(directory, resource, limit);
    if (sha256(bytes) !== hash) throw new Error(`Extension file digest mismatch: ${resource}`);
    return bytes;
  };
}
export async function verifyHostPackage(directory: string, index: Index) {
  const read = indexedRead(directory, index);
  let count = 0;
  let total = 0;
  for await (const resource of packageFiles(directory, true)) {
    total += (await read(resource, Math.min(packageLimit(resource), MAX_PACKAGE_BYTES - total)))
      .length;
    count++;
  }
  if (count !== index.size) throw new Error("Extension package files are missing");
}

type ReadResource = (resource: string, limit: number) => Buffer | Promise<Buffer>;
export class InvalidHostExtensionManifest extends Error {
  constructor(
    readonly state: Exclude<HostExtensionManifestResult["state"], "valid">,
    message: string,
  ) {
    super(message);
  }
}
export async function readHostManifest(read: ReadResource) {
  const result = parseHostExtensionManifest(
    JSON.parse(utf8.decode(await read("manifest.json", DESKTOP_EXTENSION_MANIFEST_MAX_BYTES))),
  );
  if (result.state !== "valid") throw new InvalidHostExtensionManifest(result.state, result.error);
  return result.manifest;
}
export function hostFrontendEntries({ page, widget, desktop, web }: HostExtensionManifest) {
  return [page?.entry, widget?.entry, desktop?.script, web?.entry];
}
export function hostFrontendStyles({ page, widget, desktop, web }: HostExtensionManifest) {
  return [page?.style, widget?.style, desktop?.style, web?.style];
}

async function image(read: ReadResource, resource: string, limit: number) {
  const bytes = await read(resource, limit);
  const mime = desktopExtensionScreenshotMimeType(resource);
  const valid =
    mime === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : mime === "image/jpeg"
        ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
        : mime === "image/webp" &&
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error(`Invalid image signature: ${resource}`);
  return { bytes, mime };
}
export async function validateHostPackageEntries(
  manifest: HostExtensionManifest,
  read: ReadResource,
) {
  for (const script of [...hostFrontendEntries(manifest), manifest.backend?.entry])
    if (script) utf8.decode(await read(script, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES));
  for (const style of hostFrontendStyles(manifest))
    if (style) utf8.decode(await read(style, DESKTOP_EXTENSION_STYLE_MAX_BYTES));
  const icon =
    manifest.icon && (await image(read, manifest.icon, DESKTOP_EXTENSION_ICON_MAX_BYTES));
  const screenshots = [];
  for (const resource of manifest.screenshots ?? [])
    screenshots.push(await image(read, resource, DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES));
  return { icon, screenshots };
}
