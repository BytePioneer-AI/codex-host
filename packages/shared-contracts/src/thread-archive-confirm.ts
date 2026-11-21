import { z } from "zod";
import { hostThreadIdSchema } from "./ids.js";

export const THREAD_ARCHIVE_CONFIRM_METHOD = "codexhost/thread/archive/confirm";
export const threadArchiveConfirmParamsSchema = z.object({ threadId: hostThreadIdSchema }).strict();
/** False means unknown/unconfirmed, not affirmative evidence that the Thread is unarchived. */
export const threadArchiveConfirmResultSchema = z.object({ confirmed: z.boolean() }).strict();
