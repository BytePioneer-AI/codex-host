import { z } from "zod";

import { rejectExplicitUndefined } from "./json-value.js";

export const codexhostErrorSchema = z
  .strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    diagnostic: z.string().min(1).optional(),
  })
  .superRefine(rejectExplicitUndefined(["diagnostic"]));

export type CodexhostError = Omit<z.infer<typeof codexhostErrorSchema>, "diagnostic"> & {
  diagnostic?: string;
};
