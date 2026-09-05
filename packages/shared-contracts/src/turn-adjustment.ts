import { z } from "zod";

import { hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";

export const TURN_ADJUST_METHOD = "codexhost/turn/adjust";

export const turnAdjustmentParamsSchema = z.object({
  threadId: hostThreadIdSchema,
  expectedTurnId: hostTurnIdSchema,
  clientUserMessageId: z.string().min(1).max(1_024),
  input: z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .min(1)
    .refine((input) => input.some(({ text }) => text.length > 0)),
});

export const turnAdjustmentResultSchema = z.object({
  turnId: hostTurnIdSchema,
  previousTurnId: hostTurnIdSchema,
  delivery: z.enum(["steer", "interrupt-and-continue"]),
});

export type TurnAdjustmentParams = z.infer<typeof turnAdjustmentParamsSchema>;
export type TurnAdjustmentResult = z.infer<typeof turnAdjustmentResultSchema>;
