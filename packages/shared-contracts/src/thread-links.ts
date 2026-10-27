import { z } from "zod";
import { delegationReadParamsSchema } from "./delegation-read.js";
import { jsonValueSchema } from "./json-value.js";
import { delegationSendParamsSchema, threadBridgeErrorSchema } from "./thread-send.js";

export const HOST_IDENTITY_METHOD = "codexhost/host/identity";
export const THREAD_BRIDGE_ATTACH_METHOD = "codexhost/thread-bridge/attach";
export const THREAD_BRIDGE_READ_METHOD = "codexhost/thread-bridge/read";
export const THREAD_BRIDGE_REPLY_METHOD = "codexhost/thread-bridge/reply";
export const machineIdSchema = z.uuid();
export const hostIdentitySchema = z.strictObject({
  machineId: machineIdSchema,
  sendSupported: z.boolean().optional(),
});
export const threadBridgeAttachSchema = z.strictObject({
  clientId: z.uuid(),
  machineIds: z.array(machineIdSchema).max(128),
  sendMachineIds: z.array(machineIdSchema).max(128).optional(),
});
export const threadBridgeReadSchema = z.strictObject({
  clientId: z.uuid(),
  requestId: z.uuid(),
  machineId: machineIdSchema,
  input: delegationReadParamsSchema,
});
export const threadBridgeSendSchema = z.strictObject({
  clientId: z.uuid(),
  requestId: z.uuid(),
  machineId: machineIdSchema,
  operation: z.literal("send"),
  input: delegationSendParamsSchema,
});
export type ThreadBridgeSend = z.infer<typeof threadBridgeSendSchema>;
export const threadBridgeReplySchema = z.strictObject({
  clientId: z.uuid(),
  requestId: z.uuid(),
  reply: z.union([
    z.strictObject({ result: jsonValueSchema }),
    z.strictObject({
      error: threadBridgeErrorSchema,
    }),
  ]),
});
export type ThreadBridgeRead = z.infer<typeof threadBridgeReadSchema>;
export type ThreadBridgeReply = z.infer<typeof threadBridgeReplySchema>;

export interface ThreadReference {
  threadId: string;
  hostId?: string;
  machineId?: string;
}

/** Host IDs describe Desktop connections; machine IDs survive connection aliases and IP changes. */
export function formatThreadReference(reference: ThreadReference): string {
  const query: string[] = [];
  if (reference.hostId) query.push(`hostId=${encodeURIComponent(reference.hostId)}`);
  if (reference.machineId) query.push(`machineId=${machineIdSchema.parse(reference.machineId)}`);
  return `thread://${encodeURIComponent(reference.threadId)}${query.length ? `?${query.join("&")}` : ""}`;
}

export function parseThreadReference(value: string): ThreadReference {
  if (/%(?![\da-f]{2})/iu.test(value)) throw new Error("Thread reference encoding is invalid");
  const match = /^(?:thread:\/\/|codex:\/\/threads\/)([^/?#]+)(?:\?([^#]*))?$/u.exec(value);
  if (!match?.[1]) throw new Error("Thread reference is invalid");
  const threadId = decodeURIComponent(match[1]);
  if (!threadId || /[\s/?#]/u.test(threadId)) throw new Error("Thread identifier is invalid");
  const params = new Map<string, string>();
  for (const field of match[2]?.split("&") ?? []) {
    const [rawKey, rawValue, extra] = field.split("=");
    const key = decodeURIComponent(rawKey ?? "");
    if (
      !["hostId", "machineId"].includes(key) ||
      params.has(key) ||
      rawValue === undefined ||
      extra !== undefined
    )
      throw new Error("Thread reference has unsupported or duplicate parameters");
    params.set(key, decodeURIComponent(rawValue.replaceAll("+", " ")));
  }
  const hostId = params.get("hostId");
  if (hostId !== undefined && (!hostId || hostId.length > 1024 || /[\s\u007f]/u.test(hostId)))
    throw new Error("Thread Host identifier is invalid");
  const machineId = params.get("machineId");
  return {
    threadId,
    ...(hostId ? { hostId } : {}),
    ...(machineId !== undefined ? { machineId: machineIdSchema.parse(machineId) } : {}),
  };
}
