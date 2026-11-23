import { z } from "zod";
import { hostThreadIdSchema } from "./ids.js";

export const THREAD_MODEL_FALLBACK_METHOD = "codexhost/thread/model/fallback";
export const MODEL_FALLBACK_NOTICE_MAX_AGE_MS = 30_000;

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);

export const modelFallbackSchema = z
  .object({ id: z.uuid(), fromModel: modelId, toModel: modelId })
  .refine(({ fromModel, toModel }) => fromModel !== toModel);

export type ModelFallback = z.infer<typeof modelFallbackSchema>;

export const modelFallbackNoticeSchema = z.object({
  ...modelFallbackSchema.shape,
  observedAtMs: z.number().int().nonnegative(),
});
export type ModelFallbackNotice = z.infer<typeof modelFallbackNoticeSchema>;

export const threadModelFallbackNotificationSchema = z.object({
  threadId: hostThreadIdSchema,
  fallback: modelFallbackNoticeSchema,
});
