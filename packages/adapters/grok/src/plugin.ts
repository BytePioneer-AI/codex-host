import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { GrokAdapter } from "./grok-adapter.js";
import { createGrokInstallation } from "./installation.js";

export const GROK_COMMAND_ENV = "CODEXHOST_GROK_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): GrokAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new GrokAdapter({
      ...(environment[GROK_COMMAND_ENV] ? { command: environment[GROK_COMMAND_ENV] } : {}),
      environment,
    }),
    { installation: createGrokInstallation(environment, environment[GROK_COMMAND_ENV]) },
  );
}
