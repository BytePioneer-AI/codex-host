import { z } from "zod";

export const REMOTE_CONTROLLER_REQUEST_MAX_BYTES = 16 * 1024;
/** REMOTE + nonce + separators/newline, including JSON escaping and UTF-8 encoding. */
export function remoteSessionRequestBytes(operation: RemoteSessionOperation): number {
  let bytes = 41;
  for (const character of JSON.stringify({ action: "session", operation })) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

const identity = z.string().min(1).max(1024);
const target = { hostId: identity.regex(/^remote-(?:ssh(?:-|:)|control:)/u) };
const thread = { ...target, threadId: identity };
/** Operations on existing Desktop connections; no connection or credential management. */
export const remoteSessionOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hosts") }),
  z.strictObject({
    kind: z.literal("list"),
    ...target,
    cursor: z.string().nullable(),
    archived: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("read"), ...thread }),
  z.strictObject({
    kind: z.literal("prompt"),
    ...thread,
    epoch: identity,
    text: z.string().min(1).max(8000),
    requestId: identity.optional(),
  }),
  z.strictObject({ kind: z.literal("interrupt"), ...thread, epoch: identity, turnId: identity }),
  z.strictObject({
    kind: z.literal("rename"),
    ...thread,
    epoch: identity,
    name: z.string().min(1).max(512),
  }),
  z.strictObject({ kind: z.literal("archive"), ...thread, epoch: identity, archived: z.boolean() }),
  z.strictObject({
    kind: z.literal("respond"),
    ...thread,
    epoch: identity,
    requestId: z.union([identity, z.number().int()]),
    result: z.record(z.string(), z.unknown()),
  }),
]);
export type RemoteSessionOperation = z.infer<typeof remoteSessionOperationSchema>;
