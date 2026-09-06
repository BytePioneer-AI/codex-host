import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { DeepSeekHarnessAdapter } from "./deepseek-harness-adapter.js";

export const DEEPSEEK_HARNESS_COMMAND_ENV = "CODEXHOST_DEEPSEEK_HARNESS_COMMAND";
export const DEEPSEEK_HARNESS_ENDPOINT_ENV = "CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT";

export function createHarnessAdapter(context: HarnessPluginContext): DeepSeekHarnessAdapter {
  const environment = { ...context.environment };
  const openLocalUrl = context.openLocalUrl;
  return new DeepSeekHarnessAdapter({
    ...(environment[DEEPSEEK_HARNESS_COMMAND_ENV]
      ? { command: environment[DEEPSEEK_HARNESS_COMMAND_ENV] }
      : {}),
    ...(environment[DEEPSEEK_HARNESS_ENDPOINT_ENV]
      ? { endpoint: environment[DEEPSEEK_HARNESS_ENDPOINT_ENV] }
      : {}),
    environment,
    ...(!context.managedRemoteHost && openLocalUrl
      ? { openWebUi: (url: URL) => openLocalUrl(url.href) }
      : {}),
  });
}
