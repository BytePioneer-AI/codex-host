import { z } from "zod";

const accountIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const nonBlankTextSchema = z.string().trim().min(1);

export const codexAccountSchema = z
  .object({
    accountId: accountIdSchema,
    label: nonBlankTextSchema.max(256),
    email: z.string().email().max(320).optional(),
    codexHome: nonBlankTextSchema.max(16_384),
    active: z.boolean(),
  })
  .strict();
export type CodexAccountSummary = z.infer<typeof codexAccountSchema>;

export const codexAccountListResultSchema = z
  .object({ accounts: z.array(codexAccountSchema).max(128) })
  .strict();
export type CodexAccountListResult = z.infer<typeof codexAccountListResultSchema>;

export const codexAccountCreateParamsSchema = z
  .object({ label: nonBlankTextSchema.max(256).optional() })
  .strict();
export type CodexAccountCreateParams = z.infer<typeof codexAccountCreateParamsSchema>;

export const codexAccountActivateParamsSchema = z.object({ accountId: accountIdSchema }).strict();
export type CodexAccountActivateParams = z.infer<typeof codexAccountActivateParamsSchema>;

export const codexAccountMutationResultSchema = z.object({ account: codexAccountSchema }).strict();
export type CodexAccountMutationResult = z.infer<typeof codexAccountMutationResultSchema>;

export const codexAccountLoginStartParamsSchema = z.object({ accountId: accountIdSchema }).strict();
export type CodexAccountLoginStartParams = z.infer<typeof codexAccountLoginStartParamsSchema>;

export const codexAccountLoginStartResultSchema = z
  .object({
    accountId: accountIdSchema,
    loginId: nonBlankTextSchema.max(1_024),
    verificationUrl: z.string().url().max(16_384),
    userCode: nonBlankTextSchema.max(1_024),
  })
  .strict();
export type CodexAccountLoginStartResult = z.infer<typeof codexAccountLoginStartResultSchema>;

export const codexAccountLoginCancelParamsSchema = z
  .object({ accountId: accountIdSchema.optional(), loginId: nonBlankTextSchema.max(1_024) })
  .strict();
export type CodexAccountLoginCancelParams = z.infer<typeof codexAccountLoginCancelParamsSchema>;

export const codexAccountLoginCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type CodexAccountLoginCancelResult = z.infer<typeof codexAccountLoginCancelResultSchema>;

export const codexAccountLoginCompletedSchema = z
  .object({
    accountId: accountIdSchema,
    loginId: nonBlankTextSchema.max(1_024),
    success: z.boolean(),
    error: z.string().max(4_096).nullable(),
  })
  .strict();
export type CodexAccountLoginCompleted = z.infer<typeof codexAccountLoginCompletedSchema>;
