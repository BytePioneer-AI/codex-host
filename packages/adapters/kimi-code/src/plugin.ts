import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { KimiCodeAdapter } from "./adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext): KimiCodeAdapter {
  return new KimiCodeAdapter({
    environment: { ...context.environment },
    ...(context.launchCommand ? { command: context.launchCommand } : {}),
  });
}
