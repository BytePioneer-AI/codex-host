import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { AntigravityAdapter } from "./antigravity-adapter.js";

export const ANTIGRAVITY_COMMAND_ENV = "CODEXHOST_ANTIGRAVITY_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): AntigravityAdapter {
  const environment = { ...context.environment };
  return new AntigravityAdapter({
    ...(environment[ANTIGRAVITY_COMMAND_ENV]
      ? { command: environment[ANTIGRAVITY_COMMAND_ENV] }
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
