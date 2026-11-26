/**
 * Session usage mapping for OmO's classic stdio RPC transport.
 *
 * OmO reports usage in two native shapes, both verified on a real 5.1.83 wire
 * (`.omo/evidence/task-9/10/11-add-omo-harness.md`):
 *
 * - Per message: an assistant `message_end` (and the same record repeated in
 *   `agent_end`) carries `usage { input, output, cacheRead, cacheWrite,
 *   reasoning?, totalTokens?, cost?, costUnknown? }`; a tool-result message may
 *   carry the same shape for nested LLM work. `input` EXCLUDES the cache fields
 *   and `output` INCLUDES reasoning; `totalTokens` (when present) is
 *   `input + cacheRead + cacheWrite + output` (task-11 gate wire:
 *   17788 + 2816 + 0 + 298 = 20902).
 * - Session snapshot: `get_session_stats` answers `{ tokens: { input, output,
 *   cacheRead, cacheWrite, total }, cost, costUnknown?, contextUsage? }` in the
 *   same per-field convention (rpc.md example: 50000 + 40000 + 5000 + 10000 =
 *   105000 = total).
 *
 * The Host convention is the unified one (`inputTokens` includes cache reads
 * and writes, `outputTokens` includes reasoning), so every mapping here adds
 * the cache fields into `inputTokens`.
 *
 * Bookkeeping model (see OmoHarnessSession): one authoritative anchor — a
 * `get_session_stats` read established while the engine is idle — plus the
 * message records observed after it. A published snapshot is always
 * `anchor + observed records` or a fresh anchor, never stale fields carried
 * forward. Numbers this module cannot parse are never defaulted or invented:
 * an unusable record or snapshot is reported as absent (null upstream), so a
 * missing or malformed observation invalidates the running total instead of
 * quietly understating it.
 */

import { parseHostUsage, type HostUsage } from "@codexhost/harness-adapter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative safe integer; anything else makes the field unusable. */
function countField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** A finite non-negative amount (costs are fractional); anything else is unusable. */
function amountField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** One native per-message Usage record, already type-checked. */
export interface OmoUsageRecord {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Present when the native report carried it; `null` when absent or unknown. */
  readonly totalTokens: number | null;
  /** Provider-reported cost total for this request; `null` when absent/unknown. */
  readonly costTotalUsd: number | null;
}

/**
 * Parses one native Usage record. `input`, `output`, `cacheRead` and
 * `cacheWrite` are required (the real wire always reports them); a missing or
 * malformed value makes the whole record unusable. `cost` is optional but, when
 * present, must be a well-formed record; `costUnknown: true` marks the cost as
 * a lower bound, which this adapter reports as unknown rather than wrong.
 */
export function parseOmoUsageRecord(value: unknown): OmoUsageRecord | null {
  if (!isRecord(value)) return null;
  const inputTokens = countField(value.input);
  const outputTokens = countField(value.output);
  const cacheReadTokens = countField(value.cacheRead);
  const cacheWriteTokens = countField(value.cacheWrite);
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null
  ) {
    return null;
  }
  let totalTokens: number | null = null;
  if (value.totalTokens !== undefined && value.totalTokens !== null) {
    totalTokens = countField(value.totalTokens);
    if (totalTokens === null) return null;
  }
  let costTotalUsd: number | null = null;
  if (value.cost !== undefined && value.cost !== null) {
    if (!isRecord(value.cost)) return null;
    const total = amountField(value.cost.total);
    if (total === null) return null;
    costTotalUsd = value.costUnknown === true ? null : total;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costTotalUsd,
  };
}

/** Sums of the records observed since the anchor; `false` flags mark unknown fields. */
export interface OmoUsageDelta {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalTokensKnown: boolean;
  costKnown: boolean;
}

export function emptyOmoUsageDelta(): OmoUsageDelta {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    totalTokensKnown: true,
    costKnown: true,
  };
}

/**
 * Adds one record to the delta. An absent optional field marks that field's
 * cumulative sum unknown (never zero): a sum over records that omitted it is a
 * lower bound, not a total.
 */
export function accumulateOmoUsageRecord(delta: OmoUsageDelta, record: OmoUsageRecord): void {
  delta.inputTokens += record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens;
  delta.cachedInputTokens += record.cacheReadTokens;
  delta.cacheWriteInputTokens += record.cacheWriteTokens;
  delta.outputTokens += record.outputTokens;
  if (record.totalTokens === null) {
    delta.totalTokensKnown = false;
  } else {
    delta.totalTokens += record.totalTokens;
  }
  if (record.costTotalUsd === null) {
    delta.costKnown = false;
  } else {
    delta.totalCostUsd += record.costTotalUsd;
  }
}

/**
 * The token and cost totals of one `get_session_stats` answer, plus its
 * context-window facts (context is only publishable with the anchor itself:
 * the per-message records do not report it, so an accumulated snapshot must
 * not carry the anchor's context forward as if it were current).
 */
export interface OmoUsageAnchor {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly totalTokens: number | null;
  readonly totalCostUsd: number | null;
  readonly contextWindowTokens?: number;
  readonly contextUsedTokens?: number;
  readonly contextUsagePercent?: number;
}

/**
 * Maps a `get_session_stats` answer. `tokens.input/output/cacheRead/cacheWrite`
 * are required; anything missing or malformed makes the anchor unusable (the
 * Session then publishes no usage until a readable answer arrives). Context
 * fields are supplementary: a malformed or partial `contextUsage` is omitted,
 * never zero-filled, and never fails the token anchor.
 */
export function omoUsageAnchorFromSessionStats(data: unknown): OmoUsageAnchor | null {
  if (!isRecord(data)) return null;
  const tokens = isRecord(data.tokens) ? data.tokens : null;
  if (tokens === null) return null;
  const inputTokens = countField(tokens.input);
  const outputTokens = countField(tokens.output);
  const cachedInputTokens = countField(tokens.cacheRead);
  const cacheWriteInputTokens = countField(tokens.cacheWrite);
  if (
    inputTokens === null ||
    outputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null
  ) {
    return null;
  }
  let totalTokens: number | null = null;
  if (tokens.total !== undefined && tokens.total !== null) {
    totalTokens = countField(tokens.total);
    if (totalTokens === null) return null;
  }
  let totalCostUsd: number | null = null;
  if (data.cost !== undefined && data.cost !== null) {
    const cost = amountField(data.cost);
    if (cost === null) return null;
    totalCostUsd = data.costUnknown === true ? null : cost;
  }
  const contextUsage = isRecord(data.contextUsage) ? data.contextUsage : null;
  const contextWindowTokens = contextUsage !== null ? countField(contextUsage.contextWindow) : null;
  const contextUsedTokens = contextUsage !== null ? countField(contextUsage.tokens) : null;
  const contextUsagePercent = contextUsage !== null ? amountField(contextUsage.percent) : null;
  const contextComplete = contextWindowTokens !== null && contextUsedTokens !== null;
  return {
    // Unified convention: the native `input` excludes the cache fields, and
    // `inputTokens` includes cache reads and writes.
    inputTokens: inputTokens + cachedInputTokens + cacheWriteInputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalTokens,
    totalCostUsd,
    ...(contextComplete && contextWindowTokens !== null && contextUsedTokens !== null
      ? { contextWindowTokens, contextUsedTokens }
      : {}),
    ...(contextUsagePercent !== null ? { contextUsagePercent } : {}),
  };
}

/** The anchor as a complete Host snapshot, including its context facts. */
export function omoAnchorHostUsage(anchor: OmoUsageAnchor): HostUsage | null {
  const snapshot: HostUsage = {
    inputTokens: anchor.inputTokens,
    outputTokens: anchor.outputTokens,
    cachedInputTokens: anchor.cachedInputTokens,
    cacheWriteInputTokens: anchor.cacheWriteInputTokens,
    ...(anchor.totalTokens === null ? {} : { totalTokens: anchor.totalTokens }),
    ...(anchor.totalCostUsd === null
      ? {}
      : { totalCostUsd: anchor.totalCostUsd, costSource: "native" as const }),
    ...(anchor.contextWindowTokens === undefined || anchor.contextUsedTokens === undefined
      ? {}
      : {
          contextWindowTokens: anchor.contextWindowTokens,
          contextUsedTokens: anchor.contextUsedTokens,
        }),
    ...(anchor.contextUsagePercent === undefined
      ? {}
      : { contextUsagePercent: anchor.contextUsagePercent }),
    sessionCacheUsage: {
      inputTokens: anchor.inputTokens,
      cachedInputTokens: anchor.cachedInputTokens,
    },
  };
  return publishable(snapshot);
}

/**
 * The anchor plus every record observed after it. Context fields are omitted:
 * only `get_session_stats` reports them, and the anchor's values are stale by
 * the time the first message lands. `reasoningOutputTokens` is omitted for
 * the same reason — the anchor carries no reasoning total, so no cumulative
 * reasoning sum exists without inventing one.
 */
export function omoAccumulatedHostUsage(
  anchor: OmoUsageAnchor,
  delta: OmoUsageDelta,
): HostUsage | null {
  const snapshot: HostUsage = {
    inputTokens: anchor.inputTokens + delta.inputTokens,
    outputTokens: anchor.outputTokens + delta.outputTokens,
    cachedInputTokens: anchor.cachedInputTokens + delta.cachedInputTokens,
    cacheWriteInputTokens: anchor.cacheWriteInputTokens + delta.cacheWriteInputTokens,
    ...(anchor.totalTokens !== null && delta.totalTokensKnown
      ? { totalTokens: anchor.totalTokens + delta.totalTokens }
      : {}),
    ...(anchor.totalCostUsd !== null && delta.costKnown
      ? { totalCostUsd: anchor.totalCostUsd + delta.totalCostUsd, costSource: "native" as const }
      : {}),
    sessionCacheUsage: {
      inputTokens: anchor.inputTokens + delta.inputTokens,
      cachedInputTokens: anchor.cachedInputTokens + delta.cachedInputTokens,
    },
  };
  return publishable(snapshot);
}

/** `parseHostUsage` gate: a snapshot this module could not build validly is never published. */
function publishable(snapshot: HostUsage): HostUsage | null {
  try {
    return parseHostUsage(snapshot);
  } catch {
    return null;
  }
}
