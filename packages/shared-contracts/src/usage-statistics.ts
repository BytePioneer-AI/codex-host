import { z } from "zod";

/**
 * Machine-wide usage statistics of the Host's own machine: every native session of the Harnesses
 * that expose local usage, deduplicated by request and priced by Model ID at read time.
 */
export const USAGE_STATISTICS_METHOD = "codexhost/usage/statistics/get";

export const USAGE_STATISTICS_RANGES = ["today", "7d", "30d", "90d", "all"] as const;
export type UsageStatisticsRange = (typeof USAGE_STATISTICS_RANGES)[number];

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const harness = z.string().min(1).max(128);
const model = z.string().min(1).max(512);
/** A session's absolute working directory, as the Harness recorded it. */
const project = z.string().min(1).max(4096);

/**
 * What to aggregate: a range, optionally narrowed to one Harness, Model, project or day.
 * A null Model or project selects the requests whose native record names none.
 */
export const usageStatisticsParamsSchema = z.strictObject({
  range: z.enum(USAGE_STATISTICS_RANGES),
  harness: harness.optional(),
  model: model.nullable().optional(),
  project: project.nullable().optional(),
  /** One local date inside the range. */
  date: localDate.optional(),
});

/**
 * Sums over requests. Tokens follow the unified convention: input includes cache reads and
 * writes, output includes reasoning. Cache counts cover only the requests whose cache split is
 * known (`cacheKnownInputTokens` is their input), so input minus both cache counts is the input
 * that did not come from or go to the cache, plus the whole input of requests with unknown cache.
 */
export const usageStatisticsTotalsSchema = z.strictObject({
  requests: count,
  inputTokens: count,
  cachedInputTokens: count,
  cacheWriteInputTokens: count,
  cacheKnownInputTokens: count,
  outputTokens: count,
  reasoningOutputTokens: count,
  /** USD at the public price, summed over the priced requests only. */
  costUsd: z.number().finite().min(0),
  /** Requests without a price (or the cache data the price needs); not in `costUsd`. */
  unpricedRequests: count,
  /**
   * Requests whose storage gave no token counts: counted as requests, with neither tokens nor
   * cost, and not as unpriced.
   */
  unmeteredRequests: count,
});

const totals = usageStatisticsTotalsSchema.shape;

export const usageStatisticsSessionSchema = z.strictObject({
  harness,
  sessionId: z.string().min(1).max(512),
  project: project.nullable(),
  /** Models the session used, most requests first. */
  models: z.array(model).max(16),
  firstAtMs: count,
  lastAtMs: count,
  ...totals,
});

export const usageStatisticsResultSchema = z.strictObject({
  range: z.enum(USAGE_STATISTICS_RANGES),
  /** First local date of the range; null for all time. */
  from: localDate.nullable(),
  to: localDate,
  /** The filters these figures apply, echoed so a late answer to older filters is recognised. */
  filters: z.strictObject({
    harness: harness.nullable(),
    model: model.nullable(),
    unknownModel: z.boolean(),
    project: project.nullable(),
    unknownProject: z.boolean(),
    date: localDate.nullable(),
  }),
  /** Reading of native storage: incomplete while the first read, or a refresh, is under way. */
  reading: z.strictObject({ complete: z.boolean(), sources: count, read: count }),
  /** Harnesses whose storage could not be read; their part is missing, the rest is complete. */
  failures: z.array(z.strictObject({ harness, message: z.string().max(2048) })).max(256),
  /** Every value seen in the range, ignoring the filters, to choose filters from. */
  options: z.strictObject({
    harnesses: z.array(harness).max(256),
    models: z.array(model.nullable()).max(4096),
    projects: z.array(project.nullable()).max(4096),
  }),
  /** Current display metadata, scoped by Harness. Never a pricing or filter identity.
   * Optional for older Hosts; missing/conflicting labels fall back to the native model ID.
   */
  modelLabels: z
    .array(z.strictObject({ harness, model, label: model }))
    .max(4096)
    .optional(),
  /** Native credits, all filters applied, never combined across Harnesses or treated as USD.
   * Only groups with at least one reported value appear; reportedRequests exposes partial data.
   */
  credits: z
    .array(
      z.strictObject({
        harness,
        model: model.nullable(),
        credits: z.number().finite().min(0),
        reportedRequests: count,
        requests: count,
      }),
    )
    .max(4096)
    .optional(),
  /** All filters applied. */
  totals: usageStatisticsTotalsSchema,
  /** Each date and Harness of the range: every filter except the day. */
  daily: z.array(z.strictObject({ date: localDate, harness, ...totals })).max(200_000),
  /** Local weekday (0 = Sunday) and hour, all filters applied. */
  hourly: z
    .array(
      z.strictObject({
        weekday: z.number().int().min(0).max(6),
        hour: z.number().int().min(0).max(23),
        ...totals,
      }),
    )
    .max(168),
  byHarness: z.array(z.strictObject({ harness, ...totals })).max(256),
  byModel: z
    .array(
      z.strictObject({
        model: model.nullable(),
        ...totals,
        /** Requests priced by what the Harness recorded they cost, not by a price list. */
        harnessPricedRequests: count,
      }),
    )
    .max(4096),
  byProject: z.array(z.strictObject({ project: project.nullable(), ...totals })).max(4096),
  /**
   * The sessions that spent the most, by cost and by tokens without cache, all filters applied;
   * requests without a native session are not listed here but count everywhere else.
   */
  sessions: z.array(usageStatisticsSessionSchema).max(100),
});

export type UsageStatisticsParams = z.infer<typeof usageStatisticsParamsSchema>;
export type UsageStatisticsTotals = z.infer<typeof usageStatisticsTotalsSchema>;
export type UsageStatisticsSession = z.infer<typeof usageStatisticsSessionSchema>;
export type UsageStatisticsResult = z.infer<typeof usageStatisticsResultSchema>;
