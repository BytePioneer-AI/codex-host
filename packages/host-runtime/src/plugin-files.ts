import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  HARNESS_PLUGIN_ICON_MAX_BYTES,
  HARNESS_PLUGIN_MANIFEST_MAX_BYTES,
  harnessPluginConfigurationSchema,
  type HarnessPluginConfiguration,
} from "@codexhost/shared-contracts";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

/** Resolve both paths: lexical checks alone do not prevent a symlink escape. */
export async function pluginResourcePath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || !inside(root, path.resolve(root, relative))) {
    throw new Error("Plugin resource escapes its root");
  }
  const resolved = await realpath(path.resolve(root, relative));
  if (!inside(root, resolved) || !(await stat(resolved)).isFile()) {
    throw new Error("Plugin resource must be a regular file inside its root");
  }
  return resolved;
}

/** Fixed allocation also bounds files that grow between stat and read. */
export async function readPluginFile(file: string, maximum: number): Promise<Buffer> {
  if (!(await stat(file)).isFile()) throw new Error("Plugin resource is not a regular file");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error("Plugin resource exceeds its limit");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) return buffer.subarray(0, length);
      length += bytesRead;
    }
    throw new Error("Plugin resource exceeds its limit");
  } finally {
    await handle.close();
  }
}

export async function readPluginConfiguration(root: string): Promise<HarnessPluginConfiguration> {
  const file = await pluginResourcePath(root, "enabled.json");
  const bytes = await readPluginFile(file, HARNESS_PLUGIN_MANIFEST_MAX_BYTES);
  return harnessPluginConfigurationSchema.parse(JSON.parse(bytes.toString("utf8")));
}

export async function readPluginIcon(root: string, resource: string): Promise<string> {
  const file = await pluginResourcePath(root, resource);
  const bytes = await readPluginFile(file, HARNESS_PLUGIN_ICON_MAX_BYTES);
  let mime: string;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = "image/png";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = "image/jpeg";
  } else if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    mime = "image/webp";
  } else if (/^\s*(?:<\?xml[^?]*\?>\s*)?<svg\s/iu.test(bytes.toString("utf8"))) {
    // Never inline this markup. SVG is served only as an img data URL, whose
    // image context disables scripting; reject active/external constructs too.
    const svg = bytes.toString("utf8");
    // Same-document paint servers preserve plugin gradients without allowing
    // external URLs. Every other url(...) form remains unsupported.
    const withoutLocalPaint = svg.replace(/url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*\)/giu, "");
    if (
      /<!|<\s*\/?\s*(?:script|foreignObject|style|iframe|image|use)\b|\bon[a-z]+\s*=|\bhref\s*=|url\s*\(/iu.test(
        withoutLocalPaint,
      )
    ) {
      throw new Error("Plugin icon contains unsupported SVG content");
    }
    mime = "image/svg+xml";
  } else {
    throw new Error("Plugin icon format is unsupported");
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
