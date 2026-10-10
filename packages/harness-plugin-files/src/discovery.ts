import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  HARNESS_PLUGIN_LIMIT,
  HARNESS_PLUGIN_MANIFEST_MAX_BYTES,
  harnessPluginManifestSchema,
  type HarnessPluginManifest,
} from "@codexhost/shared-contracts";

import { pluginResourcePath, readPluginConfiguration, readPluginFile } from "./plugin-files.js";

export interface InstalledHarnessPlugin {
  /** Resolved plugin directory. */
  root: string;
  manifest: HarnessPluginManifest;
  /** Listed in its root's `enabled.json`. */
  enabled: boolean;
}

export type HarnessPluginDiscoveryDiagnosticCode =
  "invalidRoot" | "invalidConfiguration" | "invalidManifest";

export interface HarnessPluginDiscovery {
  plugins: InstalledHarnessPlugin[];
  /** IDs enabled by any root, including ones whose plugin is missing. */
  enabledIds: Set<string>;
}

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Reads installed plugin manifests without importing any plugin code. A root
 * without `enabled.json` contributes nothing, matching the loader's trust rule.
 */
export async function discoverHarnessPlugins(
  configuredRoots: readonly string[],
  diagnose: (code: HarnessPluginDiscoveryDiagnosticCode) => void = () => undefined,
): Promise<HarnessPluginDiscovery> {
  const plugins: InstalledHarnessPlugin[] = [];
  const enabledIds = new Set<string>();
  const roots = new Set<string>();
  for (const configuredRoot of configuredRoots) {
    if (!path.isAbsolute(configuredRoot)) {
      diagnose("invalidRoot");
      continue;
    }
    let root: string;
    try {
      root = await realpath(configuredRoot);
      if (roots.has(root)) continue;
      roots.add(root);
    } catch (error) {
      if (!missingFile(error)) diagnose("invalidRoot");
      continue;
    }
    let enabled: Set<string>;
    try {
      enabled = new Set((await readPluginConfiguration(root)).enabled);
    } catch (error) {
      if (!missingFile(error)) diagnose("invalidConfiguration");
      continue;
    }
    for (const id of enabled) enabledIds.add(id);
    try {
      const directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name));
      if (directories.length > HARNESS_PLUGIN_LIMIT) {
        diagnose("invalidRoot");
        continue;
      }
      for (const directory of directories) {
        try {
          const file = await pluginResourcePath(root, `${directory.name}/manifest.json`);
          const pluginRoot = await realpath(path.join(root, directory.name));
          // A manifest symlink into another plugin is not the owning plugin's manifest.
          await pluginResourcePath(pluginRoot, "manifest.json");
          const manifest = harnessPluginManifestSchema.parse(
            JSON.parse(
              (await readPluginFile(file, HARNESS_PLUGIN_MANIFEST_MAX_BYTES)).toString("utf8"),
            ),
          );
          plugins.push({ root: pluginRoot, manifest, enabled: enabled.has(manifest.id) });
        } catch {
          diagnose("invalidManifest");
        }
      }
    } catch {
      diagnose("invalidRoot");
    }
  }
  return { plugins, enabledIds };
}
