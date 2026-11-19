import { z } from "zod";

/** A tool text fragment in one immutable Web rendering generation. Not an access credential. */
export const webToolOutputReferenceSchema = z.object({
  sessionId: z.string().min(1),
  epoch: z.string().min(1),
  turn: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  callId: z.string().min(1),
  part: z.number().int().nonnegative(),
  version: z.string().min(1),
});
export type WebToolOutputReference = z.infer<typeof webToolOutputReferenceSchema>;
export const webToolOutputPreviewSchema = z.object({
  reference: webToolOutputReferenceSchema,
  length: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type WebToolOutputPreview = z.infer<typeof webToolOutputPreviewSchema>;

/** Presentation metadata lives outside model content and keeps existing tool metadata intact. */
export function webToolOutputPreviews(meta: unknown): WebToolOutputPreview[] {
  if (typeof meta !== "object" || meta === null || !("codexhostOutput" in meta)) return [];
  const result = z.array(webToolOutputPreviewSchema).safeParse(meta.codexhostOutput);
  return result.success ? result.data : [];
}
