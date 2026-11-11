import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildHarnessPlugin } from "../../../harness-adapter/scripts/build-plugin.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
function contains(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** Build the same relocatable format as preinstalled plugins, without enabling it in a Host. */
export async function buildPlugin(outputDirectory = path.join(packageRoot, "dist", "plugin")) {
  const output = path.resolve(outputDirectory);
  if (
    contains(output, packageRoot) ||
    (contains(packageRoot, output) && !contains(path.join(packageRoot, "dist"), output))
  )
    throw new Error(
      "Plugin output must not overlap source files; use dist or a separate directory",
    );
  const distribution = JSON.parse(
    await readFile(
      path.resolve(packageRoot, "../../../scripts/release/harness-plugins.json"),
      "utf8",
    ),
  );
  const audit = await buildHarnessPlugin({
    pluginRoot: packageRoot,
    outputRoot: output,
    allowedRuntimePackages: new Set(distribution.runtimePackages),
  });
  return { output, ...audit };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output"))
    throw new Error("usage: build-plugin.mjs [--output <generated-directory>]");
  const { id, output, runtimePackages } = await buildPlugin(args[1]);
  console.log(JSON.stringify({ id, output, runtimePackages }));
}
