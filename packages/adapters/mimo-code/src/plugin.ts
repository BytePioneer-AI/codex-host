import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { MimoAdapter } from "./adapter.js";

export const MIMO_COMMAND_ENV = "CODEXHOST_MIMO_COMMAND";
export function createHarnessAdapter(context: HarnessPluginContext): MimoAdapter {
  return new MimoAdapter({ environment: { ...context.environment } });
}
