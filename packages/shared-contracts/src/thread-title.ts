import { z } from "zod";

/** Conditional thread/name/set for automatic titles on external Threads. */
export const THREAD_NAME_AUTO_SOURCE_PARAM = "codexhostAutoTitle";

export const threadTitleInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(2000),
  cwd: z.string().max(4096).nullable(),
});
export const threadTitleResultSchema = z.string().trim().min(1).max(60).nullable();
export type ThreadTitleInput = z.infer<typeof threadTitleInputSchema>;
