import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { PiAdapter } from "@codexhost/adapter-pi";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";

export const CLAUDE_CODE_ENABLE_ENV = "CODEXHOST_ENABLE_CLAUDE_CODE";
export const CLAUDE_CODE_COMMAND_ENV = "CODEXHOST_CLAUDE_COMMAND";
export const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";

export function createExternalHarnessAdapters(
  environment: NodeJS.ProcessEnv,
): ReadonlyMap<ExternalHarnessId, HarnessAdapter> {
  const adapters = new Map<ExternalHarnessId, HarnessAdapter>();
  adapters.set(
    "pi",
    new PiAdapter({
      ...(environment[PI_COMMAND_ENV] ? { command: environment[PI_COMMAND_ENV] } : {}),
      environment,
    }),
  );
  if (environment[CLAUDE_CODE_ENABLE_ENV] === "1") {
    adapters.set(
      "claude-code",
      new ClaudeCodeAdapter({
        ...(environment[CLAUDE_CODE_COMMAND_ENV]
          ? { command: environment[CLAUDE_CODE_COMMAND_ENV] }
          : {}),
        environment,
      }),
    );
  }
  return adapters;
}
