import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { PiAdapter } from "@codexhost/adapter-pi";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";

export const CLAUDE_CODE_COMMAND_ENV = "CODEXHOST_CLAUDE_COMMAND";
export const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";

export function createExternalHarnessAdapters(
  environment: NodeJS.ProcessEnv,
): ReadonlyMap<ExternalHarnessId, HarnessAdapter> {
  return new Map<ExternalHarnessId, HarnessAdapter>([
    [
      "pi",
      new PiAdapter({
        ...(environment[PI_COMMAND_ENV] ? { command: environment[PI_COMMAND_ENV] } : {}),
        environment,
      }),
    ],
    [
      "claude-code",
      new ClaudeCodeAdapter({
        ...(environment[CLAUDE_CODE_COMMAND_ENV]
          ? { command: environment[CLAUDE_CODE_COMMAND_ENV] }
          : {}),
        environment,
      }),
    ],
  ]);
}
