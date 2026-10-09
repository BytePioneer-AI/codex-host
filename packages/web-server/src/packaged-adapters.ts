/** Select already bundled Harness plugins for a relocatable Web distribution. */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { HarnessManifest } from "./harnesses.ts";

/** One prebuilt plugin directory selected for inclusion in the distribution. */
export interface PackagedAdapter {
  id: string;
  directory: string;
}

/**
 * Read prebuilt plugins without importing or executing them. Source-package entries are rejected.
 * @param root - directory containing self-contained plugin directories.
 * @param selected - optional Harness ids; missing ids fail the pack rather than silently disappearing.
 * @returns plugin directories to copy, excluding the Web server's reserved bundled Codex adapter.
 */
export function readPackagedAdapters(
  root: string,
  selected?: ReadonlySet<string>,
): PackagedAdapter[] {
  const plugins: PackagedAdapter[] = [];
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as HarnessManifest;
    if (manifest.kind === "usage") continue;
    if (selected !== undefined && !selected.has(manifest.id)) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(manifest.id) || manifest.id === "codex") {
      throw new Error(`Cannot include Harness id ${manifest.id}; codex is bundled separately`);
    }
    if (plugins.some((plugin) => plugin.id === manifest.id))
      throw new Error(`Duplicate Harness id ${manifest.id}`);
    if (!/\.m?js$/u.test(manifest.entry))
      throw new Error(`${manifest.id}: supply a prebuilt plugin, not source TypeScript`);
    for (const resource of [
      manifest.entry,
      ...(manifest.icon === undefined ? [] : [manifest.icon]),
    ]) {
      const file = realpathSync(join(directory, resource));
      const path = relative(realpathSync(directory), file);
      if (
        isAbsolute(path) ||
        path === ".." ||
        path.startsWith(`..${sep}`) ||
        !statSync(file).isFile()
      ) {
        throw new Error(
          `${manifest.id}: plugin resource must be a file inside its directory: ${resource}`,
        );
      }
    }
    plugins.push({ id: manifest.id, directory });
  }
  for (const id of selected ?? []) {
    if (!plugins.some((plugin) => plugin.id === id))
      throw new Error(`Harness plugin not found: ${id}`);
  }
  return plugins;
}
