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

export const codexAccountPhaseSchema = z.enum(["ready", "unavailable"]);
export type CodexAccountPhase = z.infer<typeof codexAccountPhaseSchema>;

export const codexAccountListResultSchema = z
  .object({
    version: z.literal(2),
    currentAccountId: accountIdSchema.nullable(),
    phase: codexAccountPhaseSchema,
    revision: z.number().int().nonnegative(),
    instanceId: nonBlankTextSchema.max(1_024).optional(),
    accounts: z.array(codexAccountSchema).max(1),
  })
  .strict();
export type CodexAccountListResult = z.infer<typeof codexAccountListResultSchema>;

export const codexAccountChangedSchema = codexAccountListResultSchema;
export type CodexAccountChanged = z.infer<typeof codexAccountChangedSchema>;

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
