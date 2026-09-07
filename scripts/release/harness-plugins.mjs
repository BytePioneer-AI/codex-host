import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  harnessPluginConfigurationSchema,
  harnessPluginManifestSchema,
} from "@codexhost/shared-contracts";
import { buildHarnessPlugin } from "../../packages/harness-adapter/scripts/build-plugin.mjs";

const defaultRoot = path.resolve(import.meta.dirname, "../..");

/** Distribution data only. Neither Host nor Renderer imports this list. */
export function preinstalledHarnessPlugins(root = defaultRoot) {
  const distribution = JSON.parse(
    readFileSync(path.join(root, "scripts/release/harness-plugins.json"), "utf8"),
  );
  const plugins = distribution.plugins.map((directory) => {
    if (typeof directory !== "string" || !/^packages\/adapters\/[a-z0-9-]+$/u.test(directory))
      throw new Error("Invalid preinstalled plugin package path");
    const pluginRoot = path.join(root, directory);
    const manifest = harnessPluginManifestSchema.parse(
      JSON.parse(readFileSync(path.join(pluginRoot, "manifest.json"), "utf8")),
    );
    return { pluginRoot, manifest };
  });
  const configuration = harnessPluginConfigurationSchema.parse({
    version: 1,
    enabled: plugins.map(({ manifest }) => manifest.id),
  });
  return { plugins, configuration, allowedRuntimePackages: new Set(distribution.runtimePackages) };
}

export function preinstalledHarnessPluginPaths(prefix = "app/plugins") {
  const { plugins } = preinstalledHarnessPlugins();
  return [
    `${prefix}/enabled.json`,
    ...plugins.flatMap(({ manifest }) => [
      `${prefix}/${manifest.id}/manifest.json`,
      `${prefix}/${manifest.id}/plugin.mjs`,
      ...(manifest.icon ? [path.posix.join(prefix, manifest.id, manifest.icon)] : []),
    ]),
  ].sort();
}

/** outputDirectory is a generated build directory, never the user's plugin root. */
export async function buildPreinstalledHarnessPlugins({
  repositoryRoot = defaultRoot,
  outputDirectory,
}) {
  const { plugins, configuration, allowedRuntimePackages } =
    preinstalledHarnessPlugins(repositoryRoot);
  const output = path.resolve(outputDirectory);
  const relative = path.relative(path.resolve(repositoryRoot), output);
  if (
    !relative ||
    relative === "packages" ||
    plugins.some(({ pluginRoot }) =>
      [
        [output, pluginRoot],
        [pluginRoot, output],
      ].some(([parent, candidate]) => {
        const relativePath = path.relative(parent, candidate);
        return (
          !relativePath ||
          (!path.isAbsolute(relativePath) &&
            relativePath !== ".." &&
            !relativePath.startsWith(`..${path.sep}`))
        );
      }),
    )
  )
    throw new Error("Plugin output must not overlap source packages");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const audits = [];
  for (const { pluginRoot, manifest } of plugins) {
    audits.push(
      await buildHarnessPlugin({
        pluginRoot,
        outputRoot: path.join(output, manifest.id),
        allowedRuntimePackages,
      }),
    );
  }
  // Publish enablement only after all reviewed plugins have been built successfully.
  await writeFile(path.join(output, "enabled.json"), `${JSON.stringify(configuration, null, 2)}\n`);
  return audits;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1])
    throw new Error("usage: harness-plugins.mjs --output <generated-directory>");
  await buildPreinstalledHarnessPlugins({ outputDirectory: args[1] });
}
