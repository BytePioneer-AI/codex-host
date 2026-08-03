import { z } from "zod";

import { hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";

export const externalThreadForkParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    lastTurnId: hostTurnIdSchema,
  })
  .strict();

export type ExternalThreadForkParams = z.infer<typeof externalThreadForkParamsSchema>;

export const externalThreadForkResultSchema = z
  .object({
    threadId: hostThreadIdSchema,
  })
  .strict();

export type ExternalThreadForkResult = z.infer<typeof externalThreadForkResultSchema>;
