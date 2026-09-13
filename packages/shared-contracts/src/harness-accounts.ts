import { z } from "zod";
import { harnessIdSchema } from "./ids.js";
import { accountCreditsSnapshotSchema } from "./thread-usage.js";

/** Read-only telemetry for the Harness's current native authentication, never a login record. */
export const harnessAccountSnapshotSchema = z
  .object({
    email: z.string().trim().min(1).max(320).optional(),
    label: z.string().trim().min(1).max(256).optional(),
    plan: z.string().trim().min(1).max(128).optional(),
    credits: accountCreditsSnapshotSchema,
  })
  .strict();
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

export const harnessAccountInspectParamsSchema = z.object({ harnessId: harnessIdSchema }).strict();
export type HarnessAccountInspectParams = z.infer<typeof harnessAccountInspectParamsSchema>;

export const harnessAccountInspectResultSchema = z
  .object({
    ...harnessAccountIdentityShape,
    account: harnessAccountSnapshotSchema.nullable(),
  })
  .strict();
export type HarnessAccountInspectResult = z.infer<typeof harnessAccountInspectResultSchema>;

export const harnessAccountListParamsSchema = z.object({}).strict();
export const harnessAccountListResultSchema = z
  .object({
    accounts: z.array(harnessAccountSnapshotSchema.extend(harnessAccountIdentityShape)).max(128),
  })
  .strict();
export type HarnessAccountListResult = z.infer<typeof harnessAccountListResultSchema>;
