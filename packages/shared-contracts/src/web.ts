import { z } from "zod";

/** Chat-only whole-value projections owned by the addressed session/follow stream. */
export const WEB_FOLLOW_PROJECTION_KEYS: ReadonlySet<string> = new Set([
  "codexhostTurnChanges",
  "codexhostToolOutput",
]);

/** One cumulative changed file; full before/after text is fetched only on expansion. */
export interface WebTurnFileSummary {
  path: string;
  added: number;
  removed: number;
  revision: string;
}

export const webFileDiffSchema = z.object({
  path: z.string(),
  oldText: z.string().nullable(),
  newText: z.string(),
});
export type WebFileDiff = z.infer<typeof webFileDiffSchema>;
export const webTurnDiffsRequestSchema = z.object({
  sessionId: z.string().min(1),
  turn: z.number().int().nonnegative(),
  path: z.string().min(1).optional(),
});
export const webTurnDiffsResultSchema = z.object({ diffs: z.array(webFileDiffSchema) });

/** Ensures Web is running and opens it through the local Launcher. */
export const WEB_OPEN_METHOD = "codexhost/web/open";
export const webOpenParamsSchema = z.strictObject({});
export const webOpenResultSchema = z.strictObject({});
export type WebOpenResult = z.infer<typeof webOpenResultSchema>;
