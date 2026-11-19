import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { QwenCodeAdapter } from "./qwen-code-adapter.js";

export const QWEN_CODE_COMMAND_ENV = "CODEXHOST_QWEN_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): QwenCodeAdapter {
  const environment = { ...context.environment };
  return new QwenCodeAdapter({
    ...(environment[QWEN_CODE_COMMAND_ENV] ? { command: environment[QWEN_CODE_COMMAND_ENV] } : {}),
    environment,
  });
}
