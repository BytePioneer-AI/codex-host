import { z } from "zod";

export const DELEGATION_SEND_METHOD = "codexhost/thread/delegation-send";
export const THREAD_BRIDGE_SEND_METHOD = "codexhost/thread-bridge/send";
export const delegationSendParamsSchema = z.strictObject({
  threadId: z.string().min(1).max(1024),
  message: z
    .string()
    .max(256 * 1024)
    .refine((text) => text.trim().length > 0),
  requestId: z.uuid(),
  expectedMachineId: z.uuid(),
});
export const threadSendResultSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  harnessId: z.string().min(1),
  status: z.literal("running"),
  next: z.object({ read: z.string(), wait: z.string().optional() }),
});
export const threadBridgeErrorSchema = z.strictObject({
  code: z.enum([
    "RUNTIME_UNREACHABLE",
    "RESPONSE_TOO_LARGE",
    "OUTCOME_UNKNOWN",
    "INVALID_ARGUMENT",
    "THREAD_BUSY",
    "THREAD_NOT_FOUND",
    "DELEGATION_FAILED",
  ]),
  message: z.string().min(1).max(4096),
});
export const threadSendOutcomeSchema = z.union([
  z.strictObject({ result: threadSendResultSchema }),
  z.strictObject({ error: threadBridgeErrorSchema }),
]);
export type DelegationSendParams = z.infer<typeof delegationSendParamsSchema>;
export type ThreadSendOutcome = z.infer<typeof threadSendOutcomeSchema>;
