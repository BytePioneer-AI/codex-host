import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { HMHarnessAdapter } from "./hmharness-adapter.js";

export const HMHARNESS_COMMAND_ENV = "CODEXHOST_HMHARNESS_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): HMHarnessAdapter {
  const environment = { ...context.environment };
  return new HMHarnessAdapter({
    ...(environment[HMHARNESS_COMMAND_ENV] ? { command: environment[HMHARNESS_COMMAND_ENV] } : {}),
    environment,
  });
}
