import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { MUSE_COMMAND_ENV } from "./command.js";
import { MuseAdapter } from "./muse-adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext): MuseAdapter {
  const environment = { ...context.environment };
  return new MuseAdapter({
    ...(environment[MUSE_COMMAND_ENV] ? { command: environment[MUSE_COMMAND_ENV] } : {}),
    environment,
  });
}
