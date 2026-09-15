import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { QoderAdapter } from "./qoder-adapter.js";
import { CODEXHOST_QODER_COMMAND } from "./qoder-command.js";

export { CODEXHOST_QODER_COMMAND };

export function createHarnessAdapter(context: HarnessPluginContext): QoderAdapter {
  const environment = { ...context.environment };
  return new QoderAdapter({
    ...(environment[CODEXHOST_QODER_COMMAND]
      ? { commandOverride: environment[CODEXHOST_QODER_COMMAND] }
      : {}),
    environment,
    platform: context.platform as NodeJS.Platform,
  });
}
