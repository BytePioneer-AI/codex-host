import { z } from "zod";
import { harnessIdSchema } from "./ids.js";
import { accountCreditsSnapshotSchema } from "./thread-usage.js";

/** Remaining prepaid funds, distinct from a percentage-based quota or allowance. */
export const accountBalanceSnapshotSchema = z
  .object({
    amount: z.number().finite().nonnegative(),
    /** ISO 4217 code as reported by the Provider, for example `CNY`. */
    currency: z.string().trim().min(1).max(8),
    /** Native label when the Harness exposes several Billing Sources. */
    label: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type AccountBalanceSnapshot = z.infer<typeof accountBalanceSnapshotSchema>;

const harnessAccountSnapshotObject = z
  .object({
    email: z.string().trim().min(1).max(320).optional(),
    label: z.string().trim().min(1).max(256).optional(),
    plan: z.string().trim().min(1).max(128).optional(),
    credits: accountCreditsSnapshotSchema.optional(),
    balance: accountBalanceSnapshotSchema.optional(),
  })
  .strict();

function requireReportedQuota<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  return schema.refine(
    (value) => {
      const reported = value as { credits?: unknown; balance?: unknown };
      return reported.credits !== undefined || reported.balance !== undefined;
    },
    { message: "Account must report either credits or a balance" },
  );
}

/** Read-only telemetry for the Harness's current native authentication, never a login record. */
export const harnessAccountSnapshotSchema = requireReportedQuota(harnessAccountSnapshotObject);
export type HarnessAccountSnapshot = z.infer<typeof harnessAccountSnapshotSchema>;

const harnessAccountIdentityShape = {
  harnessId: harnessIdSchema,
  harnessName: z.string().trim().min(1).max(128),
};

export const harnessAccountSourceSchema = z.object(harnessAccountIdentityShape).strict();
export type HarnessAccountSource = z.infer<typeof harnessAccountSourceSchema>;

export const harnessAccountSourceListParamsSchema = z.object({}).strict();
export const harnessAccountSourceListResultSchema = z
  .object({ sources: z.array(harnessAccountSourceSchema).max(128) })
  .strict();
export type HarnessAccountSourceListResult = z.infer<typeof harnessAccountSourceListResultSchema>;

export const harnessAccountInspectParamsSchema = z
  .object({ harnessId: harnessIdSchema, refresh: z.boolean().optional() })
  .strict();
export type HarnessAccountInspectParams = z.infer<typeof harnessAccountInspectParamsSchema>;

export const harnessAccountInspectResultSchema = z
  .object({
    ...harnessAccountIdentityShape,
    account: harnessAccountSnapshotSchema.nullable(),
    /** Every Billing Source from one Harness; `account` remains the first for older clients. */
    accounts: z.array(harnessAccountSnapshotSchema).max(8).optional(),
  })
  .strict();
export type HarnessAccountInspectResult = z.infer<typeof harnessAccountInspectResultSchema>;

export const harnessAccountListParamsSchema = z
  .object({ refresh: z.boolean().optional() })
  .strict();
export type HarnessAccountListParams = z.infer<typeof harnessAccountListParamsSchema>;
export const harnessAccountListResultSchema = z
  .object({
    accounts: z
      .array(requireReportedQuota(harnessAccountSnapshotObject.extend(harnessAccountIdentityShape)))
      .max(128),
  })
  .strict();
export type HarnessAccountListResult = z.infer<typeof harnessAccountListResultSchema>;
