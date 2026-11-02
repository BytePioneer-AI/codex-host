import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { DevinAdapter } from "./adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  return new DevinAdapter({ environment: { ...context.environment } });
}
