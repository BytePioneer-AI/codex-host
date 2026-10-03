import { createHarnessInstaller } from "@codexhost/harness-discovery";
import { CURSOR_COMMAND_CATALOG } from "./slash-commands.js";
import { createCursorInstallation } from "./installation.js";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { CursorAdapter } from "./adapter.js";
import { resolveCursorExecutable } from "./command.js";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";
import type { HarnessAdapter } from "@codexhost/harness-adapter";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  if (context.platform === "darwin" && context.managedRemoteHost) {
    const environment = { ...context.environment };
    return new BrokeredHarnessAdapter({
      harnessId: "cursor-cli",
      forwardDelegationEnvironment: true,
      commandCatalog: CURSOR_COMMAND_CATALOG,
      liveCommandCatalog: true,
      environment,
      isInstalled: () => {
        try {
          resolveCursorExecutable(environment);
          return true;
        } catch {
          return false;
        }
      },
    });
  }
  const environment = { ...context.environment };
  return Object.assign(new CursorAdapter({ environment }), {
    installation: createCursorInstallation(environment),
    install: createHarnessInstaller(environment, {
      posix: "https://cursor.com/install",
      windows: "https://cursor.com/install?win32=true",
    }),
  });
}
