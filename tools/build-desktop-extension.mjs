import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { build } from "esbuild";
import {
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  desktopExtensionManifestSchema,
} from "@codexhost/shared-contracts";

async function writeOutput(directory, name, bytes) {
  const destination = path.join(directory, name);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function prepareDirectory(directory, recursive = false) {
  await mkdir(directory, { recursive, mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const entry = await lstat(directory);
  if (!entry.isDirectory()) throw new Error(`Use a real directory, not a symlink: ${directory}`);
  if (process.getuid && (entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0))
    throw new Error(`Directory must belong to you and not allow group/other writes: ${directory}`);
}

const [sourcePath, extensionsRoot, ...extra] = process.argv.slice(2);
if (!sourcePath || !extensionsRoot || extra.length)
  throw new Error("Usage: node tools/build-desktop-extension.mjs <source-dir> <extensions-root>");
const source = path.resolve(sourcePath);
const manifest = desktopExtensionManifestSchema.parse(
  JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")),
);
if (
  manifest.desktop.script !== "desktop.js" ||
  (manifest.desktop.style && manifest.desktop.style !== "desktop.css")
)
  throw new Error("The build tool emits desktop.js and optional desktop.css");
const { outputFiles } = await build({
  entryPoints: [path.join(source, "src", "index.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2022",
  legalComments: "inline",
});
const [script] = outputFiles;
if (!script || outputFiles.length !== 1) throw new Error("Expected one bundled script");
new Script(script.text);
const style = manifest.desktop.style
  ? await readFile(path.join(source, "src", "desktop.css"))
  : undefined;
const root = path.resolve(extensionsRoot);
const directory = path.join(root, manifest.id);
if (source === directory)
  throw new Error("Use a different output directory from the extension source");
const files = [
  ["desktop.js", script.contents, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES],
  ...(style ? [["desktop.css", style, DESKTOP_EXTENSION_STYLE_MAX_BYTES]] : []),
  [
    "manifest.json",
    Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  ],
];
for (const [name, bytes, limit] of files) {
  if (bytes.byteLength > limit) throw new Error(`${name} exceeds ${limit} bytes`);
}
await prepareDirectory(root, true);
await prepareDirectory(directory);
for (const [name, bytes] of files) await writeOutput(directory, name, bytes);
console.log(directory);
