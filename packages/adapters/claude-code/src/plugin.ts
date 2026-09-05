import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";

import { ClaudeCodeAdapter, claudeCommandCatalog } from "./claude-code-adapter.js";

export const CLAUDE_CODE_COMMAND_ENV = "CODEXHOST_CLAUDE_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  const environment = { ...context.environment };
  if (context.platform === "darwin" && context.managedRemoteHost) {
    return new BrokeredHarnessAdapter({
      commandCatalog: claudeCommandCatalog,
      environment,
      ...(context.brokerDescriptorPath ? { descriptorPath: context.brokerDescriptorPath } : {}),
    });
  }
  return new ClaudeCodeAdapter({
    ...(environment[CLAUDE_CODE_COMMAND_ENV]
      ? { command: environment[CLAUDE_CODE_COMMAND_ENV] }
      : {}),
    environment,
  });
}

export async function warmup(adapter: Pick<HarnessAdapter, "inspect">): Promise<void> {
  try {
    await adapter.inspect();
  } catch {
    /* Optional prefetch cannot fail Host startup. */
  }
}
