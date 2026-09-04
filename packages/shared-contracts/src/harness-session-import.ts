import { z } from "zod";

export const HARNESS_SESSION_IMPORT_ID_MAX_LENGTH = 1_024;
export const HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH = 16_384;
export const HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH = 4_096;
export const HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH = 1_000;
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
    running: z.boolean(),
  })
  .strict();

export type HarnessSessionImportCandidate = z.infer<typeof harnessSessionImportCandidateSchema>;
