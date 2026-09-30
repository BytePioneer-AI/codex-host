import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { OmpAdapter } from "./omp-adapter.js";
import { createOmpInstallation } from "./installation.js";

export const OMP_COMMAND_ENV = "CODEXHOST_OMP_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): OmpAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new OmpAdapter({
      ...(environment[OMP_COMMAND_ENV] ? { command: environment[OMP_COMMAND_ENV] } : {}),
      environment,
    }),
    { installation: createOmpInstallation(environment, environment[OMP_COMMAND_ENV]) },
  );
}
