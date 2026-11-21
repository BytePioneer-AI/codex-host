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

export const REMOTE_IDENTITY_MAX_LENGTH = 1024;
const identity = z.string().min(1).max(REMOTE_IDENTITY_MAX_LENGTH);
const target = { hostId: identity.regex(/^remote-(?:ssh(?:-|:)|control:)/u) };
const thread = { ...target, threadId: identity };
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
      thinkingOptionId: identity.optional(),
      permissionModeId: identity.optional(),
    })
    .refine(
      (value) =>
        [value.modelId, value.thinkingOptionId, value.permissionModeId].filter(
          (v) => v !== undefined,
        ).length === 1,
      "Select exactly one remote setting",
    ),
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
