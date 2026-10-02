import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createHarnessInstaller } from "@codexhost/harness-discovery";
import { DeepSeekHarnessAdapter } from "./deepseek-harness-adapter.js";
import type { DeepSeekConnectionMode } from "./desktop-connection.js";
import { createDeepSeekInstallation } from "./installation.js";

export const DEEPSEEK_HARNESS_COMMAND_ENV = "CODEXHOST_DEEPSEEK_HARNESS_COMMAND";
export const DEEPSEEK_HARNESS_ENDPOINT_ENV = "CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT";

export function createHarnessAdapter(context: HarnessPluginContext): DeepSeekHarnessAdapter {
  const environment = { ...context.environment };
  const openLocalUrl = context.openLocalUrl;
  return Object.assign(
    new DeepSeekHarnessAdapter({
      ...(environment[DEEPSEEK_HARNESS_COMMAND_ENV]
        ? { command: environment[DEEPSEEK_HARNESS_COMMAND_ENV] }
        : {}),
      ...(environment[DEEPSEEK_HARNESS_ENDPOINT_ENV]
        ? { endpoint: environment[DEEPSEEK_HARNESS_ENDPOINT_ENV] }
        : {}),
      ...(environment.CODEXHOST_DEEPSEEK_HARNESS_CONNECTION_MODE
        ? {
            connectionMode:
              environment.CODEXHOST_DEEPSEEK_HARNESS_CONNECTION_MODE as DeepSeekConnectionMode,
          }
        : {}),
      ...(context.connectionMode ? { connectionMode: context.connectionMode } : {}),
      environment,
      ...(!context.managedRemoteHost && openLocalUrl
        ? { openWebUi: (url: URL) => openLocalUrl(url.href) }
        : {}),
    }),
    {
      install: createHarnessInstaller(environment, { npm: "@deepseek-ai/dsh@latest" }),
      installation: createDeepSeekInstallation(
        environment,
        environment[DEEPSEEK_HARNESS_COMMAND_ENV],
      ),
    },
  );
}
