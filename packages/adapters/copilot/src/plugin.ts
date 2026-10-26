import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { CopilotAdapter } from "./adapter.js";
import { createCopilotInstallation } from "./installation.js";

export function createHarnessAdapter(context: HarnessPluginContext): CopilotAdapter {
  const environment = { ...context.environment };
  return Object.assign(new CopilotAdapter(environment), {
    installation: createCopilotInstallation(environment),
  });
}
