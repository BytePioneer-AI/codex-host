import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { CodeBuddyAdapter } from "./codebuddy-adapter.js";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";

export function createHarnessAdapter(context: HarnessPluginContext) {
  if (context.platform === "darwin" && context.managedRemoteHost)
    return new BrokeredHarnessAdapter({
      harnessId: "codebuddy",
      forwardDelegationEnvironment: true,
      environment: { ...context.environment },
    });
  return new CodeBuddyAdapter({ environment: { ...context.environment } });
}
