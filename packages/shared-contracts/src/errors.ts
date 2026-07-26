import { z } from "zod";

export const codexhostErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  diagnostic: z.string().min(1).optional(),
});

export type CodexhostError = z.infer<typeof codexhostErrorSchema>;
