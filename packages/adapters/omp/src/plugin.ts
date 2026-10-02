import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createHarnessInstaller } from "@codexhost/harness-discovery";
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
    {
      installation: createOmpInstallation(environment, environment[OMP_COMMAND_ENV]),
      install: createHarnessInstaller(environment, {
        posix: "https://omp.sh/install",
        windows: "https://omp.sh/install.ps1",
        shell: "sh",
      }),
    },
  );
}
