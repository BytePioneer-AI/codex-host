import { z } from "zod";
import { harnessModelServiceTierSchema } from "./harness-models.js";

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

export const REMOTE_IDENTITY_MAX_LENGTH = 1024;
const identity = z.string().min(1).max(REMOTE_IDENTITY_MAX_LENGTH);
const target = {
  hostId: identity.regex(/^(?:remote-(?:ssh(?:-|:)|control:)|remote-peer:[a-zA-Z0-9_-]{1,64}$)/u),
};
const thread = { ...target, threadId: identity };
const text = z.string().min(1).max(8000);
const input = { text, requestId: identity };

export const remoteDeliveryReplySchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), startQueuedItemId: identity.optional() }),
  z.object({
    accepted: z.literal(false),
    code: z.enum([
      "remote/queue-unavailable",
      "remote/steer-unavailable",
      "remote/turn-changed",
      "remote/send-rejected",
      "session/queue-item-not-found",
      "session/queue-item-starting",
    ]),
    message: z.string(),
  }),
]);
export type RemoteDeliveryReply = z.infer<typeof remoteDeliveryReplySchema>;

export const remoteQueueSnapshotSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    items: z
      .array(
        z.object({ id: identity, clientUserMessageId: identity, preview: z.string().max(801) }),
      )
      .max(100),
  }),
]);
export type RemoteQueueSnapshot = z.infer<typeof remoteQueueSnapshotSchema>;

/** Operations on existing Desktop connections; no connection or credential management. */
export const remoteSessionOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hosts") }),
  z.strictObject({
    kind: z.literal("create"),
    ...target,
    cwd: z.string().min(1).max(8192),
    epoch: identity,
  }),
  z.strictObject({ kind: z.literal("projectHarnesses"), ...target, epoch: identity }),
  z.strictObject({
    kind: z.literal("inspectHarness"),
    ...target,
    epoch: identity,
    cwd: z.string().min(1).max(8192),
    harnessId: identity,
  }),
  z.strictObject({
    kind: z.literal("startSelected"),
    ...target,
    epoch: identity,
    cwd: z.string().min(1).max(8192),
    harnessId: identity,
    model: z.string().min(1).max(4096),
    serviceTier: z.enum(["priority", "ultrafast"]).optional(),
    reasoningEffort: identity.optional(),
  }),
  z.strictObject({ kind: z.literal("status"), ...thread }),
  z.strictObject({
    kind: z.literal("list"),
    ...target,
    cursor: z.string().nullable(),
    archived: z.boolean(),
    includeLoaded: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal("read"),
    ...thread,
    page: z
      .strictObject({
        cursor: z.string().min(1).max(8192).nullable(),
        epoch: identity.optional(),
        sortDirection: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .refine((page) => page.cursor === null || page.epoch !== undefined, {
        message: "A history continuation requires its connection epoch",
      })
      .optional(),
  }),
  z.strictObject({ kind: z.literal("usage"), ...thread, epoch: identity }),
  z
    .strictObject({
      kind: z.literal("configure"),
      ...thread,
      epoch: identity,
      modelId: identity.optional(),
      serviceTier: harnessModelServiceTierSchema.optional(),
      thinkingOptionId: identity.optional(),
      permissionModeId: identity.optional(),
    })
    .refine(
      (value) =>
        [value.modelId, value.thinkingOptionId, value.permissionModeId].filter(
          (v) => v !== undefined,
        ).length === 1,
      "Select exactly one remote setting",
    )
    .refine((value) => value.serviceTier === undefined || value.modelId !== undefined, {
      message: "A service tier requires a Model ID",
    }),
  z.strictObject({
    kind: z.literal("prompt"),
    ...thread,
    epoch: identity,
    text,
    requestId: identity.optional(),
  }),
  z.strictObject({ kind: z.literal("queue"), ...thread, epoch: identity }),
  z.strictObject({
    kind: z.literal("delivery"),
    ...thread,
    epoch: identity,
    action: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("enqueue"), ...input }),
      z.strictObject({ kind: z.literal("steer"), ...input, turnId: identity }),
      z.strictObject({ kind: z.literal("remove"), itemId: identity }),
      z.strictObject({
        kind: z.literal("start"),
        itemId: identity,
        onlyIfHead: z.literal(true).optional(),
      }),
    ]),
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
