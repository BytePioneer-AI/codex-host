import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { QoderAdapter } from "./qoder-adapter.js";
import { createQoderInstallation } from "./installation.js";
import { CODEXHOST_QODER_COMMAND, CODEXHOST_QODERCN_COMMAND } from "./qoder-command.js";
import type { QoderVariant } from "./qoder-runtime.js";

export { CODEXHOST_QODER_COMMAND };

export function createHarnessAdapter(
  context: HarnessPluginContext,
  variant: QoderVariant = "global",
): QoderAdapter {
  const environment = { ...context.environment };
  const command =
    environment[variant === "cn" ? CODEXHOST_QODERCN_COMMAND : CODEXHOST_QODER_COMMAND];
  return Object.assign(
    new QoderAdapter({
      ...(command ? { commandOverride: command } : {}),
      variant,
      environment,
      platform: context.platform as NodeJS.Platform,
    }),
    { installation: createQoderInstallation(environment, command, variant) },
  );
}
