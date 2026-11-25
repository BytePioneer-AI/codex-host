import { z } from "zod";
import { billingSourceRefSchema } from "./harness-accounts.js";
import { harnessThinkingOptionIdSchema } from "./harness-models.js";
import { harnessIdSchema } from "./ids.js";

export const RETAINED_PREWARM_RUN_METHOD = "codexhost/harness/retained-prewarm/run";
export const retainedPrewarmParamsSchema = z
  .object({
    billingSourceRef: billingSourceRefSchema,
    scopeId: z.string().min(1).max(256),
  })
  .strict();
export type RetainedPrewarmParams = z.infer<typeof retainedPrewarmParamsSchema>;

export const retainedPrewarmResultSchema = retainedPrewarmParamsSchema
  .extend({
    harnessId: harnessIdSchema,
    model: z.string().min(1).max(256),
    thinkingOptionId: harnessThinkingOptionIdSchema,
    nativeSessionRef: z
      .object({
        harnessId: harnessIdSchema,
        nativeSessionId: z.string().min(1).max(256),
        formatVersion: z.literal(1),
      })
      .strict()
      .nullable(),
    status: z.enum(["succeeded", "failed", "blocked"]),
    modelVerification: z.enum(["matched", "mismatch", "unavailable", "not-run"]),
    /** Best-effort current-login verification, never a per-request billing receipt. */
    accountVerification: z.enum(["verified", "unverified"]),
    // Report a change only when the native login signal can detect one; history may span accounts.
    accountChanged: z.boolean().optional(),
    error: z.string().max(512).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.harnessId === value.billingSourceRef.harnessId &&
      (value.nativeSessionRef === null || value.nativeSessionRef.harnessId === value.harnessId) &&
      (value.status !== "succeeded" ||
        (value.nativeSessionRef !== null &&
          (value.modelVerification === "matched" || value.modelVerification === "unavailable"))),
  );
export type RetainedPrewarmResult = z.infer<typeof retainedPrewarmResultSchema>;
