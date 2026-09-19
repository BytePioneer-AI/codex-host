import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { ZcodeAdapter } from "./adapter.js";
export function createHarnessAdapter(context: HarnessPluginContext) {
  return new ZcodeAdapter({
    desktopSupported: context.platform === "darwin" && !context.managedRemoteHost,
    environment: {
      ...context.environment,
      ...(context.launchCommand ? { CODEXHOST_ZCODE_COMMAND: context.launchCommand } : {}),
    },
  });
}
