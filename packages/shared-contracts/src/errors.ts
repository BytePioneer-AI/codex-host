import { z } from "zod";

import { rejectExplicitUndefined } from "./json-value.js";

export const codexhostErrorSchema = z
  .strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    diagnostic: z.string().min(1).optional(),
    stage: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    stderrTail: z.string().min(1).optional(),
  })
  .superRefine(rejectExplicitUndefined(["diagnostic", "stage", "durationMs", "stderrTail"]));

export type CodexhostError = Omit<
  z.infer<typeof codexhostErrorSchema>,
  "diagnostic" | "stage" | "durationMs" | "stderrTail"
> & {
  diagnostic?: string;
  stage?: string;
  durationMs?: number;
  stderrTail?: string;
};
