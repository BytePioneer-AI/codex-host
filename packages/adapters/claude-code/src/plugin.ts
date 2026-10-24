import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";

import { ClaudeCodeAdapter, claudeCommandCatalog } from "./claude-code-adapter.js";
import { ClaudeCodeExecutableError, resolveClaudeCodeExecutable } from "./command.js";
import { createClaudeInstallation } from "./installation.js";
import { loadClaudeCodeProfile } from "./profiles.js";

import { createHarnessInstaller } from "@codexhost/harness-discovery";
import { withUserShellEnvironment } from "./user-shell-environment.js";

export const CLAUDE_CODE_COMMAND_ENV = "CODEXHOST_CLAUDE_COMMAND";

export async function createHarnessAdapter(context: HarnessPluginContext): Promise<HarnessAdapter> {
  const harnessId = context.harnessId ?? "claude-code";
  const profile =
    harnessId !== "claude-code"
      ? await loadClaudeCodeProfile(harnessId, context.environment)
      : undefined;

  if (harnessId !== "claude-code" && !profile) {
    throw new Error(`Claude Code profile '${harnessId}' configuration is unavailable`);
  }

  const baseEnvironment = await withUserShellEnvironment({ ...context.environment });
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    ...(profile?.configDir ? { CLAUDE_CONFIG_DIR: profile.configDir } : {}),
    ...(profile?.environment ?? {}),
  };
  const command =
    profile?.command ??
    context.launchCommand ??
    (harnessId === "claude-code" ? environment[CLAUDE_CODE_COMMAND_ENV] : undefined);

  if (context.platform === "darwin" && context.managedRemoteHost) {
    return new BrokeredHarnessAdapter({
      harnessId,
      forwardDelegationEnvironment: true,
      commandCatalog: claudeCommandCatalog,
      liveCommandCatalog: true,
      environment,
      isInstalled: () => {
        try {
          resolveClaudeCodeExecutable({
            ...(command ? { command } : {}),
            environment,
          });
          return true;
        } catch (error) {
          return !(error instanceof ClaudeCodeExecutableError);
        }
      },
      ...(context.brokerDescriptorPath ? { descriptorPath: context.brokerDescriptorPath } : {}),
    });
  }
  return Object.assign(
    new ClaudeCodeAdapter({
      harnessId,
      ...(command ? { command } : {}),
      environment,
    }),
    {
      installation: createClaudeInstallation(environment, command),
      install: createHarnessInstaller(environment, {
        posix: "https://claude.ai/install.sh",
        windows: "https://claude.ai/install.ps1",
      }),
    },
  );
}

export async function warmup(adapter: Pick<HarnessAdapter, "inspect">): Promise<void> {
  // A brokered adapter starts its Aqua broker on demand; prefetching at Host startup
  // would start (and keep resident) a broker no request needed.
  if (adapter instanceof BrokeredHarnessAdapter) return;
  try {
    await adapter.inspect();
  } catch {
    /* Optional prefetch cannot fail Host startup. */
  }
}
