import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { OMO_COMMAND_ENV } from "./command.js";
import { createOmoInstallation } from "./installation.js";
import { OmoAdapter } from "./omo-adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext): OmoAdapter {
  const environment = { ...context.environment };
  const command = environment[OMO_COMMAND_ENV];
  return Object.assign(
    new OmoAdapter({
      environment,
      ...(command ? { command } : {}),
    }),
    {
      // Version management only. C4 is out of scope for v1: codexhost never
      // installs SUL-1.0 software on its own.
      installation: createOmoInstallation(environment, command),
    },
  );
}
