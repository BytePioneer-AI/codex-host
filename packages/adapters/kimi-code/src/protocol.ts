import { z } from "zod";
import type { HarnessError, HarnessErrorCode, HarnessResult } from "@codexhost/harness-adapter";
import { harnessIdSchema, jsonValueSchema } from "@codexhost/shared-contracts";

export const HARNESS_ID = harnessIdSchema.parse("kimi-code");
export const SERVER_VERSION = "2.0.2";
export class KimiError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export function failure(error: unknown): { ok: false; error: HarnessError } {
  return {
    ok: false,
    error:
      error instanceof KimiError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : {
            code: "protocolError",
            message: "Kimi Code returned an invalid response or the transport failed",
            retryable: false,
          },
  };
}
export function success<T>(value: T): HarnessResult<T> {
  return { ok: true, value };
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new KimiError("protocolError", "Kimi Code response does not match the 2.0.2 protocol");
  return result.data;
}
export const permissionSchema = z.enum(["manual", "yolo", "auto"]);
export const modelsSchema = z.object({
  items: z.array(
    z.object({
      provider: z.string(),
      model: z.string().min(1),
      display_name: z.string().optional(),
      support_efforts: z.array(z.string()).optional(),
      default_effort: z.string().optional(),
    }),
  ),
});
export type NativeModel = z.infer<typeof modelsSchema>["items"][number];
export const sessionSchema = z.object({
  id: z.string().min(1),
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  current_prompt_id: z.string().optional(),
  metadata: z.object({ cwd: z.string() }),
  agent_config: z.object({
    model: z.string(),
    thinking: z.string().optional(),
    permission_mode: permissionSchema.optional(),
    plan_mode: z.boolean().optional(),
    swarm_mode: z.boolean().optional(),
    tower_mode: z.boolean().optional(),
    goal_objective: z.string().optional(),
  }),
});
export type NativeSession = z.infer<typeof sessionSchema>;
export const statusSchema = z.object({
  busy: z.boolean(),
  model: z.string().optional(),
  thinking_level: z.string(),
  permission: permissionSchema,
  plan_mode: z.boolean(),
  swarm_mode: z.boolean(),
  tower_mode: z.boolean().optional(),
});
export type NativeStatus = z.infer<typeof statusSchema>;
export const approvalSchema = z.object({
  approval_id: z.string(),
  agent_id: z.string(),
  turn_id: z.number().optional(),
  tool_call_id: z.string(),
  tool_name: z.string(),
  action: z.string(),
  expires_at: z.string(),
});
export const questionSchema = z.object({
  question_id: z.string(),
  agent_id: z.string().optional(),
  turn_id: z.number().optional(),
  tool_call_id: z.string().optional(),
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      header: z.string().optional(),
      body: z.string().optional(),
      options: z.array(
        z.object({ id: z.string(), label: z.string(), description: z.string().optional() }),
      ),
      multi_select: z.boolean().optional(),
      allow_other: z.boolean().optional(),
    }),
  ),
});
export type NativeQuestion = z.infer<typeof questionSchema>;
export const snapshotSchema = z.object({
  as_of_seq: z.number().int().nonnegative(),
  epoch: z.string(),
  session: sessionSchema,
  in_flight_turn: z
    .object({ turn_id: z.number(), current_prompt_id: z.string().optional() })
    .nullable(),
  pending_approvals: z.array(approvalSchema),
  pending_questions: z.array(questionSchema),
});
export type NativeSnapshot = z.infer<typeof snapshotSchema>;
const textFrame = z.object({
  kind: z.literal("text"),
  frameId: z.string(),
  text: z.string(),
  role: z.enum(["user", "assistant"]),
});
const thinkingFrame = z.object({
  kind: z.literal("thinking"),
  frameId: z.string(),
  text: z.string(),
});
const toolFrame = z.object({
  kind: z.literal("tool"),
  frameId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  state: z.enum(["running", "done", "error"]),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  display: jsonValueSchema.optional(),
  error: z.string().optional(),
  progress: z.object({ text: z.string().optional() }).optional(),
});
export const frameSchema = z.discriminatedUnion("kind", [
  textFrame,
  thinkingFrame,
  toolFrame,
  z.object({
    kind: z.literal("notice"),
    frameId: z.string(),
    level: z.enum(["error", "warning", "info"]),
    message: z.string(),
  }),
]);
export type NativeFrame = z.infer<typeof frameSchema>;
export const turnSchema = z.object({
  kind: z.literal("turn"),
  turnId: z.string(),
  triggerPromptId: z.string().optional(),
  ordinal: z.number(),
  state: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  prompt: z.string().optional(),
  steps: z.array(
    z.object({
      stepId: z.string(),
      state: z.enum(["running", "completed", "interrupted", "failed"]),
      frames: z.array(frameSchema),
    }),
  ),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  error: z.string().optional(),
});
export type NativeTurn = z.infer<typeof turnSchema>;
export const transcriptSchema = z.object({
  agent_id: z.string(),
  items: z.array(
    z.discriminatedUnion("kind", [
      turnSchema,
      z.object({ kind: z.literal("marker"), markerId: z.string() }),
      z.object({ kind: z.literal("taskref"), refId: z.string() }),
    ]),
  ),
  has_more: z.boolean(),
});
export type TranscriptPage = z.infer<typeof transcriptSchema>;
export const frameEnvelopeSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative().optional(),
  epoch: z.string().optional(),
  session_id: z.string().optional(),
  volatile: z.boolean().optional(),
  offset: z.number().int().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type NativeEvent = z.infer<typeof frameEnvelopeSchema>;
export interface KimiTransport {
  request(path: string, method?: "GET" | "POST", body?: unknown): Promise<unknown>;
  connect(
    onEvent: (event: NativeEvent) => void,
    onFault: (error: KimiError) => void,
  ): Promise<void>;
  subscribe(sessionId: string, cursor: { seq: number; epoch: string }): Promise<void>;
  close(): Promise<void>;
}
export interface TransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  /** Register owned resources before asynchronous startup can fail. */
  onCreated?: (transport: KimiTransport) => void;
}
export type TransportFactory = (options: TransportOptions) => Promise<KimiTransport>;
export function sessionPath(id: string): string {
  return `/api/v1/sessions/${encodeURIComponent(id)}`;
}
