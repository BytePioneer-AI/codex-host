import { z } from "zod";

import {
  harnessConfigurationStateSchema,
  harnessSessionImportCandidateSchema,
  harnessSessionImportIdSchema,
  harnessModelRefSchema,
  harnessModelCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  jsonObjectSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import type { HarnessError, HarnessOutput, HarnessSessionState } from "@codexhost/harness-adapter";
import { HARNESS_BROKER_SESSION_IMPORT_PAGE_SIZE } from "./protocol.js";

const cwdSchema = z.string().min(1).max(16_384);
// A remote caller may propagate only the Host's scoped delegation context,
// never change the Aqua process's HOME, PATH, loader or native credentials.
export const brokerEnvironmentSchema = z
  .object({
    CODEXHOST_CLI_PATH: z.string().max(16_384).optional(),
    CODEXHOST_CLI_NODE_PATH: z.string().max(16_384).optional(),
    CODEXHOST_RUNTIME_ENDPOINT: z.string().max(16_384).optional(),
    CODEXHOST_RUNTIME_TOKEN: z.string().max(16_384).optional(),
    CODEXHOST_THREAD_ID: z.string().max(256).optional(),
  })
  .strict();

const createSchema = z
  .object({
    kind: z.literal("create"),
    cwd: cwdSchema,
    executionPolicy: z.enum(["default", "unattended-full-access"]).optional(),
    environment: brokerEnvironmentSchema.optional(),
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
  })
  .strict();
const resumeSchema = z
  .object({
    kind: z.literal("resume"),
    environment: brokerEnvironmentSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    nativeRef: nativeSessionRefSchema,
    cwd: cwdSchema,
    knownTurnRefs: z.array(nativeTurnRefSchema).max(100_000).optional(),
  })
  .strict();
const forkSchema = z
  .object({
    kind: z.literal("fork"),
    environment: brokerEnvironmentSchema.optional(),
    sourceRef: nativeSessionRefSchema,
    checkpoint: nativeCheckpointRefSchema,
    cwd: cwdSchema,
  })
  .strict();
const rollbackSchema = z
  .object({
    kind: z.literal("rollbackLastTurn"),
    environment: brokerEnvironmentSchema.optional(),
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
    sourceRef: nativeSessionRefSchema,
    cwd: cwdSchema,
  })
  .strict();

export const brokerOpenInputSchema = z.discriminatedUnion("kind", [
  createSchema,
  resumeSchema,
  forkSchema,
  rollbackSchema,
]);

export const brokerInspectInputSchema = z
  .object({
    cwd: cwdSchema.optional(),
    refresh: z.boolean().optional(),
    purpose: z.literal("availability").optional(),
  })
  .strict();

export const brokerNormalizeStoredModelRefSchema = z.strictObject({
  ref: harnessModelRefSchema,
  catalog: harnessModelCatalogSchema,
});

export const brokerSessionImportListParamsSchema = z
  .object({
    offset: z.number().int().nonnegative().safe(),
    limit: z.number().int().min(1).max(HARNESS_BROKER_SESSION_IMPORT_PAGE_SIZE),
  })
  .strict();

export const brokerSessionImportResolveParamsSchema = z
  .object({ nativeSessionId: harnessSessionImportIdSchema })
  .strict();

export const brokerSessionImportPageSchema = z
  .object({
    candidates: z
      .array(harnessSessionImportCandidateSchema)
      .max(HARNESS_BROKER_SESSION_IMPORT_PAGE_SIZE),
    total: z.number().int().nonnegative().safe(),
  })
  .strict();

export const brokerSessionImportSourceSchema = z
  .object({
    candidate: harnessSessionImportCandidateSchema,
    nativeRef: nativeSessionRefSchema,
  })
  .strict()
  .superRefine((source, context) => {
    if (source.nativeRef.nativeSessionId !== source.candidate.nativeSessionId) {
      context.addIssue({
        code: "custom",
        message: "Session import source identity does not match",
      });
    }
  });

const textInputSchema = z
  .object({ type: z.literal("text"), text: z.string().max(4_000_000) })
  .strict();
const turnStartSchema = z
  .object({
    type: z.literal("turn.start"),
    turnId: hostTurnIdSchema,
    input: z.array(textInputSchema),
  })
  .strict();
const turnSteerSchema = z
  .object({
    type: z.literal("turn.steer"),
    turnId: hostTurnIdSchema,
    input: z.array(textInputSchema),
  })
  .strict();
const turnCancelSchema = z
  .object({ type: z.literal("turn.cancel"), turnId: hostTurnIdSchema })
  .strict();
const interactionResponseSchema = z.union([
  z
    .object({
      type: z.literal("question"),
      answers: z.record(z.string(), z.array(z.string())),
      cancelled: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("approval"), actionId: z.string().min(1).max(1_024) }).strict(),
]);
const interactionRespondSchema = z
  .object({
    type: z.literal("interaction.respond"),
    interactionId: hostInteractionIdSchema,
    response: interactionResponseSchema,
  })
  .strict();
const modelSelectSchema = z
  .object({ type: z.literal("model.select"), model: harnessModelRefSchema })
  .strict();
const thinkingSelectSchema = z
  .object({
    type: z.literal("thinking.select"),
    thinkingOptionId: harnessThinkingOptionIdSchema,
  })
  .strict();
const permissionSelectSchema = z
  .object({
    type: z.literal("permissionMode.select"),
    permissionModeId: harnessPermissionModeIdSchema,
  })
  .strict();

export const brokerHostCommandSchema = z.discriminatedUnion("type", [
  turnStartSchema,
  turnSteerSchema,
  turnCancelSchema,
  interactionRespondSchema,
  modelSelectSchema,
  thinkingSelectSchema,
  permissionSelectSchema,
]);

export const brokerCommandInvocationSchema = z
  .object({
    turnId: hostTurnIdSchema,
    commandId: z.string().min(1).max(1_024),
    arguments: jsonObjectSchema.optional(),
  })
  .strict();

export const sessionParamsSchema = z
  .object({ sessionId: z.string().uuid(), sessionGeneration: z.number().int().positive() })
  .strict();

export const sessionExecuteParamsSchema = sessionParamsSchema.extend({
  command: brokerHostCommandSchema,
});

export const sessionCommandExecuteParamsSchema = sessionParamsSchema.extend({
  command: brokerCommandInvocationSchema,
});

export const subagentReadSnapshotSchema = z
  .object({
    parent: nativeSessionRefSchema,
    nativeSubagentId: z.string().min(1).max(4_096),
    cwd: cwdSchema,
  })
  .strict();

export const harnessErrorSchema = z
  .object({
    code: z.enum([
      "notInstalled",
      "unavailable",
      "authenticationRequired",
      "sessionNotFound",
      "sessionBusy",
      "checkpointNotFound",
      "unsupported",
      "invalidRequest",
      "invalidState",
      "protocolError",
      "processExited",
      "nativeFailure",
      "internalError",
    ]),
    message: z.string().max(65_536),
    retryable: z.boolean(),
    diagnostic: z.string().max(65_536).optional(),
    stage: z.string().max(1_024).optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    stderrTail: z.string().max(65_536).optional(),
  })
  .strict();

export const harnessSessionStateSchema = z.custom<HarnessSessionState>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "nativeRef",
    "effectiveModel",
    "resolvedModelLabel",
    "effectiveThinkingOptionId",
    "availableThinkingOptions",
    "effectivePermissionModeId",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  if (
    record.nativeRef !== undefined &&
    !nativeSessionRefSchema.safeParse(record.nativeRef).success
  ) {
    return false;
  }
  const { nativeRef: _nativeRef, ...configuration } = record;
  void _nativeRef;
  return harnessConfigurationStateSchema.safeParse(configuration).success;
});

const eventKeys = new Map<string, ReadonlySet<string>>([
  ["session.state.changed", new Set(["type", "state"])],
  ["session.usage.changed", new Set(["type", "usage", "observedForTurnId"])],
  ["usage.request", new Set(["type", "request"])],
  ["usage.request.timing", new Set(["type", "turnId", "timing"])],
  ["usage.history", new Set(["type", "complete"])],
  ["subagent.state.changed", new Set(["type", "nativeSubagentId", "status", "resultSummary"])],
  ["subagent.transcript.changed", new Set(["type", "nativeSubagentId"])],
  ["turn.started", new Set(["type", "turnId"])],
  ["turn.autonomous.started", new Set(["type", "turnId", "input"])],
  ["turn.autonomous.completed", new Set(["type", "snapshot"])],
  ["item.started", new Set(["type", "turnId", "item"])],
  ["item.updated", new Set(["type", "turnId", "itemId", "update"])],
  ["item.completed", new Set(["type", "turnId", "snapshot"])],
  ["item.detached", new Set(["type", "turnId", "itemId"])],
  ["item.background.started", new Set(["type", "turnId", "item"])],
  ["interaction.closed", new Set(["type", "interactionId", "turnId", "reason"])],
  ["turn.completed", new Set(["type", "turnId", "nativeTurnRef", "outcome"])],
  ["session.faulted", new Set(["type", "error"])],
]);
const interactionKeys = new Map<string, ReadonlySet<string>>([
  [
    "question",
    new Set(["type", "interactionId", "turnId", "itemId", "title", "questions", "expiresAt"]),
  ],
  [
    "approval",
    new Set([
      "type",
      "interactionId",
      "turnId",
      "title",
      "description",
      "subject",
      "actions",
      "expiresAt",
    ]),
  ],
]);

function strictKeys(
  value: unknown,
  allowed: ReadonlySet<string> | undefined,
): value is Record<string, unknown> {
  return Boolean(
    allowed &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key)),
  );
}

const nonNegativeSafeIntegerSchema = z.int().nonnegative();
const toolOutputSchema = z.strictObject({
  content: z.array(
    z.discriminatedUnion("type", [
      textInputSchema,
      z.strictObject({ type: z.literal("image"), mimeType: z.string(), base64Data: z.string() }),
    ]),
  ),
  truncated: z.boolean().optional(),
});
const fileChangeSchema = z.strictObject({
  path: z.string(),
  kind: z.enum(["add", "update", "delete"]),
  unifiedDiff: z.string(),
  diffScope: z.literal("fragment").optional(),
});
const subagentStateSchema = z.strictObject({
  subagentId: z.string().min(1),
  nativeSubagentId: z.string().min(1).optional(),
  description: z.string(),
  role: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  background: z.boolean(),
  status: z.enum(["pending", "running", "completed", "failed", "interrupted"]),
  resultSummary: z.string().optional(),
});
const itemBase = { itemId: hostItemIdSchema };
const toolFields = {
  ...itemBase,
  toolName: z.string(),
  arguments: jsonValueSchema,
  output: toolOutputSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
};
const snapshotItemSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...itemBase,
    type: z.literal("agentMessage"),
    text: z.string(),
    phase: z.enum(["commentary", "final_answer"]).optional(),
  }),
  z.strictObject({ ...itemBase, type: z.literal("userMessage"), input: z.array(textInputSchema) }),
  z.strictObject({ ...itemBase, type: z.literal("reasoning"), text: z.string() }),
  z.strictObject({ ...itemBase, type: z.literal("contextCompaction") }),
  z.strictObject({
    ...itemBase,
    type: z.literal("commandExecution"),
    command: z.string(),
    cwd: cwdSchema.optional(),
    output: z.string().optional(),
    outputTruncated: z.boolean().optional(),
    exitCode: z.int().nullable().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    ...toolFields,
    type: z.literal("toolExecution"),
    namespace: z.string().optional(),
  }),
  z.strictObject({ ...toolFields, type: z.literal("mcpToolCall"), server: z.string() }),
  z.strictObject({ ...itemBase, type: z.literal("webSearch"), query: z.string() }),
  z.strictObject({
    ...itemBase,
    type: z.literal("fileChange"),
    changes: z.array(fileChangeSchema),
    sourceItemIds: z.array(hostItemIdSchema).optional(),
  }),
  z.strictObject({
    ...itemBase,
    type: z.literal("subagentDelegation"),
    operation: z.enum(["spawn", "send"]),
    prompt: z.string().optional(),
    subagents: z.array(subagentStateSchema),
  }),
]);
const terminalOutcomes = [
  z.strictObject({ status: z.literal("succeeded") }),
  z.strictObject({ status: z.literal("failed"), error: harnessErrorSchema }),
  z.strictObject({ status: z.literal("cancelled"), reason: z.string().optional() }),
] as const;
const autonomousSnapshotSchema = z
  .strictObject({
    nativeTurnRef: nativeTurnRefSchema,
    checkpoint: nativeCheckpointRefSchema.optional(),
    input: z.array(textInputSchema),
    items: z.array(
      z.strictObject({
        item: snapshotItemSchema,
        outcome: z.discriminatedUnion("status", terminalOutcomes),
      }),
    ),
    outcome: z.discriminatedUnion("status", [
      ...terminalOutcomes,
      z.strictObject({ status: z.literal("unknown"), reason: z.string() }),
    ]),
    model: harnessModelRefSchema.optional(),
    startedAtMs: nonNegativeSafeIntegerSchema.optional(),
    completedAtMs: nonNegativeSafeIntegerSchema.optional(),
  })
  .refine(
    ({ checkpoint, nativeTurnRef }) =>
      !checkpoint ||
      (checkpoint.harnessId === nativeTurnRef.harnessId &&
        checkpoint.nativeSessionId === nativeTurnRef.nativeSessionId),
    { path: ["checkpoint"], message: "Checkpoint must belong to the native Turn's Session" },
  )
  .refine(
    ({ startedAtMs, completedAtMs }) =>
      startedAtMs === undefined || completedAtMs === undefined || completedAtMs >= startedAtMs,
    { path: ["completedAtMs"], message: "Turn cannot complete before it starts" },
  )
  .refine(({ items }) => new Set(items.map(({ item }) => item.itemId)).size === items.length, {
    path: ["items"],
    message: "Item IDs must be unique within the Turn",
  });

const usageOutputIntervalSchema = z
  .strictObject({
    startedAtMs: nonNegativeSafeIntegerSchema,
    completedAtMs: nonNegativeSafeIntegerSchema,
    outputTokens: nonNegativeSafeIntegerSchema,
  })
  .refine(({ startedAtMs, completedAtMs }) => completedAtMs > startedAtMs);
const usageRequestTimingSchema = z.union([
  z.strictObject({
    requestId: z.string().min(1),
    requestStartedAtMs: nonNegativeSafeIntegerSchema,
    timeToFirstOutputMs: nonNegativeSafeIntegerSchema,
    output: usageOutputIntervalSchema.optional(),
  }),
  z.strictObject({ requestId: z.string().min(1), output: usageOutputIntervalSchema }),
]);

export const harnessOutputSchema = z.custom<HarnessOutput>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  if (output.kind === "event") {
    if (Object.keys(output).some((key) => key !== "kind" && key !== "event")) return false;
    const event = output.event as Record<string, unknown> | undefined;
    if (!strictKeys(event, eventKeys.get(String(event?.type)))) return false;
    if (event.type === "session.state.changed")
      return harnessSessionStateSchema.safeParse(event.state).success;
    if (event.type === "item.background.started")
      return (
        hostTurnIdSchema.safeParse(event.turnId).success &&
        z
          .object({
            type: z.enum(["agentMessage", "reasoning"]),
            itemId: hostItemIdSchema,
            text: z.string(),
          })
          .strict()
          .safeParse(event.item).success
      );
    if (event.type === "turn.autonomous.completed")
      return autonomousSnapshotSchema.safeParse(event.snapshot).success;
    if (event.type === "session.faulted") return harnessErrorSchema.safeParse(event.error).success;
    if (event.type === "usage.history") return typeof event.complete === "boolean";
    if (event.type === "usage.request.timing")
      return (
        hostTurnIdSchema.safeParse(event.turnId).success &&
        usageRequestTimingSchema.safeParse(event.timing).success
      );
    return true;
  }
  if (output.kind === "interaction") {
    if (Object.keys(output).some((key) => key !== "kind" && key !== "interaction")) return false;
    const interaction = output.interaction as Record<string, unknown> | undefined;
    return strictKeys(interaction, interactionKeys.get(String(interaction?.type)));
  }
  return false;
});

export type ValidatedHarnessError = z.infer<typeof harnessErrorSchema> & HarnessError;
