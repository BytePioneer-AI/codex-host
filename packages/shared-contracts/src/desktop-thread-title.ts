import { z } from "zod";

export const desktopThreadTitleInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(2000),
  cwd: z.string().max(4096).nullable(),
});
export const desktopThreadTitleResultSchema = z.string().trim().min(1).max(60).nullable();
export type DesktopThreadTitleInput = z.infer<typeof desktopThreadTitleInputSchema>;
