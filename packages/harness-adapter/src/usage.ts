export interface HostUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  outputTokensPerSecond?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  cacheHitRatePercent?: number;
  contextWindowTokens?: number;
  contextUsedTokens?: number;
  planFiveHourUsedPercent?: number;
  planFiveHourResetsAtUnix?: number;
  planSevenDayUsedPercent?: number;
  planSevenDayResetsAtUnix?: number;
}

const tokenFields = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "outputTokensPerSecond",
  "reasoningOutputTokens",
  "totalTokens",
  "contextWindowTokens",
  "contextUsedTokens",
] as const satisfies ReadonlyArray<keyof HostUsage>;

const safeIntegerFields = [
  "planFiveHourResetsAtUnix",
  "planSevenDayResetsAtUnix",
] as const satisfies ReadonlyArray<keyof HostUsage>;

const percentFields = [
  "cacheHitRatePercent",
  "planFiveHourUsedPercent",
  "planSevenDayUsedPercent",
] as const satisfies ReadonlyArray<keyof HostUsage>;

const usageFields = new Set<keyof HostUsage>([
  ...tokenFields,
  ...safeIntegerFields,
  ...percentFields,
  "totalCostUsd",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHostUsage(value: unknown): HostUsage {
  if (!isRecord(value)) throw new Error("Harness Usage must be an object");
  const keys = Object.keys(value);
  if (keys.length === 0) throw new Error("Harness Usage must contain a reliable field");
  for (const key of keys) {
    if (!usageFields.has(key as keyof HostUsage)) {
      throw new Error(`Harness Usage contains unknown field '${key}'`);
    }
  }
  for (const field of tokenFields) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)
    ) {
      throw new Error(`Harness Usage '${field}' must be a non-negative safe integer`);
    }
  }
  for (const field of safeIntegerFields) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)
    ) {
      throw new Error(`Harness Usage '${field}' must be a non-negative safe integer`);
    }
  }
  if (
    value.outputTokensPerSecond !== undefined &&
    (typeof value.outputTokensPerSecond !== "number" ||
      !Number.isFinite(value.outputTokensPerSecond) ||
      value.outputTokensPerSecond < 0)
  ) {
    throw new Error("Harness Usage 'outputTokensPerSecond' must be a finite non-negative number");
  }
  if (
    value.totalCostUsd !== undefined &&
    (typeof value.totalCostUsd !== "number" ||
      !Number.isFinite(value.totalCostUsd) ||
      value.totalCostUsd < 0)
  ) {
    throw new Error("Harness Usage 'totalCostUsd' must be a finite non-negative number");
  }
  for (const field of percentFields) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        candidate < 0 ||
        candidate > 100)
    ) {
      throw new Error(`Harness Usage '${field}' must be between 0 and 100`);
    }
  }
  const hasContextUsed = value.contextUsedTokens !== undefined;
  const hasContextWindow = value.contextWindowTokens !== undefined;
  if (hasContextUsed !== hasContextWindow) {
    throw new Error("Harness Usage context fields must be provided together");
  }
  if (hasContextWindow && value.contextWindowTokens === 0) {
    throw new Error("Harness Usage 'contextWindowTokens' must be greater than zero");
  }
  if (value.planFiveHourResetsAtUnix !== undefined && value.planFiveHourUsedPercent === undefined) {
    throw new Error(
      "Harness Usage 'planFiveHourResetsAtUnix' must be provided with 'planFiveHourUsedPercent'",
    );
  }
  if (value.planSevenDayResetsAtUnix !== undefined && value.planSevenDayUsedPercent === undefined) {
    throw new Error(
      "Harness Usage 'planSevenDayResetsAtUnix' must be provided with 'planSevenDayUsedPercent'",
    );
  }
  return { ...value } as HostUsage;
}
