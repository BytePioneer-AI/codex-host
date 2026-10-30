import { z } from "zod";
import { harnessIdSchema } from "./ids.js";

/** Serialized Controller replies are bounded independently of message-count pagination. */
export const REMOTE_THREAD_REPLY_MAX_BYTES = 16 * 1024 * 1024;
export const REMOTE_THREAD_READ_TIMEOUT_MS = 35_000;
export const REMOTE_THREAD_CONTROL_TIMEOUT_MS = 40_000;

/** Read-only, Host-local operation. Remote routing is performed by the caller. */
export const DELEGATION_READ_METHOD = "codexhost/thread/delegation-read";
/** Per-submission Desktop connection identity; never a machine-global Host alias. */
export const THREAD_REFERENCE_SOURCE_HOST_PARAM = "codexhostSourceHostId";
export const delegationReadParamsSchema = z.strictObject({
  threadId: z.string().min(1).max(1024),
  view: z.enum(["result", "messages"]),
  cursor: z.string().min(1).max(8192).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type DelegationReadParams = z.infer<typeof delegationReadParamsSchema>;

const status = z.enum(["creating", "running", "completed", "failed", "interrupted"]);
export const delegationThreadSnapshotSchema = z.object({
  threadId: z.string(),
  harnessId: z.union([z.literal("codex"), harnessIdSchema]),
  status,
  turn: z.object({ turnId: z.string(), status }).nullable(),
  progress: z.array(z.object({ id: z.string(), turnId: z.string(), text: z.string() })),
  result: z.object({
    availability: z.enum(["pending", "available", "unavailable"]),
    text: z.string().optional(),
    message: z.string().optional(),
  }),
  messages: z
    .array(
      z.object({
        id: z.string(),
        turnId: z.string(),
        role: z.enum(["user", "agent"]),
        text: z.string(),
        phase: z.enum(["commentary", "final"]).optional(),
      }),
    )
    .optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullable(),
});

/** Fixed read-only callback over an already attached Desktop connection. */
export const DESKTOP_THREAD_READ_METHOD = "codexhost/thread/desktop-read";
export const DESKTOP_THREAD_READ_REPLY_METHOD = "codexhost/thread/desktop-read/reply";
export const desktopThreadReadRequestSchema = z.strictObject({
  requestId: z.string().uuid(),
  input: delegationReadParamsSchema,
});
export const desktopThreadReadReplySchema = z.union([
  z.strictObject({ requestId: z.string().uuid(), result: delegationThreadSnapshotSchema }),
  z.strictObject({
    requestId: z.string().uuid(),
    error: z.strictObject({
      code: z.enum([
        "THREAD_NOT_FOUND",
        "RUNTIME_UNREACHABLE",
        "INTERNAL_ERROR",
        "RESPONSE_TOO_LARGE",
      ]),
      message: z.string().max(4096),
    }),
  }),
]);
export type DesktopThreadReadReply = z.infer<typeof desktopThreadReadReplySchema>;

/** Only absence/unloaded errors permit trying another location, not permission or storage failures. */
export function isDelegationThreadReadMiss(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "THREAD_NOT_FOUND") return true;
  return (
    "message" in error &&
    typeof error.message === "string" &&
    /^(?:Official Thread read failed: )?(?:thread (?:was )?not (?:loaded|found)|no rollout found for thread id|invalid thread id)(?:\b|:)/iu.test(
      error.message,
    )
  );
}
