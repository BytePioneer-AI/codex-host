import { z } from "zod";

import { hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";

/**
 * Host notification sent immediately before the `item/started` of a context
 * compaction inside an explicit Harness `/compact` command Turn. Codex Desktop marks a
 * compaction as manual only through its own client-side registration, so the
 * Renderer uses this signal to register the compaction the same way.
 */
export const THREAD_MANUAL_COMPACTION_STARTED_METHOD = "codexhost/thread/manual-compaction/started";
export const threadManualCompactionStartedSchema = z.strictObject({
  threadId: hostThreadIdSchema,
  turnId: hostTurnIdSchema,
});
export type ThreadManualCompactionStarted = z.infer<typeof threadManualCompactionStartedSchema>;
