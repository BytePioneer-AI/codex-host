import { CODEBUDDY_COMMAND_CATALOG } from "./slash-commands.js";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { CodeBuddyAdapter } from "./codebuddy-adapter.js";
import { createCodeBuddyInstallation } from "./installation.js";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";

export function createHarnessAdapter(context: HarnessPluginContext) {
  if (context.platform === "darwin" && context.managedRemoteHost)
    return new BrokeredHarnessAdapter({
      harnessId: "codebuddy",
      forwardDelegationEnvironment: true,
      commandCatalog: CODEBUDDY_COMMAND_CATALOG,
      liveCommandCatalog: true,
      environment: { ...context.environment },
    });
  const environment = { ...context.environment };
  return Object.assign(new CodeBuddyAdapter({ environment }), {
    installation: createCodeBuddyInstallation(environment),
  });
}
