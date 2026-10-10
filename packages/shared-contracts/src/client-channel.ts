import { z } from "zod";
import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "./harness-models.js";
import { harnessPermissionModeIdSchema } from "./harness-permission-modes.js";

/** Authenticated local owner channel. Notifications invalidate state; they are
 * NOT appendable transcript deltas. Clients reconcile absolute snapshots. */
export const CLIENT_CHANNEL_VERSION = 1;
export const CLIENT_CHANNEL_METHODS = [
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/start",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "turn/start",
  "turn/interrupt",
  "turn/steer",
  "codexhost/workspace/read",
  "codexhost/harness/plugins/list",
  "codexhost/harness/inspect",
  "codexhost/thread/inspect",
  "codexhost/thread/ownership/list",
  "codexhost/thread/model/select",
  "codexhost/thread/thinking/select",
  "codexhost/thread/permission-mode/select",
  "codexhost/thread/commands/inspect",
  "codexhost/thread/command/execute",
  "codexhost/thread/fork",
  "codexhost/harness/session-import/sources",
  "codexhost/harness/session-import/list",
  "codexhost/harness/session-import/import",
] as const;
export const clientWorkspaceSnapshotSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), rootPaths: z.array(z.string()) })),
  assignments: z.record(z.string(), z.string()),
  projectless: z.array(z.string()),
  pinned: z.array(z.string()),
});
export type ClientWorkspaceSnapshot = z.infer<typeof clientWorkspaceSnapshotSchema>;
const record = z.record(z.string(), z.unknown());
export const clientChannelCursorSchema = z.object({
  epoch: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
});
export type ClientChannelCursor = z.infer<typeof clientChannelCursorSchema>;
export const clientChannelEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    version: z.literal(1),
    cursor: clientChannelCursorSchema,
    reset: z.boolean(),
  }),
  z.object({
    type: z.literal("changed"),
    cursor: clientChannelCursorSchema,
    threadId: z.string().min(1),
    method: z.string().min(1),
  }),
]);
export type ClientChannelEvent = z.infer<typeof clientChannelEventSchema>;
const clientQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    id: z.string(),
    prompt: z.string(),
    secret: z.boolean().optional(),
    optional: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("choice"),
    id: z.string(),
    prompt: z.string(),
    multiple: z.boolean(),
    allowOther: z.boolean(),
    optional: z.boolean().optional(),
    options: z.array(
      z.object({ value: z.string(), label: z.string(), description: z.string().optional() }),
    ),
  }),
]);
const clientInteractionValueSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval"),
    title: z.string(),
    description: z.string().optional(),
    subject: z.unknown().optional(),
    actions: z.array(z.object({ id: z.string(), label: z.string(), effect: z.string() })),
  }),
  z.object({
    type: z.literal("question"),
    title: z.string().optional(),
    questions: z.array(clientQuestionSchema),
  }),
]);
export const clientInteractionSchema = z.object({
  requestId: z.union([z.string(), z.number().int()]),
  threadId: z.string(),
  kind: z.enum(["approval", "question"]),
  interaction: clientInteractionValueSchema,
  request: record,
});
export type ClientInteraction = z.infer<typeof clientInteractionSchema>;
const clientTurnSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    items: z.array(z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough()),
    error: z.object({ message: z.string().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();
export const clientThreadSnapshotSchema = z.object({
  cursor: clientChannelCursorSchema,
  thread: z
    .object({
      id: z.string().min(1),
      cwd: z.string(),
      modelProvider: z.literal("codexhost"),
      createdAt: z.number(),
      updatedAt: z.number(),
      status: z.object({ type: z.string() }).passthrough(),
      name: z.string().nullable().optional(),
      preview: z.string().optional(),
      turns: z.array(clientTurnSchema).length(0),
    })
    .passthrough(),
  turnsPage: z.object({
    data: z.array(clientTurnSchema).max(5),
    nextCursor: z.string().nullable(),
  }),
  configuration: z.object({
    effectiveModel: harnessModelRefSchema.optional(),
    effectiveThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    effectivePermissionModeId: harnessPermissionModeIdSchema.optional(),
  }),
  interactions: z.array(clientInteractionSchema),
});
export type ClientThreadSnapshot = z.infer<typeof clientThreadSnapshotSchema>;
export const clientChannelDescriptorSchema = z.object({
  version: z.literal(CLIENT_CHANNEL_VERSION),
  owner: z.literal("service").optional(),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  startedAt: z.number(),
  epoch: z.string().uuid(),
});
export type ClientChannelDescriptor = z.infer<typeof clientChannelDescriptorSchema>;
export const clientChannelResponseSchema = z.object({
  epoch: z.string().uuid(),
  threadId: z.string().min(1),
  requestId: z.union([z.string(), z.number().int()]),
  result: record,
});
export type ClientChannelResponse = z.infer<typeof clientChannelResponseSchema>;
