import { z } from "zod";

/** Serialized Controller replies are bounded independently of message-count pagination. */
export const REMOTE_THREAD_REPLY_MAX_BYTES = 16 * 1024 * 1024;
export const REMOTE_THREAD_READ_TIMEOUT_MS = 35_000;
export const REMOTE_THREAD_CONTROL_TIMEOUT_MS = 40_000;

/** Read-only, Host-local operation. Remote routing is performed by the caller. */
export const DELEGATION_READ_METHOD = "codexhost/thread/delegation-read";
/** Per-submission Desktop connection identity; never a machine-global Host alias. */
export const THREAD_REFERENCE_SOURCE_HOST_PARAM = "codexhostSourceHostId";
export const delegationReadParamsSchema = z.strictObject({
  threadId: z.string().min(1).max(1024),
  view: z.enum(["result", "messages"]),
  cursor: z.string().min(1).max(8192).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type DelegationReadParams = z.infer<typeof delegationReadParamsSchema>;
