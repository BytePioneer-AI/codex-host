import { z } from "zod";

import { hostThreadIdSchema } from "./ids.js";

const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const finiteNonNegativeNumberSchema = z.number().finite().nonnegative();
const cacheHitRatePercentSchema = z.number().finite().min(0).max(100);

export const threadUsageSnapshotSchema = z
  .object({
    inputTokens: nonNegativeSafeIntegerSchema.optional(),
    cachedInputTokens: nonNegativeSafeIntegerSchema.optional(),
    cacheWriteInputTokens: nonNegativeSafeIntegerSchema.optional(),
    outputTokens: nonNegativeSafeIntegerSchema.optional(),
    outputTokensPerSecond: finiteNonNegativeNumberSchema.optional(),
    reasoningOutputTokens: nonNegativeSafeIntegerSchema.optional(),
    totalTokens: nonNegativeSafeIntegerSchema.optional(),
    totalCostUsd: finiteNonNegativeNumberSchema.optional(),
    cacheHitRatePercent: cacheHitRatePercentSchema.optional(),
    contextWindowTokens: nonNegativeSafeIntegerSchema.optional(),
    contextUsedTokens: nonNegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (Object.keys(usage).length === 0) {
      context.addIssue({ code: "custom", message: "Thread Usage must contain a reliable field" });
    }
    const hasContextUsed = usage.contextUsedTokens !== undefined;
    const hasContextWindow = usage.contextWindowTokens !== undefined;
    if (hasContextUsed !== hasContextWindow) {
      context.addIssue({
        code: "custom",
        message: "Thread Usage context fields must be provided together",
        path: [hasContextUsed ? "contextWindowTokens" : "contextUsedTokens"],
      });
    }
    if (usage.contextWindowTokens === 0) {
      context.addIssue({
        code: "custom",
        message: "Thread Usage contextWindowTokens must be greater than zero",
        path: ["contextWindowTokens"],
      });
    }
  });

export type ThreadUsageSnapshot = z.infer<typeof threadUsageSnapshotSchema>;

export const threadUsageInspectionParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
  })
  .strict();

export type ThreadUsageInspectionParams = z.infer<typeof threadUsageInspectionParamsSchema>;

export const threadUsageInspectionSchema = z
  .object({
    threadId: hostThreadIdSchema,
    usage: threadUsageSnapshotSchema.nullable(),
  })
  .strict();

export type ThreadUsageInspection = z.infer<typeof threadUsageInspectionSchema>;
