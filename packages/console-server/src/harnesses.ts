import path from "node:path";

import {
  HarnessLaunchSettingsStore,
  discoverHarnessPlugins,
  readPluginIcon,
} from "@codexhost/harness-plugin-files";

import { dataDirectory } from "./paths.js";

export const HARNESS_PLUGIN_DIRECTORY_ENV = "CODEXHOST_PLUGIN_DIRECTORY";

export interface ConsoleHarness {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  /** The plugin accepts a user-chosen installation path. */
  launchCommand: boolean;
  links: { documentation?: string | undefined; installation?: string | undefined } | null;
  icon: string | null;
  launchPath: string | null;
}

/**
 * Same roots as the Host Runtime: the distribution's `plugins` beside the
 * entrypoint, then the per-user plugin directory. A source checkout reads the
 * plugins built for the Host Runtime.
 */
export function harnessPluginRoots(
  appDirectory: string,
  sourceCheckout: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const bundled = sourceCheckout
    ? path.resolve(appDirectory, "..", "..", "host-runtime", "dist", "plugins")
    : path.join(appDirectory, "plugins");
  return [
    bundled,
    environment[HARNESS_PLUGIN_DIRECTORY_ENV] ?? path.join(dataDirectory(environment), "plugins"),
  ];
}

export class ConsoleHarnessError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "ConsoleHarnessError";
  }
}

export interface ConsoleHarnesses {
  list(): Promise<ConsoleHarness[]>;
  setLaunchPath(id: string, value: string | null): Promise<ConsoleHarness>;
}

/**
 * Reads manifests and launch settings only; plugin code is never imported by
 * the console. Launch settings share the Host Runtime's per-plugin files, so
 * a running Host sees the change on its next start.
 */
export function createConsoleHarnesses(
  roots: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): ConsoleHarnesses {
  const store = new HarnessLaunchSettingsStore(environment);
  const list = async (): Promise<ConsoleHarness[]> => {
    const { plugins } = await discoverHarnessPlugins(roots);
    const seen = new Set<string>();
    const harnesses: ConsoleHarness[] = [];
    for (const plugin of plugins) {
      const { manifest } = plugin;
      // Duplicate IDs are not loaded by the Host; list the first only.
      if (seen.has(manifest.id)) continue;
      seen.add(manifest.id);
      const icon = manifest.icon
        ? await readPluginIcon(plugin.root, manifest.icon).catch(() => null)
        : null;
      const launchPath = manifest.launchCommand
        ? await store.get(manifest.id).then(
            (settings) => settings.path,
            () => null,
          )
        : null;
      harnesses.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        enabled: plugin.enabled,
        launchCommand: manifest.launchCommand === true,
        links: manifest.links ?? null,
        icon,
        launchPath,
      });
    }
    return harnesses.sort(
      (left, right) =>
        Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name),
    );
  };
  return {
    list,
    async setLaunchPath(id, value) {
      const harness = (await list()).find((candidate) => candidate.id === id);
      if (!harness) throw new ConsoleHarnessError(404, `Harness '${id}' is not installed`);
      if (!harness.launchCommand) {
        throw new ConsoleHarnessError(400, `Harness '${id}' does not accept an installation path`);
      }
      try {
        const settings = await store.set(id, value);
        return { ...harness, launchPath: settings.path };
      } catch (error) {
        throw new ConsoleHarnessError(400, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
