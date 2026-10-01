import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { KiroAdapter } from "./kiro-adapter.js";
import { createKiroInstallation } from "./installation.js";

export const CODEXHOST_KIRO_COMMAND = "CODEXHOST_KIRO_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): KiroAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new KiroAdapter({
      ...(environment[CODEXHOST_KIRO_COMMAND]
        ? { command: environment[CODEXHOST_KIRO_COMMAND] }
        : {}),
      environment,
    }),
    { installation: createKiroInstallation(environment, environment[CODEXHOST_KIRO_COMMAND]) },
  );
}
