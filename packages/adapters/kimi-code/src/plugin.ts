import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { KimiAdapter } from "./kimi-adapter.js";
import { createKimiInstallation } from "./installation.js";
import { KIMI_COMMAND_ENV } from "./command.js";

export function createHarnessAdapter(context: HarnessPluginContext): KimiAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new KimiAdapter({
      ...(environment[KIMI_COMMAND_ENV] ? { command: environment[KIMI_COMMAND_ENV] } : {}),
      environment,
    }),
    { installation: createKimiInstallation(environment) },
  );
}
