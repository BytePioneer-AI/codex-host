import type { ClaudeLastRequestUsage } from "./transport.js";

interface ClaudeTokenPrice {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

const PER_MILLION = 1_000_000;

function normalizedModel(model: string): string {
  return model.trim().toLowerCase().replaceAll("_", "-");
}

function firstPartyPrice(model: string): ClaudeTokenPrice | null {
  const value = normalizedModel(model);
  if (/claude-opus-4-(5|6|7|8)(?:-|$)/u.test(value)) {
    return { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };
  }
  if (/claude-opus-4-(0|1)(?:-|$)/u.test(value) || /claude-opus-4-2025/u.test(value)) {
    return { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 };
  }
  if (/claude-sonnet-5(?:-|$)/u.test(value)) {
    return { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 };
  }
  if (/claude-(?:3-7-)?sonnet-(?:4|3-7)(?:-|$)/u.test(value)) {
    return { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
  }
  if (/claude-(?:3-5-)?haiku-(?:4-5|3-5)(?:-|$)/u.test(value)) {
    return value.includes("4-5")
      ? { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }
      : { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 };
  }
  if (/claude-3-haiku(?:-|$)/u.test(value)) {
    return { input: 0.25, cacheWrite: 0.3, cacheRead: 0.03, output: 1.25 };
  }
  return null;
}

export function estimateClaudeRequestCostUsd(usage: ClaudeLastRequestUsage): number | undefined {
  if (!usage.model || usage.provider !== "firstParty") return undefined;
  const price = firstPartyPrice(usage.model);
  if (!price) return undefined;
  const cost =
    (usage.inputTokens * price.input +
      usage.cacheCreationInputTokens * price.cacheWrite +
      usage.cacheReadInputTokens * price.cacheRead +
      usage.outputTokens * price.output) /
    PER_MILLION;
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}
