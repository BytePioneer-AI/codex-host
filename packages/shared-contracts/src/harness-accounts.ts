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

export const harnessAccountListParamsSchema = z.object({}).strict();
export const harnessAccountListResultSchema = z
  .object({
    accounts: z
      .array(
        harnessAccountSnapshotSchema.extend({
          harnessId: harnessIdSchema,
          harnessName: z.string().min(1),
        }),
      )
      .max(128),
  })
  .strict();
export type HarnessAccountListResult = z.infer<typeof harnessAccountListResultSchema>;
