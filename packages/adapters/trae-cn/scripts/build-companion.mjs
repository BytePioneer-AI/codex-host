import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createVSIX, listFiles } from "@vscode/vsce";

const packageRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(packageRoot, "assets", "companion");
const companionFiles = [
  "package.json",
  "README.md",
  "extension.cjs",
  "native.cjs",
  "mcp.cjs",
  "models.cjs",
  "service.cjs",
  "server.cjs",
  "settings.cjs",
  "interactions.cjs",
  "diffs.cjs",
  "history.cjs",
  "reasoning.cjs",
  "permissions.cjs",
  "commands.cjs",
];

/** Build locally with the official packager; never publish or modify source resources. */
export async function buildCompanion(
  outputFile = path.join(packageRoot, "dist", "trae-cn-bridge.vsix"),
) {
  const destination = path.resolve(outputFile);
  if (!destination.endsWith(".vsix")) throw new Error("Companion output must be a .vsix file");
  // tinyglobby resolves /var to /private/var on macOS. Use the same physical
  // root before packaging, or vsce reports escaping relative resource paths.
  const temporaryRoot = await realpath(os.tmpdir());
  const staging = await mkdtemp(path.join(temporaryRoot, "codexhost-trae-companion-"));
  const relative = path.relative(temporaryRoot, staging);
  if (!relative.startsWith("codexhost-trae-companion-") || relative.includes(path.sep))
    throw new Error("Unexpected Companion staging directory");
  try {
    // Package an explicit resource set so local logs, discovery files, probes or
    // credentials beside the source cannot enter the extension archive.
    for (const file of companionFiles)
      await copyFile(path.join(sourceRoot, file), path.join(staging, file));
    await copyFile(path.resolve(packageRoot, "../../../LICENSE"), path.join(staging, "LICENSE"));
    const manifest = JSON.parse(await readFile(path.join(staging, "package.json"), "utf8"));
    // Match createVSIX below: this extension has no packaged npm dependencies.
    // An empty entry-point list still enables npm discovery in vsce and can
    // collect aliased temp roots on macOS (/var versus /private/var).
    const files = await listFiles({ cwd: staging, dependencies: false });
    if (
      files.length !== companionFiles.length + 1 ||
      files.some((file) => ![...companionFiles, "LICENSE"].includes(file))
    )
      throw new Error(`Unexpected Companion package resources: ${JSON.stringify(files)}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await createVSIX({ cwd: staging, packagePath: destination, dependencies: false });
    return {
      path: destination,
      id: `${manifest.publisher}.${manifest.name}`,
      version: manifest.version,
      files: files.sort(),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output"))
    throw new Error("usage: build-companion.mjs [--output <file.vsix>]");
  console.log(JSON.stringify(await buildCompanion(args[1])));
}
