import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { TraeAdapter } from "./adapter.js";
import { createTraeInstallation } from "./installation.js";

export function createHarnessAdapter(context: HarnessPluginContext): TraeAdapter {
  const environment = { ...context.environment };
  const command = environment.CODEXHOST_TRAE_COMMAND;
  return Object.assign(new TraeAdapter({ environment, ...(command ? { command } : {}) }), {
    installation: createTraeInstallation(environment, command),
  });
}
