import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { DeepSeekHarnessAdapter } from "@codexhost/adapter-deepseek-harness";
import { GrokAdapter } from "@codexhost/adapter-grok";
import { PiAdapter } from "@codexhost/adapter-pi";
import { OmpAdapter } from "@codexhost/adapter-omp";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { ExternalHarnessId } from "@codexhost/protocol-core";
import { harnessIdSchema } from "@codexhost/shared-contracts";

export const CLAUDE_CODE_COMMAND_ENV = "CODEXHOST_CLAUDE_COMMAND";
export const DEEPSEEK_HARNESS_COMMAND_ENV = "CODEXHOST_DEEPSEEK_HARNESS_COMMAND";
export const DEEPSEEK_HARNESS_ENDPOINT_ENV = "CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT";
export const FAKE_HARNESS_ENV = "CODEXHOST_FAKE_HARNESS";
export const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";
export const GROK_COMMAND_ENV = "CODEXHOST_GROK_COMMAND";
export const OMP_COMMAND_ENV = "CODEXHOST_OMP_COMMAND";

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
): ReadonlyMap<ExternalHarnessId, HarnessAdapter> {
  if (environment[FAKE_HARNESS_ENV] === "1") {
    process.stderr.write(
      `codexhost: Fake Harness Adapter is enabled (${FAKE_HARNESS_ENV}=1); external Harnesses will not call real models\n`,
    );
    return new Map<ExternalHarnessId, HarnessAdapter>([
      ["pi", new FakeHarnessAdapter(harnessIdSchema.parse("pi"))],
      ["claude-code", new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"))],
      ["deepseek-harness", new FakeHarnessAdapter(harnessIdSchema.parse("deepseek-harness"))],
      ["grok", new FakeHarnessAdapter(harnessIdSchema.parse("grok"))],
      ["omp", new FakeHarnessAdapter(harnessIdSchema.parse("omp"))],
    ]);
  }

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
