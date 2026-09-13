import { z } from "zod";
import { accountCreditsSnapshotSchema, threadUsageSnapshotSchema } from "./thread-usage.js";

const accountIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const nonBlankTextSchema = z.string().trim().min(1);

export const codexAccountPlanTypeSchema = z.enum([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro",
  "unknown",
]);
export type CodexAccountPlanType = z.infer<typeof codexAccountPlanTypeSchema>;

export const codexAccountSchema = z
  .object({
    accountId: accountIdSchema,
    label: nonBlankTextSchema.max(256),
    email: z.string().email().max(320).optional(),
    planType: codexAccountPlanTypeSchema.optional(),
  })
  .strict();
export type CodexAccountSummary = z.infer<typeof codexAccountSchema>;

export const codexAccountPhaseSchema = z.enum(["ready", "changing", "unavailable"]);
export type CodexAccountPhase = z.infer<typeof codexAccountPhaseSchema>;

export const codexAccountPendingOperationSchema = z
  .object({
    operationId: nonBlankTextSchema.max(1_024),
    kind: z.enum(["login", "switch", "logout", "recovery"]),
  })
  .strict();
export type CodexAccountPendingOperation = z.infer<typeof codexAccountPendingOperationSchema>;

export const codexAccountCapabilitiesSchema = z
  .object({
    manage: z.boolean(),
    switch: z.boolean(),
    login: z.boolean(),
    delete: z.boolean(),
    recover: z.boolean().optional(),
    logout: z.boolean().optional(),
    reason: z
      .enum([
        "ssh-single-account",
        "unsupported-storage",
        "unsupported-version",
        "recovery-required",
        "keyring-unavailable",
        "migration-required",
      ])
      .optional(),
  })
  .strict();
export type CodexAccountCapabilities = z.infer<typeof codexAccountCapabilitiesSchema>;

export const codexAccountListResultSchema = z
  .object({
    version: z.literal(2),
    currentAccountId: accountIdSchema.nullable(),
    phase: codexAccountPhaseSchema,
    revision: z.number().int().nonnegative(),
    instanceId: nonBlankTextSchema.max(1_024).optional(),
    cleanupRequired: z.boolean().optional(),
    /** Credentials were adopted; other native homes/history remain unmerged. */
    legacyHistoryPreserved: z.boolean().optional(),
    pendingOperation: codexAccountPendingOperationSchema.optional(),
    capabilities: codexAccountCapabilitiesSchema,
    accounts: z.array(codexAccountSchema).max(128),
  })
  .strict();
export type CodexAccountListResult = z.infer<typeof codexAccountListResultSchema>;

/** Parse only to return an explicit upgrade error; never alias this to switch. */
export const codexAccountActivateParamsSchema = z.object({ accountId: accountIdSchema }).strict();
export type CodexAccountActivateParams = z.infer<typeof codexAccountActivateParamsSchema>;

export const codexAccountSwitchParamsSchema = z.object({ accountId: accountIdSchema }).strict();
export type CodexAccountSwitchParams = z.infer<typeof codexAccountSwitchParamsSchema>;

const codexAccountReadyMutationResultShape = {
  phase: z.literal("ready"),
  revision: z.number().int().nonnegative(),
} as const;

export const codexAccountSwitchResultSchema = z
  .object({
    currentAccountId: accountIdSchema,
    ...codexAccountReadyMutationResultShape,
  })
  .strict();
export type CodexAccountSwitchResult = z.infer<typeof codexAccountSwitchResultSchema>;

export const codexAccountChangedSchema = codexAccountListResultSchema;
export type CodexAccountChanged = z.infer<typeof codexAccountChangedSchema>;

export const codexAccountDeleteParamsSchema = z.object({ accountId: accountIdSchema }).strict();
export type CodexAccountDeleteParams = z.infer<typeof codexAccountDeleteParamsSchema>;

export const codexAccountDeleteResultSchema = z
  .object({ deletedAccountId: accountIdSchema })
  .strict();
export type CodexAccountDeleteResult = z.infer<typeof codexAccountDeleteResultSchema>;

export const codexAccountLoginStartParamsSchema = z
  .object({ accountId: accountIdSchema.optional() })
  .strict();
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
  .object({ loginId: nonBlankTextSchema.max(1_024) })
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
    saved: z.boolean().optional(),
    cleanupRequired: z.boolean().optional(),
  })
  .strict();
export type CodexAccountLoginCompleted = z.infer<typeof codexAccountLoginCompletedSchema>;

export const codexAccountLogoutParamsSchema = z.object({}).strict();
export type CodexAccountLogoutParams = z.infer<typeof codexAccountLogoutParamsSchema>;
export const codexAccountLogoutResultSchema = z
  .object({
    currentAccountId: z.null(),
    ...codexAccountReadyMutationResultShape,
  })
  .strict();
export type CodexAccountLogoutResult = z.infer<typeof codexAccountLogoutResultSchema>;

export const codexAccountRecoverParamsSchema = z.object({}).strict();
export type CodexAccountRecoverParams = z.infer<typeof codexAccountRecoverParamsSchema>;
export const codexAccountRecoverResultSchema = codexAccountListResultSchema;
export type CodexAccountRecoverResult = z.infer<typeof codexAccountRecoverResultSchema>;

export const codexAccountUsageParamsSchema = z
  .object({ accountId: accountIdSchema, refresh: z.boolean().optional() })
  .strict();
export type CodexAccountUsageParams = z.infer<typeof codexAccountUsageParamsSchema>;
export const codexAccountUsageResultSchema = z
  .object({
    accountId: accountIdSchema,
    usage: threadUsageSnapshotSchema.nullable(),
    accountCredits: accountCreditsSnapshotSchema.optional(),
    freshness: z.enum(["live", "cached"]),
    observedAt: z.string().datetime().nullable(),
  })
  .strict();
export type CodexAccountUsageResult = z.infer<typeof codexAccountUsageResultSchema>;

export const codexAccountResetCreditConsumeParamsSchema = z
  .object({
    accountId: accountIdSchema,
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict();
export type CodexAccountResetCreditConsumeParams = z.infer<
  typeof codexAccountResetCreditConsumeParamsSchema
>;

export const codexAccountResetCreditConsumeOutcomeSchema = z.enum([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type CodexAccountResetCreditConsumeOutcome = z.infer<
  typeof codexAccountResetCreditConsumeOutcomeSchema
>;

export const codexAccountResetCreditConsumeResultSchema = z
  .object({
    accountId: accountIdSchema,
    outcome: codexAccountResetCreditConsumeOutcomeSchema,
    accountCredits: accountCreditsSnapshotSchema.optional(),
  })
  .strict();
export type CodexAccountResetCreditConsumeResult = z.infer<
  typeof codexAccountResetCreditConsumeResultSchema
>;
