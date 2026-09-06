import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";
import { harnessPluginManifestSchema } from "@codexhost/shared-contracts";

async function resource(root, relative) {
  const resolved = await realpath(path.join(root, relative));
  const fromRoot = path.relative(root, resolved);
  if (
    !fromRoot ||
    path.isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${path.sep}`) ||
    !(await stat(resolved)).isFile()
  ) {
    throw new Error("Plugin build resource must be a regular file inside its package");
  }
  return resolved;
}

/** Build one relocatable plugin, with no runtime references to workspace packages. */
export async function buildHarnessPlugin({ pluginRoot, outputRoot, allowedRuntimePackages }) {
  const root = await realpath(pluginRoot);
  const manifest = harnessPluginManifestSchema.parse(
    JSON.parse(await readFile(await resource(root, "manifest.json"), "utf8")),
  );
  const entry = await resource(root, manifest.entry);
  await mkdir(outputRoot, { recursive: true });
  const outputPath = path.join(outputRoot, "plugin.mjs");
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    metafile: true,
    treeShaking: true,
    charset: "utf8",
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __codexhostCreateRequire } from "node:module"; const require = __codexhostCreateRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  const runtimePackages = new Set();
  for (const input of inputs) {
    const normalized = `/${input.replaceAll("\\", "/")}/`;
    if (
      /\/(?:test|tests|tools)\//u.test(normalized) ||
      normalized.includes("/node_modules/@anthropic-ai/claude-agent-sdk-")
    ) {
      throw new Error(`Plugin Bundle contains forbidden input: ${input}`);
    }
    const marker = normalized.lastIndexOf("/node_modules/");
    if (marker < 0) continue;
    const segments = normalized.slice(marker + "/node_modules/".length).split("/");
    const packageName = segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (!allowedRuntimePackages.has(packageName))
      throw new Error(`Plugin Bundle contains unreviewed runtime package: ${packageName}`);
    runtimePackages.add(packageName);
  }
  const source = await readFile(outputPath, "utf8");
  if (source.includes("sourceMappingURL="))
    throw new Error("Plugin Bundle contains a source map reference");
  if (manifest.icon) {
    const icon = await resource(root, manifest.icon);
    const destination = path.join(outputRoot, manifest.icon);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(icon, destination);
  }
  await writeFile(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify({ ...manifest, entry: "plugin.mjs" }, null, 2)}\n`,
  );
  return { id: manifest.id, inputs, runtimePackages: [...runtimePackages].sort() };
}
