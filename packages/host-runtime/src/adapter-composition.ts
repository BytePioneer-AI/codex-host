import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { DeepSeekHarnessAdapter } from "@codexhost/adapter-deepseek-harness";
import { GrokAdapter } from "@codexhost/adapter-grok";
import { OpenCodeAdapter } from "@codexhost/adapter-opencode";
import { PiAdapter } from "@codexhost/adapter-pi";
import { OmpAdapter } from "@codexhost/adapter-omp";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";

import { withUserShellEnvironment } from "./user-shell-environment.js";

export const CLAUDE_CODE_COMMAND_ENV = "CODEXHOST_CLAUDE_COMMAND";
export const DEEPSEEK_HARNESS_COMMAND_ENV = "CODEXHOST_DEEPSEEK_HARNESS_COMMAND";
export const DEEPSEEK_HARNESS_ENDPOINT_ENV = "CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT";
export const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";
export const GROK_COMMAND_ENV = "CODEXHOST_GROK_COMMAND";
export const OMP_COMMAND_ENV = "CODEXHOST_OMP_COMMAND";
export const OPENCODE_COMMAND_ENV = "CODEXHOST_OPENCODE_COMMAND";

type InspectableHarnessAdapter = Pick<HarnessAdapter, "inspect">;

export async function prefetchClaudeCodeModelCatalog(
  adapters: ReadonlyMap<ExternalHarnessId, InspectableHarnessAdapter>,
): Promise<void> {
  try {
    await adapters.get("claude-code")?.inspect();
  } catch {
    // Startup prefetch must not affect official Codex or another Harness.
  }
}

export function createExternalHarnessAdapters(
  environment: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    managedRemoteHost?: boolean;
    brokerDescriptorPath?: string;
  } = {},
): ReadonlyMap<ExternalHarnessId, HarnessAdapter> {
  const claudeEnvironment = withUserShellEnvironment(environment);
  const claudeAdapter =
    (options.platform ?? process.platform) === "darwin" && options.managedRemoteHost === true
      ? new BrokeredHarnessAdapter({
          environment: claudeEnvironment,
          ...(options.brokerDescriptorPath ? { descriptorPath: options.brokerDescriptorPath } : {}),
        })
      : new ClaudeCodeAdapter({
          ...(claudeEnvironment[CLAUDE_CODE_COMMAND_ENV]
            ? { command: claudeEnvironment[CLAUDE_CODE_COMMAND_ENV] }
            : {}),
          environment: claudeEnvironment,
        });
  return new Map<ExternalHarnessId, HarnessAdapter>([
    [
      "pi",
      new PiAdapter({
        ...(environment[PI_COMMAND_ENV] ? { command: environment[PI_COMMAND_ENV] } : {}),
        environment,
      }),
    ],
    ["claude-code", claudeAdapter],
    [
      "deepseek-harness",
      new DeepSeekHarnessAdapter({
        ...(environment[DEEPSEEK_HARNESS_COMMAND_ENV]
          ? { command: environment[DEEPSEEK_HARNESS_COMMAND_ENV] }
          : {}),
        ...(environment[DEEPSEEK_HARNESS_ENDPOINT_ENV]
          ? { endpoint: environment[DEEPSEEK_HARNESS_ENDPOINT_ENV] }
          : {}),
        environment,
      }),
    ],
    [
      "opencode",
      new OpenCodeAdapter({
        ...(environment[OPENCODE_COMMAND_ENV]
          ? { command: environment[OPENCODE_COMMAND_ENV] }
          : {}),
        environment,
      }),
    ],
    [
      "grok",
      new GrokAdapter({
        ...(environment[GROK_COMMAND_ENV] ? { command: environment[GROK_COMMAND_ENV] } : {}),
        environment,
      }),
    ],
    [
      "omp",
      new OmpAdapter({
        ...(environment[OMP_COMMAND_ENV] ? { command: environment[OMP_COMMAND_ENV] } : {}),
        environment,
      }),
    ],
  ]);
}
