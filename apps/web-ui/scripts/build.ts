/**
 * Build the selected browser plugins directly from the imported frontend sources.
 *
 * `--watch` keeps every plugin build and the shell build running and rebuilds on source edits;
 * a Web server started with `--dev-web-ui` picks the new bundles up and pushes them to open pages.
 */
import { copyFileSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build as buildShell } from "vite";
import { build } from "tsdown";
import type { TsdownBundle, UserConfig } from "tsdown";

const root = resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
const { plugins } = JSON.parse(readFileSync(resolve(root, "import-manifest.json"), "utf8")) as {
  plugins: string[];
};
process.env.DSH_CLIENT_TITLE = "CodexHost";
const directories = new Map<string, string>();
for (const file of globSync("packages/*/*/package.json", { cwd: root })) {
  const manifest = JSON.parse(readFileSync(resolve(root, file), "utf8")) as { name: string };
  directories.set(manifest.name, resolve(root, file, ".."));
}
const bundles: TsdownBundle[] = [];
// Every tsdown watcher subscribes to stdin for its keyboard shortcuts.
if (watch) process.stdin.setMaxListeners(plugins.length + 10);
let completedPlugins = 0;
if (watch) console.log("codexhost web: starting Web UI watchers…");
else console.log(`codexhost web: client plugins ${completedPlugins}/${plugins.length}`);
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
  bundles.push(
    ...(await build({
      ...browser[0],
      cwd: directory,
      config: false,
      watch,
      logLevel: watch ? "warn" : "info",
    })),
  );
  completedPlugins++;
  if (!watch) console.log(`codexhost web: client plugins ${completedPlugins}/${plugins.length}`);
}
const settingsPage = resolve(root, "../../packages/renderer-extension/dist/web-settings.js");
const settingsTarget = resolve(root, "apps/web/dist/codexhost-settings.js");
if (!watch) {
  console.log("codexhost web: building browser shell");
  await buildShell({ root: resolve(root, "apps/web") });
  // CodexHost settings pages shared with the console (built by `build:renderer`).
  copyFileSync(settingsPage, settingsTarget);
} else {
  // Keep the served dist in place between rebuilds: emptying it would drop the settings page and
  // the chunks an open page still references.
  const shell = await buildShell({
    root: resolve(root, "apps/web"),
    logLevel: "warn",
    build: { watch: {}, emptyOutDir: false },
  });
  copyFileSync(settingsPage, settingsTarget);
  console.log("codexhost web: watching client plugins and the browser shell");
  const stop = async (): Promise<void> => {
    if ("close" in shell) await shell.close();
    for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
    process.exit(0);
  };
  // Persistent listeners: tsdown bundles signal-exit, which re-raises a signal that finds no
  // other listener and would end the process before the watchers close.
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
