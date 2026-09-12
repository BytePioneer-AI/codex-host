import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { CursorAdapter } from "./adapter.js";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";
import type { HarnessAdapter } from "@codexhost/harness-adapter";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  if (context.platform === "darwin" && context.managedRemoteHost)
    return new BrokeredHarnessAdapter({
      harnessId: "cursor-cli",
      forwardDelegationEnvironment: true,
      environment: { ...context.environment },
    });
  return new CursorAdapter({ environment: { ...context.environment } });
}
