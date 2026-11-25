import { z } from "zod";
import { hostThreadIdSchema } from "./ids.js";

/** External thread/start only: marks a disposable draft, not a user submission. */
export const EXTERNAL_THREAD_PREWARM_PARAM = "codexhostPrewarm";
export const THREAD_PREWARM_DISCARD_METHOD = "codexhost/thread/prewarm/discard";
export const threadPrewarmDiscardParamsSchema = z.object({ threadId: hostThreadIdSchema });
export const threadPrewarmDiscardResultSchema = z.object({ discarded: z.boolean() });
