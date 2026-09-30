import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { OpenCodeAdapter } from "./versioned-adapter.js";
import { createOpenCodeInstallation } from "./installation.js";

export const OPENCODE_COMMAND_ENV = "CODEXHOST_OPENCODE_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): OpenCodeAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new OpenCodeAdapter({
      ...(environment[OPENCODE_COMMAND_ENV] ? { command: environment[OPENCODE_COMMAND_ENV] } : {}),
      environment,
    }),
    { installation: createOpenCodeInstallation(environment, environment[OPENCODE_COMMAND_ENV]) },
  );
}
