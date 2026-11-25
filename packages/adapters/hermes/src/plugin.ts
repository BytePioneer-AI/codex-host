import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createHarnessInstaller } from "@codexhost/harness-discovery";
import { HermesAdapter } from "./hermes-adapter.js";
import { createHermesInstallation } from "./installation.js";

export const HERMES_COMMAND_ENV = "CODEXHOST_HERMES_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): HermesAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new HermesAdapter({
      ...(environment[HERMES_COMMAND_ENV] ? { command: environment[HERMES_COMMAND_ENV] } : {}),
      environment,
    }),
    {
      installation: createHermesInstallation(environment, environment[HERMES_COMMAND_ENV]),
      install: createHarnessInstaller(environment, {
        posix: "https://hermes-agent.nousresearch.com/install.sh",
        windows: "https://hermes-agent.nousresearch.com/install.ps1",
      }),
    },
  );
}
