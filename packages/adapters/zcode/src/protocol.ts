import { z } from "zod";

export const recordSchema = z.record(z.string(), z.unknown());
export const nativeModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  variant: z.string().optional(),
  options: z.object({ reasoningLevel: z.string().min(1).optional() }).optional(),
});
const levelSchema = z.object({ value: z.string(), label: z.string() });
export const modelSchema = z.object({
  ref: nativeModelSchema,
  label: z.string(),
  disabledReason: z.string().optional(),
  reasoning: z
    .object({
      enabled: z.boolean().optional(),
      levels: z.array(levelSchema),
      defaultLevel: z.string().optional(),
    })
    .transform((reasoning) => ({
      ...reasoning,
      enabled: reasoning.enabled ?? reasoning.levels.length > 0,
    }))
    .optional(),
});
export const settingsSchema = z.object({
  model: z.object({
    current: nativeModelSchema.optional(),
    available: z.array(modelSchema),
    lastUsed: nativeModelSchema.optional(),
  }),
  thoughtLevel: z.object({
    enabled: z.boolean(),
    current: z.string().optional(),
    defaultLevel: z.string().optional(),
    available: z.array(levelSchema),
  }),
  mode: z.object({ current: z.enum(["build", "edit", "plan", "yolo", "auto"]) }),
});
export const workspaceSchema = z.object({
  workspacePath: z.string().min(1),
  workspaceKey: z.string().min(1),
  workspaceIdentity: z.string().optional(),
});
export const summarySchema = z.object({
  sessionId: z.string().min(1),
  workspace: workspaceSchema,
  title: z.string(),
  status: z.string(),
  mode: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  parentSessionId: z.string().optional(),
  sessionKind: z.string(),
});
export const partSchema = z
  .object({
    partId: z.string().min(1),
    messageId: z.string(),
    sessionId: z.string(),
    type: z.string(),
  })
  .catchall(z.unknown());
export const messageSchema = z.object({
  info: z.object({
    messageId: z.string().min(1),
    sessionId: z.string(),
    role: z.enum(["user", "assistant"]),
    parentMessageId: z.string().optional(),
    time: z.object({ created: z.number(), completed: z.number().optional() }),
    model: nativeModelSchema.optional(),
    finish: z.string().optional(),
    error: recordSchema.optional(),
    synthetic: z.boolean().optional(),
    visibility: z.string().optional(),
    semantics: recordSchema.optional(),
  }),
  parts: z.array(partSchema),
});
export const snapshotSchema = z.object({
  protocol: z.object({ name: z.literal("ZCode Protocol"), version: z.literal(1) }),
  session: summarySchema,
  settings: settingsSchema,
  projection: z.object({
    status: z.string(),
    contextUsed: z.number(),
    contextWindow: z.number(),
    currentTurnId: z.string().optional(),
    backgroundJobs: z.array(z.unknown()).optional(),
    target: recordSchema.nullable().optional(),
  }),
  messages: z.array(messageSchema),
  runtime: recordSchema,
  target: recordSchema.nullable().optional(),
  slashCommands: z
    .array(z.object({ name: z.string(), description: z.string(), source: z.string().optional() }))
    .optional(),
});
export const workspaceStateSchema = z.object({
  workspace: workspaceSchema,
  settings: settingsSchema,
});
export const eventSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  turnId: z.string().optional(),
  seq: z.number(),
  timestamp: z.number(),
  type: z.string(),
  payload: recordSchema.optional(),
});
export type NativeSettings = z.infer<typeof settingsSchema>;
export type NativeSnapshot = z.infer<typeof snapshotSchema>;
export type NativePart = z.infer<typeof partSchema>;
export type NativeMessage = z.infer<typeof messageSchema>;
export type NativeEvent = z.infer<typeof eventSchema>;
export type NativeModel = z.infer<typeof nativeModelSchema>;
export function record(value: unknown): Record<string, unknown> {
  return recordSchema.safeParse(value).data ?? {};
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
