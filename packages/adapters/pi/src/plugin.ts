import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { PiAdapter } from "./pi-adapter.js";

export const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): PiAdapter {
  const environment = { ...context.environment };
  return new PiAdapter({
    ...(environment[PI_COMMAND_ENV] ? { command: environment[PI_COMMAND_ENV] } : {}),
    environment,
  });
}
