import { z } from "zod";

import { hostThreadIdSchema } from "./ids.js";

export const DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH = 1_024;
export const DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH = 16_384;
export const DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH = 4_096;
export const DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH = 1_000;
export const DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX = 8_640_000_000_000_000;
export const DEEPSEEK_MODERN_HOST_THREAD_ID_MAX_LENGTH = 1_024;

const nonBlankTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Value must not be empty or whitespace")
  .refine((value) => !value.includes("\0"), "Value must not contain NUL");

const deepSeekModernSessionIdSchema = nonBlankTextSchema.max(DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH);

export const deepSeekModernSessionCandidateSchema = z
  .object({
    nativeSessionId: deepSeekModernSessionIdSchema,
    title: nonBlankTextSchema.max(DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH).nullable(),
    updatedAt: z.number().int().nonnegative().max(DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX),
    cwd: nonBlankTextSchema.max(DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH),
    running: z.boolean(),
  })
  .strict();

export type DeepSeekModernSessionCandidate = z.infer<typeof deepSeekModernSessionCandidateSchema>;

export const deepSeekModernSessionListParamsSchema = z.object({}).strict();

export type DeepSeekModernSessionListParams = z.infer<typeof deepSeekModernSessionListParamsSchema>;

export const deepSeekModernSessionListResultSchema = z
  .object({
    candidates: z
      .array(deepSeekModernSessionCandidateSchema)
      .max(DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH),
  })
  .strict();

export type DeepSeekModernSessionListResult = z.infer<typeof deepSeekModernSessionListResultSchema>;

export const deepSeekModernSessionImportParamsSchema = z
  .object({
    nativeSessionId: deepSeekModernSessionIdSchema,
  })
  .strict();

export type DeepSeekModernSessionImportParams = z.infer<
  typeof deepSeekModernSessionImportParamsSchema
>;

export const deepSeekModernSessionImportResultSchema = z
  .object({
    threadId: nonBlankTextSchema
      .max(DEEPSEEK_MODERN_HOST_THREAD_ID_MAX_LENGTH)
      .pipe(hostThreadIdSchema),
  })
  .strict();

export type DeepSeekModernSessionImportResult = z.infer<
  typeof deepSeekModernSessionImportResultSchema
>;
