import { z } from "zod";
import { threadBridgeErrorSchema } from "./thread-send.js";

export const THREAD_MANAGE_METHOD = "codexhost/thread/manage";
export const THREAD_BRIDGE_MANAGE_METHOD = "codexhost/thread-bridge/manage";
const threadId = z.string().min(1).max(1024);
export const threadManagementOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("create"),
    cwd: z.string().min(1).max(16384),
    harnessId: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/u)
      .max(128)
      .default("codex"),
  }),
  z.strictObject({
    operation: z.literal("rename"),
    threadId,
    name: z.string().trim().min(1).max(1024),
  }),
  z.strictObject({ operation: z.literal("archive"), threadId }),
  z.strictObject({ operation: z.literal("unarchive"), threadId }),
  z.strictObject({ operation: z.literal("delete"), threadId }),
]);
export const threadManagementInputSchema = z.strictObject({
  machineId: z.uuid().optional(),
  hostId: z.string().min(1).max(1024).optional(),
  requestId: z.uuid(),
  action: threadManagementOperationSchema,
});
export const threadManagementParamsSchema = z.strictObject({
  expectedMachineId: z.uuid(),
  requestId: z.uuid(),
  action: threadManagementOperationSchema,
});
export const threadManagementResultSchema = z.strictObject({
  operation: z.enum(["create", "rename", "archive", "unarchive", "delete"]),
  threadId,
});
export const threadManagementOutcomeSchema = z.union([
  z.strictObject({ result: threadManagementResultSchema }),
  z.strictObject({ error: threadBridgeErrorSchema }),
]);
export const threadBridgeManageSchema = z.strictObject({
  clientId: z.uuid(),
  requestId: z.uuid(),
  machineId: z.uuid(),
  operation: z.literal("manage"),
  input: threadManagementParamsSchema,
});
export type ThreadManagementOperation = z.infer<typeof threadManagementOperationSchema>;
export type ThreadManagementInput = z.infer<typeof threadManagementInputSchema>;
export type ThreadManagementParams = z.infer<typeof threadManagementParamsSchema>;
export type ThreadManagementResult = z.infer<typeof threadManagementResultSchema>;
export type ThreadManagementOutcome = z.infer<typeof threadManagementOutcomeSchema>;
export type ThreadBridgeManage = z.infer<typeof threadBridgeManageSchema>;
export type ThreadManagementReply = ThreadManagementResult & {
  machineId: string;
  requestId: string;
  thread: string;
};
