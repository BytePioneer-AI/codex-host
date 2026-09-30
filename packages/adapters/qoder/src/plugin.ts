import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { QoderAdapter } from "./qoder-adapter.js";
import { createQoderInstallation } from "./installation.js";
import { CODEXHOST_QODER_COMMAND } from "./qoder-command.js";

export { CODEXHOST_QODER_COMMAND };

export function createHarnessAdapter(context: HarnessPluginContext): QoderAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new QoderAdapter({
      ...(environment[CODEXHOST_QODER_COMMAND]
        ? { commandOverride: environment[CODEXHOST_QODER_COMMAND] }
        : {}),
      environment,
      platform: context.platform as NodeJS.Platform,
    }),
    { installation: createQoderInstallation(environment, environment[CODEXHOST_QODER_COMMAND]) },
  );
}
