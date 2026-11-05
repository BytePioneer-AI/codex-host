import { z } from "zod";

/** Ensures Web is running and opens it through the local Launcher. */
export const WEB_OPEN_METHOD = "codexhost/web/open";
export const webOpenParamsSchema = z.strictObject({});
export const webOpenResultSchema = z.strictObject({});
export type WebOpenResult = z.infer<typeof webOpenResultSchema>;
