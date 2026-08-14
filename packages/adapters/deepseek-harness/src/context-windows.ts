import type { DeepSeekNativeModelRef } from "./model-catalog.js";

/**
 * Static context-window fallback for DeepSeek provider models, keyed by model
 * id. DeepSeek Harness does not disclose a context window on its model
 * catalog, so codexhost approximates the native context circle from this
 * table. Unknown models carry no context Usage and degrade to the
 * token-only projection.
 */
const CONTEXT_WINDOW_TOKENS_BY_MODEL: Readonly<Record<string, number>> = {
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 128_000,
  "deepseek-v3": 128_000,
  "deepseek-v3.1": 128_000,
  "deepseek-v3.2": 128_000,
  "deepseek-r1": 64_000,
  "deepseek-v4-flash": 128_000,
  "deepseek-v4-pro": 128_000,
};

export function contextWindowTokensForModel(model: DeepSeekNativeModelRef): number | undefined {
  return CONTEXT_WINDOW_TOKENS_BY_MODEL[model.model.trim().toLowerCase()];
}
