import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  desktopExtensionScreenshotMimeType,
} from "@codexhost/shared-contracts";
import { assertPrivateExtensionEntry, extensionFileMissing } from "./host-extension-io.js";
import { pluginResourcePath, readPluginFile } from "./plugin-files.js";

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
    const resource = await pluginResourcePath(root, relative);
    // Both the lexical path and the resolved path must traverse owner-controlled directories.
    for (const candidate of new Set([resource, path.resolve(root, relative)])) {
      let dir = path.dirname(candidate);
      while (dir !== root) {
        assertPrivateExtensionEntry(dir, await lstat(dir), true);
        dir = path.dirname(dir);
      }
    }
    assertPrivateExtensionEntry(resource, await lstat(resource), false);
    const bytes = await readPluginFile(resource, maxBytes);
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
