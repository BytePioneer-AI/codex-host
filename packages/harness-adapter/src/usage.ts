export interface HostUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  outputTokensPerSecond?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  /** Known cumulative native credits for this Thread, not account quota or USD. */
  totalCredits?: number;
  contextUsagePercent?: number;
  cacheHitRatePercent?: number;
  contextWindowTokens?: number;
  contextUsedTokens?: number;
  planFiveHourUsedPercent?: number;
  planFiveHourResetsAtUnix?: number;
  planSevenDayUsedPercent?: number;
  planSevenDayResetsAtUnix?: number;
  /** Host-derived: cumulative cache reads / cumulative input across the Session's requests. */
  sessionCacheHitRatePercent?: number;
  /** Host-derived: latest Turn start to its first reasoning or text output, as observed by Host. */
  timeToFirstOutputMs?: number;
  /** How `totalCostUsd` was obtained; present only with `totalCostUsd`. */
  costSource?: HostUsageCostSource;
  /**
   * Host-derived: Models whose requests have no price and are left out of `totalCostUsd`, which
   * is then a lower bound. Present only with a `publicPrice` cost; omitted when complete.
   */
  unpricedModels?: string[];
}

export type HostUsageCostSource = "publicPrice" | "native";

/** Fields only Host metering may publish; Adapter snapshots carrying them are stripped by Host. */
export const hostDerivedUsageFields = [
  "sessionCacheHitRatePercent",
  "timeToFirstOutputMs",
  "costSource",
  "unpricedModels",
] as const satisfies ReadonlyArray<keyof HostUsage>;

const tokenFields = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "contextWindowTokens",
  "contextUsedTokens",
] as const satisfies ReadonlyArray<keyof HostUsage>;

const safeIntegerFields = [
  "planFiveHourResetsAtUnix",
  "planSevenDayResetsAtUnix",
  "timeToFirstOutputMs",
] as const satisfies ReadonlyArray<keyof HostUsage>;

const percentFields = [
  "cacheHitRatePercent",
  "sessionCacheHitRatePercent",
  "planFiveHourUsedPercent",
  "planSevenDayUsedPercent",
] as const satisfies ReadonlyArray<keyof HostUsage>;

const usageFields = new Set<keyof HostUsage>([
  ...tokenFields,
  ...safeIntegerFields,
  ...percentFields,
  "totalCostUsd",
  "totalCredits",
  "contextUsagePercent",
  "outputTokensPerSecond",
  "costSource",
  "unpricedModels",
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
  for (const field of ["totalCredits", "contextUsagePercent"] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)
    ) {
      throw new Error(`Harness Usage '${field}' must be a finite non-negative number`);
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
  if (value.costSource !== undefined) {
    if (value.costSource !== "publicPrice" && value.costSource !== "native") {
      throw new Error("Harness Usage 'costSource' must be 'publicPrice' or 'native'");
    }
    if (value.totalCostUsd === undefined) {
      throw new Error("Harness Usage 'costSource' must be provided with 'totalCostUsd'");
    }
  }
  if (value.unpricedModels !== undefined) {
    const models = value.unpricedModels;
    if (
      !Array.isArray(models) ||
      models.length === 0 ||
      !models.every((model) => typeof model === "string" && model.length > 0)
    ) {
      throw new Error("Harness Usage 'unpricedModels' must be a non-empty list of Model IDs");
    }
    if (value.costSource !== "publicPrice") {
      throw new Error("Harness Usage 'unpricedModels' must be provided with a 'publicPrice' cost");
    }
    return { ...value, unpricedModels: [...models] } as HostUsage;
  }
  return { ...value } as HostUsage;
}

/**
 * One native model request in the unified convention: `inputTokens` includes uncached input,
 * cache reads and cache writes; `outputTokens` includes reasoning. A known-zero cache field is
 * an explicit 0; an absent cache field means unknown.
 */
export interface HostUsageRequest {
  /** Stable within the native Session, such as the native message ID. */
  requestId: string;
  /** True when replayed from native history on open. */
  historical?: boolean;
  /** Native model ID actually used, never a UI alias or HarnessModelRef encoding. */
  model?: string;
  /** Standard models.dev provider ID; omitted for user-defined provider aliases. */
  provider?: string;
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  /** Unix ms of this request's first output token and of its completion; both or neither. */
  startedAtMs?: number;
  completedAtMs?: number;
}

const requestTokenFields = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "startedAtMs",
  "completedAtMs",
] as const satisfies ReadonlyArray<keyof HostUsageRequest>;

const requestFields = new Set<string>([
  ...requestTokenFields,
  "requestId",
  "historical",
  "model",
  "provider",
]);

export function parseHostUsageRequest(value: unknown): HostUsageRequest {
  if (!isRecord(value)) throw new Error("Harness Usage request must be an object");
  for (const key of Object.keys(value)) {
    if (!requestFields.has(key)) {
      throw new Error(`Harness Usage request contains unknown field '${key}'`);
    }
  }
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    throw new Error("Harness Usage request 'requestId' must be a non-empty string");
  }
  for (const field of ["model", "provider"] as const) {
    const candidate = value[field];
    if (candidate !== undefined && (typeof candidate !== "string" || candidate.length === 0)) {
      throw new Error(`Harness Usage request '${field}' must be a non-empty string`);
    }
  }
  if (value.historical !== undefined && typeof value.historical !== "boolean") {
    throw new Error("Harness Usage request 'historical' must be a boolean");
  }
  for (const field of requestTokenFields) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)
    ) {
      throw new Error(`Harness Usage request '${field}' must be a non-negative safe integer`);
    }
  }
  if (value.inputTokens === undefined || value.outputTokens === undefined) {
    throw new Error("Harness Usage request must contain 'inputTokens' and 'outputTokens'");
  }
  const request = value as unknown as HostUsageRequest;
  if (
    (request.cachedInputTokens ?? 0) + (request.cacheWriteInputTokens ?? 0) >
    request.inputTokens
  ) {
    throw new Error("Harness Usage request cache Tokens must not exceed 'inputTokens'");
  }
  if ((request.reasoningOutputTokens ?? 0) > request.outputTokens) {
    throw new Error("Harness Usage request 'reasoningOutputTokens' must not exceed 'outputTokens'");
  }
  if ((request.startedAtMs === undefined) !== (request.completedAtMs === undefined)) {
    throw new Error("Harness Usage request timing fields must be provided together");
  }
  if (
    request.startedAtMs !== undefined &&
    request.completedAtMs !== undefined &&
    request.completedAtMs < request.startedAtMs
  ) {
    throw new Error("Harness Usage request 'completedAtMs' must not precede 'startedAtMs'");
  }
  return { ...request };
}
