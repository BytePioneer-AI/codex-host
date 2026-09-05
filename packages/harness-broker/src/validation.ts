import { z } from "zod";

import {
  harnessConfigurationStateSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostTurnIdSchema,
  jsonObjectSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import type { HarnessError, HarnessOutput, HarnessSessionState } from "@codexhost/harness-adapter";

const cwdSchema = z.string().min(1).max(16_384);

const createSchema = z
  .object({
    kind: z.literal("create"),
    cwd: cwdSchema,
    executionPolicy: z.enum(["default", "unattended-full-access"]).optional(),
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
  })
  .strict();
const resumeSchema = z
  .object({
    kind: z.literal("resume"),
    nativeRef: nativeSessionRefSchema,
    cwd: cwdSchema,
    knownTurnRefs: z.array(nativeTurnRefSchema).max(100_000).optional(),
  })
  .strict();
const forkSchema = z
  .object({
    kind: z.literal("fork"),
    sourceRef: nativeSessionRefSchema,
    checkpoint: nativeCheckpointRefSchema,
    cwd: cwdSchema,
  })
  .strict();
const rollbackSchema = z
  .object({
    kind: z.literal("rollbackLastTurn"),
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
  .object({ cwd: cwdSchema.optional(), refresh: z.boolean().optional() })
  .strict();

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
const turnCancelSchema = z
  .object({ type: z.literal("turn.cancel"), turnId: hostTurnIdSchema })
  .strict();
const turnSteerSchema = z
  .object({
    type: z.literal("turn.steer"),
    turnId: hostTurnIdSchema,
    input: z
      .array(textInputSchema)
      .min(1)
      .refine((input) => input.some(({ text }) => text.length > 0), {
        message: "Turn steering input must contain text",
      }),
    clientUserMessageId: z.string().min(1).max(1_024).optional(),
  })
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
  ["subagent.state.changed", new Set(["type", "nativeSubagentId", "status", "resultSummary"])],
  ["subagent.transcript.changed", new Set(["type", "nativeSubagentId"])],
  ["turn.started", new Set(["type", "turnId"])],
  ["turn.autonomous.started", new Set(["type", "turnId", "input"])],
  ["item.started", new Set(["type", "turnId", "item"])],
  ["item.updated", new Set(["type", "turnId", "itemId", "update"])],
  ["item.completed", new Set(["type", "turnId", "snapshot"])],
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

export const harnessOutputSchema = z.custom<HarnessOutput>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  if (output.kind === "event") {
    if (Object.keys(output).some((key) => key !== "kind" && key !== "event")) return false;
    const event = output.event as Record<string, unknown> | undefined;
    if (!strictKeys(event, eventKeys.get(String(event?.type)))) return false;
    if (event.type === "session.state.changed")
      return harnessSessionStateSchema.safeParse(event.state).success;
    if (event.type === "session.faulted") return harnessErrorSchema.safeParse(event.error).success;
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
