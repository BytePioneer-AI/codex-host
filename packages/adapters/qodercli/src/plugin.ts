import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";

import { QoderAdapter } from "./adapter.js";

export const CODEXHOST_QODER_COMMAND = "CODEXHOST_QODER_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  const environment = { ...context.environment };
  if (context.platform === "darwin" && context.managedRemoteHost) {
    return new BrokeredHarnessAdapter({
      harnessId: "qodercli",
      forwardDelegationEnvironment: true,
      environment,
      ...(context.brokerDescriptorPath ? { descriptorPath: context.brokerDescriptorPath } : {}),
    });
  }
  return new QoderAdapter({
    environment,
    ...(environment[CODEXHOST_QODER_COMMAND]
      ? { command: environment[CODEXHOST_QODER_COMMAND] }
      : {}),
  });
}
