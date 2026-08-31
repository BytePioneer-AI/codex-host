import { readFileSync } from "node:fs";

import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { DeepSeekHarnessAdapter } from "@codexhost/adapter-deepseek-harness";
import { GrokAdapter } from "@codexhost/adapter-grok";
import { GeminiAdapter } from "@codexhost/adapter-gemini";
import { PiAdapter } from "@codexhost/adapter-pi";
import { OmpAdapter } from "@codexhost/adapter-omp";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";
import {
  getHarnessConfig,
  HARNESS_CONFIG_PATH_ENV,
  parseHarnessConfigJson,
  resolveHarnessRuntimeEnv,
  resolveHarnessConfigurationPath,
} from "@codexhost/harness-config";

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
export const HARNESS_CONFIG_ENV = HARNESS_CONFIG_PATH_ENV;
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
  const piCommand = environment[PI_COMMAND_ENV] ?? configuredPi?.command;
  const claudeCommand = environment[CLAUDE_CODE_COMMAND_ENV] ?? configuredClaude?.command;
  const deepSeekCommand = environment[DEEPSEEK_HARNESS_COMMAND_ENV] ?? configuredDeepSeek?.command;
  const deepSeekEndpoint = environment[DEEPSEEK_HARNESS_ENDPOINT_ENV];
  const grokCommand = environment[GROK_COMMAND_ENV] ?? configuredGrok?.command;
  const geminiCommand = environment[GEMINI_COMMAND_ENV] ?? configuredGemini?.command;
  const geminiBaseUrl = environment[GEMINI_BASE_URL_ENV] ?? configuredGemini?.baseUrl;
  const geminiApiKeyEnv = environment[GEMINI_API_KEY_ENV] ?? configuredGemini?.apiKeyEnv;
  const geminiApiKey = environment[GEMINI_API_KEY_VALUE_ENV] ?? configuredGemini?.apiKey;
  const geminiModel = environment[GEMINI_MODEL_ENV] ?? configuredGemini?.model;
  const ompCommand = environment[OMP_COMMAND_ENV] ?? configuredOmp?.command;
  return new Map<ExternalHarnessId, HarnessAdapter>([
    [
      "pi",
      new PiAdapter({
        ...(piCommand ? { command: piCommand } : {}),
        environment: resolveHarnessRuntimeEnv(configuredPi, environment, "pi"),
      }),
    ],
    [
      "claude-code",
      new ClaudeCodeAdapter({
        ...(claudeCommand ? { command: claudeCommand } : {}),
        environment: resolveHarnessRuntimeEnv(configuredClaude, environment, "claude-code"),
      }),
    ],
    [
      "deepseek-harness",
      new DeepSeekHarnessAdapter({
        ...(deepSeekCommand ? { command: deepSeekCommand } : {}),
        ...(deepSeekEndpoint ? { endpoint: deepSeekEndpoint } : {}),
        environment: resolveHarnessRuntimeEnv(configuredDeepSeek, environment, "deepseek-harness"),
      }),
    ],
    [
      "grok",
      new GrokAdapter({
        ...(grokCommand ? { command: grokCommand } : {}),
        environment: resolveHarnessRuntimeEnv(configuredGrok, environment, "grok"),
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
        environment: resolveHarnessRuntimeEnv(configuredGemini, environment, "gemini"),
      }),
    ],
    [
      "omp",
      new OmpAdapter({
        ...(ompCommand ? { command: ompCommand } : {}),
        environment: resolveHarnessRuntimeEnv(configuredOmp, environment, "omp"),
      }),
    ],
  ]);
}

function readGeminiConfig(environment: NodeJS.ProcessEnv) {
  return readHarnessConfig(environment, "gemini");
}

function readHarnessConfig(environment: NodeJS.ProcessEnv, harnessId: string) {
  const configPath = resolveHarnessConfigurationPath(environment);
  try {
    return getHarnessConfig(parseHarnessConfigJson(readFileSync(configPath, "utf8")), harnessId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Invalid ${HARNESS_CONFIG_ENV} configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
