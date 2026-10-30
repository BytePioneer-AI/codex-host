import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { ZcodeAdapter } from "./adapter.js";
import { createZcodeInstallation } from "./installation.js";
export function createHarnessAdapter(context: HarnessPluginContext) {
  const environment = { ...context.environment };
  return Object.assign(
    new ZcodeAdapter({
      environment,
      ...(context.launchCommand ? { app: context.launchCommand } : {}),
      ...(context.openLocalPage ? { openLocalPage: context.openLocalPage } : {}),
    }),
    // Version readback only. No `install`: ZCode Desktop is downloaded by the user.
    { installation: createZcodeInstallation(environment, context.launchCommand) },
  );
}
