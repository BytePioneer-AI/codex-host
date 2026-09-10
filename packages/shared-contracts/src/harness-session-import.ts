import { z } from "zod";

import { harnessPluginIdSchema } from "./harness-plugins.js";
import { hostThreadIdSchema } from "./ids.js";

export const HARNESS_SESSION_IMPORT_ID_MAX_LENGTH = 1_024;
export const HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH = 16_384;
export const HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH = 4_096;
/** Per-response wire bound, not a storage or total-candidate limit. */
export const HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH = 1_000;
export const HARNESS_SESSION_IMPORT_DEFAULT_PAGE_SIZE = 20;
export const HARNESS_SESSION_IMPORT_UPDATED_AT_MAX = 8_640_000_000_000_000;

const nonBlankTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Value must not be empty or whitespace")
  .refine((value) => !value.includes("\0"), "Value must not contain NUL");

export const harnessSessionImportIdSchema = nonBlankTextSchema.max(
  HARNESS_SESSION_IMPORT_ID_MAX_LENGTH,
);

/** Browser-safe metadata required to map an existing Native Session into codexhost. */
export const harnessSessionImportCandidateSchema = z
  .object({
    nativeSessionId: harnessSessionImportIdSchema,
    title: nonBlankTextSchema.max(HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH).nullable(),
    updatedAt: z.number().int().nonnegative().max(HARNESS_SESSION_IMPORT_UPDATED_AT_MAX),
    cwd: nonBlankTextSchema.max(HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH),
    // Native file discovery cannot reliably observe another process's activity.
    running: z.boolean().nullable(),
  })
  .strict();

export type HarnessSessionImportCandidate = z.infer<typeof harnessSessionImportCandidateSchema>;

export const harnessSessionImportSourcesParamsSchema = z.object({}).strict();
export const harnessSessionImportSourcesResultSchema = z
  .object({
    harnesses: z
      .array(
        z
          .object({
            harnessId: harnessPluginIdSchema,
            name: nonBlankTextSchema.max(128),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export const harnessSessionListParamsSchema = z
  .object({
    harnessId: harnessPluginIdSchema,
    query: z
      .string()
      .trim()
      .max(4_096)
      .refine((value) => !value.includes("\0"))
      .optional(),
    offset: z.number().int().nonnegative().safe().optional(),
    limit: z.number().int().min(1).max(HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH).optional(),
  })
  .strict();
export const harnessSessionListResultSchema = z
  .object({
    candidates: z
      .array(harnessSessionImportCandidateSchema)
      .max(HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH),
    total: z.number().int().nonnegative().safe(),
  })
  .strict();
export const harnessSessionImportParamsSchema = z
  .object({
    harnessId: harnessPluginIdSchema,
    nativeSessionId: harnessSessionImportIdSchema,
  })
  .strict();
export const harnessSessionImportResultSchema = z
  .object({
    threadId: nonBlankTextSchema.max(1_024).pipe(hostThreadIdSchema),
  })
  .strict();
export type HarnessSessionImportSourcesResult = z.infer<
  typeof harnessSessionImportSourcesResultSchema
>;
export type HarnessSessionListParams = z.infer<typeof harnessSessionListParamsSchema>;
export type HarnessSessionListResult = z.infer<typeof harnessSessionListResultSchema>;
export type HarnessSessionImportParams = z.infer<typeof harnessSessionImportParamsSchema>;
export type HarnessSessionImportResult = z.infer<typeof harnessSessionImportResultSchema>;
