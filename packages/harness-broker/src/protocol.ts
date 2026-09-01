import { z } from "zod";

export const HARNESS_BROKER_PROTOCOL_VERSION = 1 as const;
export const HARNESS_BROKER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const HARNESS_BROKER_MAX_PENDING_REQUESTS = 32;
export const HARNESS_BROKER_REQUEST_TIMEOUT_MS = 15_000;

export const harnessBrokerMethodSchema = z.enum([
  "adapter.inspect",
  "adapter.open",
  "adapter.subagent.readSnapshot",
  "session.readSnapshot",
  "session.refreshUsage",
  "session.execute",
  "session.commands.list",
  "session.commands.execute",
  "session.reopen",
  "session.close",
]);
export type HarnessBrokerMethod = z.infer<typeof harnessBrokerMethodSchema>;

export const harnessBrokerHelloSchema = z
  .object({
    version: z.literal(HARNESS_BROKER_PROTOCOL_VERSION),
    generation: z.string().uuid(),
    sequence: z.literal(1),
    kind: z.literal("hello"),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const harnessBrokerRequestSchema = z
  .object({
    version: z.literal(HARNESS_BROKER_PROTOCOL_VERSION),
    generation: z.string().uuid(),
    sequence: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
    kind: z.literal("request"),
    id: z.string().uuid(),
    method: harnessBrokerMethodSchema,
    params: z.unknown(),
  })
  .strict();
export type HarnessBrokerRequest = z.infer<typeof harnessBrokerRequestSchema>;

export const harnessBrokerResponseSchema = z
  .object({
    version: z.literal(HARNESS_BROKER_PROTOCOL_VERSION),
    generation: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.literal("response"),
    id: z.string().uuid(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z
      .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.ok === Boolean(frame.error)) {
      context.addIssue({ code: "custom", message: "Response must contain value or error" });
    }
  });

export const harnessBrokerOutputSchema = z
  .object({
    version: z.literal(HARNESS_BROKER_PROTOCOL_VERSION),
    generation: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.literal("output"),
    sessionId: z.string().uuid(),
    sessionGeneration: z.number().int().positive(),
    output: z.unknown(),
  })
  .strict();

export const harnessBrokerServerFrameSchema = z.union([
  harnessBrokerResponseSchema,
  harnessBrokerOutputSchema,
]);
export type HarnessBrokerServerFrame = z.infer<typeof harnessBrokerServerFrameSchema>;

export interface HarnessBrokerDescriptorV1 {
  schemaVersion: 1;
  protocolVersion: 1;
  harnessId: "claude-code";
  generation: string;
  ownerPid: number;
  socketPath: string;
  token: string;
}

export const harnessBrokerDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(HARNESS_BROKER_PROTOCOL_VERSION),
    harnessId: z.literal("claude-code"),
    generation: z.string().uuid(),
    ownerPid: z.number().int().positive(),
    socketPath: z.string().min(1).max(512),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export function protocolError(message: string): {
  code: string;
  message: string;
  retryable: false;
} {
  return { code: "protocolError", message, retryable: false };
}
