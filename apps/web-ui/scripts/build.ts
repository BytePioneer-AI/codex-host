/** Build the selected browser plugins directly from the imported frontend sources. */
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build as buildShell } from "vite";
import { build } from "tsdown";
import type { UserConfig } from "tsdown";

const root = resolve(import.meta.dirname, "..");
const { plugins } = JSON.parse(readFileSync(resolve(root, "import-manifest.json"), "utf8")) as {
  plugins: string[];
};
process.env.DSH_CLIENT_TITLE = "CodexHost";
const directories = new Map<string, string>();
for (const file of globSync("packages/*/*/package.json", { cwd: root })) {
  const manifest = JSON.parse(readFileSync(resolve(root, file), "utf8")) as { name: string };
  directories.set(manifest.name, resolve(root, file, ".."));
}
for (const name of plugins) {
  const directory = directories.get(name);
  if (directory === undefined) throw new Error(`Missing browser plugin ${name}`);
  const config = (await import(pathToFileURL(resolve(directory, "tsdown.config.ts")).href)) as {
    default: (options: object) => UserConfig[];
  };
  const browser = config
    .default({})
    .filter((item) => item.platform === "browser" && item.format === "cjs");
  if (browser.length !== 1) throw new Error(`Expected one browser build for ${name}`);
  await build({ ...browser[0], cwd: directory, config: false });
}
await buildShell({ root: resolve(root, "apps/web") });
