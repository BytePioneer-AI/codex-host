import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createLauncherUrlOpener } from "./launcher-url-opener.js";

export const HARNESS_PLUGIN_DIRECTORY_ENV = "CODEXHOST_PLUGIN_DIRECTORY";

/** The distribution owns the sibling plugins directory; never search a project cwd. */
export function installedHarnessPluginOptions(
  environment: NodeJS.ProcessEnv,
  managedRemoteHost = false,
  hostRuntimeUrl: string = import.meta.url,
): { pluginRoots: readonly string[]; pluginContext: HarnessPluginContext } {
  const opener = managedRemoteHost ? undefined : createLauncherUrlOpener(environment);
  return {
    pluginRoots: [
      path.join(path.dirname(fileURLToPath(hostRuntimeUrl)), "plugins"),
      environment[HARNESS_PLUGIN_DIRECTORY_ENV] ??
        path.join(
          environment.CODEXHOST_DATA_DIR
            ? path.resolve(environment.CODEXHOST_DATA_DIR)
            : path.join(os.homedir(), ".codexhost"),
          "plugins",
        ),
    ],
    pluginContext: {
      environment,
      platform: process.platform,
      managedRemoteHost,
      ...(opener ? { openLocalUrl: (url: string) => opener(new URL(url)) } : {}),
    },
  };
}
