import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createHarnessInstaller } from "@codexhost/harness-discovery";
import { AntigravityAdapter } from "./antigravity-adapter.js";
import { createAntigravityInstallation } from "./installation.js";

export const ANTIGRAVITY_COMMAND_ENV = "CODEXHOST_ANTIGRAVITY_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): AntigravityAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new AntigravityAdapter({
      ...(environment[ANTIGRAVITY_COMMAND_ENV]
        ? { command: environment[ANTIGRAVITY_COMMAND_ENV] }
        : {}),
      environment,
    }),
    {
      install: createHarnessInstaller(environment, {
        posix: "https://antigravity.google/cli/install.sh",
        windows: "https://antigravity.google/cli/install.ps1",
      }),
      installation: createAntigravityInstallation(
        environment,
        environment[ANTIGRAVITY_COMMAND_ENV],
      ),
    },
  );
}

export async function warmup(adapter: Pick<HarnessAdapter, "inspect">): Promise<void> {
  try {
    await adapter.inspect();
  } catch {
    /* Optional prefetch cannot fail Host startup. */
  }
}
