import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";

const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Value must not be empty or whitespace",
});

export const THREAD_HANDOFF_METHOD = "codexhost/thread/handoff";
export const WEB_HANDOFF_PROJECTION = "codexhostHandoff";

export const threadHandoffParamsSchema = z
  .object({
    sourceThreadId: hostThreadIdSchema,
    lastTurnId: hostTurnIdSchema.optional(),
    targetHarnessId: harnessIdSchema,
    targetModel: nonBlankTextSchema.max(1_024).optional(),
    targetThinkingOptionId: nonBlankTextSchema
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/u, "Thinking option ID must use transport-safe characters")
      .optional(),
  })
  .strict();

export type ThreadHandoffParams = z.infer<typeof threadHandoffParamsSchema>;

export const threadHandoffMetadataSchema = z
  .object({
    sourceThreadId: hostThreadIdSchema,
    sourceHarnessId: harnessIdSchema,
    sourceHarnessLabel: nonBlankTextSchema.max(256).optional(),
    sourceModel: nonBlankTextSchema.max(1_024).optional(),
    targetHarnessId: harnessIdSchema,
    targetHarnessLabel: nonBlankTextSchema.max(256).optional(),
    targetModel: nonBlankTextSchema.max(1_024).optional(),
    totalTurns: z.number().int().min(1),
    boundaryTurnNumber: z.number().int().min(1),
    includedTurnNumbers: z.array(z.number().int().min(1)),
    omittedTurns: z.number().int().min(0),
    preview: z.string().max(32_000),
    createdAtMs: z.number().int().nonnegative(),
  })
  .strict();

export type ThreadHandoffMetadata = z.infer<typeof threadHandoffMetadataSchema>;

export const threadHandoffResultSchema = z
  .object({
    threadId: hostThreadIdSchema,
    handoff: threadHandoffMetadataSchema,
  })
  .strict();

export type ThreadHandoffResult = z.infer<typeof threadHandoffResultSchema>;
