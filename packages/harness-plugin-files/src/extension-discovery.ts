import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_LIMIT,
  DESKTOP_EXTENSION_LIST_SCREENSHOTS_MAX_BYTES,
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  desktopExtensionIdSchema,
  desktopExtensionScreenshotMimeType,
  parseDesktopExtensionManifest,
  type DesktopExtensionManifest,
} from "@codexhost/shared-contracts";
import { pluginResourcePath, readPluginFile } from "./plugin-files.js";

export type DesktopExtensionInstallation = { id: string } & (
  | {
      state: "valid";
      manifest: DesktopExtensionManifest;
      hash: string;
      script?: string;
      style?: string;
      backend?: { directory: string; scriptPath: string; hash: string; installation: string };
      iconDataUrl?: string;
      screenshotDataUrls?: string[];
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

async function checkedExtensionResource(
  root: string,
  relative: string,
  noSymlinks = false,
): Promise<string> {
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
  if (noSymlinks) await privateEntry(path.resolve(root, relative), false);
  await privateEntry(resource, false);
  return resource;
}

export async function readExtensionResource(
  root: string,
  relative: string,
  max: number,
  { noSymlinks = false }: { noSymlinks?: boolean } = {},
): Promise<Buffer> {
  return readPluginFile(await checkedExtensionResource(root, relative, noSymlinks), max);
}

export async function readDesktopExtensionBackend(directory: string, script: string) {
  try {
    const scriptPath = await checkedExtensionResource(directory, script);
    const bytes = await readPluginFile(scriptPath, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES);
    const { dev, ino } = await stat(directory, { bigint: true });
    return {
      directory,
      scriptPath,
      hash: createHash("sha256").update(bytes).digest("hex"),
      installation: `${dev}:${ino}`,
    };
  } catch (error) {
    if (!extensionFileMissing(error)) throw error;
    throw new Error(`Missing backend entry file ${script}`, { cause: error });
  }
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegSignature = Buffer.from([0xff, 0xd8, 0xff]);
const riffSignature = Buffer.from("RIFF");
const webpSignature = Buffer.from("WEBP");

async function readDesktopExtensionImage(
  root: string,
  relative: string,
  maxBytes: number,
  label: string,
) {
  try {
    const mime = desktopExtensionScreenshotMimeType(relative);
    if (!mime) throw new Error("Unsupported image extension");
    const bytes = await readExtensionResource(root, relative, maxBytes);
    const matches =
      mime === "image/png"
        ? bytes.subarray(0, 8).equals(pngSignature)
        : mime === "image/jpeg"
          ? bytes.subarray(0, 3).equals(jpegSignature)
          : bytes.subarray(0, 4).equals(riffSignature) &&
            bytes.subarray(8, 12).equals(webpSignature);
    if (!matches) throw new Error(`File signature does not match ${mime}`);
    return { bytes, mime };
  } catch (error) {
    const reason = extensionFileMissing(error)
      ? "file not found"
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`${label} ${JSON.stringify(relative)}: ${reason}`, { cause: error });
  }
}

export function readDesktopExtensionIcon(root: string, relative: string) {
  return readDesktopExtensionImage(root, relative, DESKTOP_EXTENSION_ICON_MAX_BYTES, "Icon");
}

export function readDesktopExtensionScreenshot(root: string, relative: string) {
  return readDesktopExtensionImage(
    root,
    relative,
    DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
    "Screenshot",
  );
}

function toImageDataUrl({ bytes, mime }: Awaited<ReturnType<typeof readDesktopExtensionImage>>) {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function isDesktopExtensionTransactionEntry(name: string): boolean {
  return name === DESKTOP_EXTENSION_CONFIGURATION_LOCK || /^\.(?:staging|backup)-/u.test(name);
}

async function discover(
  root: string,
  id: string,
  screenshotBudget: { remaining: number; omitted: boolean },
): Promise<DesktopExtensionInstallation> {
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
    const { desktop, backend } = parsed.manifest;
    const [script, style, backendEntry] = await Promise.all([
      desktop
        ? readExtensionResource(directory, desktop.script, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES)
        : undefined,
      desktop?.style
        ? readExtensionResource(directory, desktop.style, DESKTOP_EXTENSION_STYLE_MAX_BYTES)
        : undefined,
      backend ? readDesktopExtensionBackend(directory, backend.script) : undefined,
    ]);
    const zero = Buffer.from([0]);
    const hash = createHash("sha256").update(bytes).update(zero);
    if (script) hash.update(script);
    hash.update(zero);
    if (style) hash.update(style);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const item: DesktopExtensionInstallation = {
      id,
      state: "valid",
      manifest: parsed.manifest,
      hash: hash.digest("hex"),
      ...(script ? { script: decoder.decode(script) } : {}),
      ...(style ? { style: decoder.decode(style) } : {}),
      ...(backendEntry ? { backend: backendEntry } : {}),
    };
    if (parsed.manifest.icon) {
      // A missing or unreadable logo does not affect an installed extension's availability.
      const icon = await readDesktopExtensionIcon(directory, parsed.manifest.icon).catch(
        () => undefined,
      );
      if (icon) item.iconDataUrl = toImageDataUrl(icon);
    }
    const screenshots = [];
    let screenshotBytes = 0;
    for (const relative of parsed.manifest.screenshots ?? []) {
      const screenshot = await readDesktopExtensionScreenshot(directory, relative);
      screenshots.push(screenshot);
      screenshotBytes += screenshot.bytes.length;
    }
    if (screenshotBytes > screenshotBudget.remaining) {
      screenshotBudget.omitted = true;
    } else if (screenshots.length) {
      screenshotBudget.remaining -= screenshotBytes;
      item.screenshotDataUrls = screenshots.map(toImageDataUrl);
    }
    return item;
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
          !isDesktopExtensionTransactionEntry(entry.name) &&
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
    const screenshotBudget = {
      remaining: DESKTOP_EXTENSION_LIST_SCREENSHOTS_MAX_BYTES,
      omitted: false,
    };
    for (const id of names) extensions.push(await discover(root, id, screenshotBudget));
    return {
      extensions,
      ...(screenshotBudget.omitted
        ? {
            diagnostic:
              "Desktop extension screenshot list size limit exceeded; some previews were omitted",
          }
        : {}),
    };
  } catch (error) {
    return {
      extensions: [],
      ...(extensionFileMissing(error)
        ? {}
        : { diagnostic: error instanceof Error ? error.message : String(error) }),
    };
  }
}
