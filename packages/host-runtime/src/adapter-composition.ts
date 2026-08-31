import { readFileSync } from "node:fs";

import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { DeepSeekHarnessAdapter } from "@codexhost/adapter-deepseek-harness";
import { GrokAdapter } from "@codexhost/adapter-grok";
import { GeminiAdapter } from "@codexhost/adapter-gemini";
import { PiAdapter } from "@codexhost/adapter-pi";
import { OmpAdapter } from "@codexhost/adapter-omp";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";
import { getHarnessConfig, parseHarnessConfigJson } from "@codexhost/harness-config";

export const CLAUDE_CODE_COMMAND_ENV = "CODEXHOST_CLAUDE_COMMAND";
export const DEEPSEEK_HARNESS_COMMAND_ENV = "CODEXHOST_DEEPSEEK_HARNESS_COMMAND";
export const DEEPSEEK_HARNESS_ENDPOINT_ENV = "CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT";
export const PI_COMMAND_ENV = "CODEXHOST_PI_COMMAND";
export const GROK_COMMAND_ENV = "CODEXHOST_GROK_COMMAND";
export const GEMINI_COMMAND_ENV = "CODEXHOST_GEMINI_COMMAND";
export const GEMINI_BASE_URL_ENV = "CODEXHOST_GEMINI_BASE_URL";
export const GEMINI_API_KEY_ENV = "CODEXHOST_GEMINI_API_KEY_ENV";
export const GEMINI_API_KEY_VALUE_ENV = "CODEXHOST_GEMINI_API_KEY";
/** @deprecated Use GEMINI_API_KEY_ENV. */
export const GEMINI_API_KEY_ENV_ENV = GEMINI_API_KEY_ENV;
export const GEMINI_MODEL_ENV = "CODEXHOST_GEMINI_MODEL";
export const HARNESS_CONFIG_ENV = "CODEXHOST_HARNESS_CONFIG";
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
  const configuredGemini = readGeminiConfig(environment);
  const configuredPi = readHarnessConfig(environment, "pi");
  const configuredClaude = readHarnessConfig(environment, "claude-code");
  const configuredDeepSeek = readHarnessConfig(environment, "deepseek-harness");
  const configuredGrok = readHarnessConfig(environment, "grok");
  const configuredOmp = readHarnessConfig(environment, "omp");
  const geminiCommand = environment[GEMINI_COMMAND_ENV] ?? configuredGemini?.command;
  const geminiBaseUrl = environment[GEMINI_BASE_URL_ENV] ?? configuredGemini?.baseUrl;
  const geminiApiKeyEnv = environment[GEMINI_API_KEY_ENV] ?? configuredGemini?.apiKeyEnv;
  const geminiApiKey = environment[GEMINI_API_KEY_VALUE_ENV] ?? configuredGemini?.apiKey;
  const geminiModel = environment[GEMINI_MODEL_ENV] ?? configuredGemini?.model;
  return new Map<ExternalHarnessId, HarnessAdapter>([
    [
      "pi",
      new PiAdapter({
        ...(environment[PI_COMMAND_ENV] ? { command: environment[PI_COMMAND_ENV] } : {}),
        environment: runtimeEnvironment(environment, configuredPi),
      }),
    ],
    [
      "claude-code",
      new ClaudeCodeAdapter({
        ...(environment[CLAUDE_CODE_COMMAND_ENV]
          ? { command: environment[CLAUDE_CODE_COMMAND_ENV] }
          : {}),
        environment: runtimeEnvironment(environment, configuredClaude),
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
        environment: runtimeEnvironment(environment, configuredDeepSeek),
      }),
    ],
    [
      "grok",
      new GrokAdapter({
        ...(environment[GROK_COMMAND_ENV] ? { command: environment[GROK_COMMAND_ENV] } : {}),
        environment: runtimeEnvironment(environment, configuredGrok),
      }),
    ],
    [
      "gemini",
      new GeminiAdapter({
        ...(geminiCommand ? { command: geminiCommand } : {}),
        ...(geminiBaseUrl ? { baseUrl: geminiBaseUrl } : {}),
        ...(geminiApiKeyEnv ? { apiKeyEnv: geminiApiKeyEnv } : {}),
        ...(geminiApiKey ? { apiKey: geminiApiKey } : {}),
        ...(geminiModel ? { model: geminiModel } : {}),
        ...(configuredGemini?.models ? { models: configuredGemini.models } : {}),
        environment: runtimeEnvironment(environment, configuredGemini),
      }),
    ],
    [
      "omp",
      new OmpAdapter({
        ...(environment[OMP_COMMAND_ENV] ? { command: environment[OMP_COMMAND_ENV] } : {}),
        environment: runtimeEnvironment(environment, configuredOmp),
      }),
    ],
  ]);
}

function runtimeEnvironment(
  parent: NodeJS.ProcessEnv,
  config: { environment?: Record<string, string> | undefined } | undefined,
): NodeJS.ProcessEnv {
  return config?.environment ? { ...parent, ...config.environment } : parent;
}

function readGeminiConfig(environment: NodeJS.ProcessEnv) {
  return readHarnessConfig(environment, "gemini");
}

function readHarnessConfig(environment: NodeJS.ProcessEnv, harnessId: string) {
  const configPath = environment[HARNESS_CONFIG_ENV];
  if (!configPath) return undefined;
  try {
    return getHarnessConfig(parseHarnessConfigJson(readFileSync(configPath, "utf8")), harnessId);
  } catch (error) {
    throw new Error(
      `Invalid ${HARNESS_CONFIG_ENV} configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
