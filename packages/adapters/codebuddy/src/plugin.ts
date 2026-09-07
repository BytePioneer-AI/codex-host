import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { CodeBuddyAdapter } from "./codebuddy-adapter.js";

export const CODEBUDDY_COMMAND_ENV = "CODEXHOST_CODEBUDDY_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): CodeBuddyAdapter {
  const environment = { ...context.environment };
  return new CodeBuddyAdapter({
    ...(environment[CODEBUDDY_COMMAND_ENV] ? { command: environment[CODEBUDDY_COMMAND_ENV] } : {}),
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
