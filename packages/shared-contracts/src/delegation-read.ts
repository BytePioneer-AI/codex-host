import { z } from "zod";

/** Read-only, Host-local operation. Remote routing is performed by the caller. */
export const DELEGATION_READ_METHOD = "codexhost/thread/delegation-read";
export const delegationReadParamsSchema = z.strictObject({
  threadId: z.string().min(1).max(1024),
  view: z.enum(["result", "messages"]),
  cursor: z.string().min(1).max(8192).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type DelegationReadParams = z.infer<typeof delegationReadParamsSchema>;
