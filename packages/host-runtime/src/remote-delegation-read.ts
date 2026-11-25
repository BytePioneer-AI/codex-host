import { requestDesktopRemoteConnections } from "@codexhost/desktop-control";
import { delegationReadParamsSchema, harnessIdSchema } from "@codexhost/shared-contracts";
import { z } from "zod";
import {
  DelegationControlError,
  type DelegationThreadSnapshot,
  type ThreadReadInput,
} from "./delegation-types.js";

const status = z.enum(["creating", "running", "completed", "failed", "interrupted"]);
const snapshot = z.object({
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
  totalTurns: z.number().int().nonnegative().optional(),
  from: z.number().int().positive().nullable().optional(),
  to: z.number().int().positive().nullable().optional(),
  turns: z
    .array(
      z.object({
        turnId: z.string().nullable(),
        turnNumber: z.number().int().positive(),
        status,
        messages: z.array(
          z.object({
            id: z.string(),
            role: z.enum(["user", "agent"]),
            text: z.string(),
            phase: z.literal("final").optional(),
          }),
        ),
      }),
    )
    .optional(),
});

/** Uses the existing authenticated Desktop connection, never an arbitrary endpoint or shell. */
export async function readRemoteDelegationThread(
  environment: NodeJS.ProcessEnv,
  input: ThreadReadInput,
): Promise<DelegationThreadSnapshot> {
  const { hostId, ...read } = input;
  const reply = await requestDesktopRemoteConnections(environment, {
    action: "read-thread",
    hostId,
    input: delegationReadParamsSchema.parse(read),
  });
  if ("error" in reply)
    throw new DelegationControlError(
      reply.error.code === -32094 ? "RESPONSE_TOO_LARGE" : "RUNTIME_UNREACHABLE",
      reply.error.message,
    );
  const schema =
    input.view === "messages"
      ? snapshot.required({ totalTurns: true, from: true, to: true, turns: true })
      : snapshot;
  const parsed = schema.safeParse(reply.result);
  if (!parsed.success || parsed.data.threadId !== input.threadId)
    throw new DelegationControlError(
      "INTERNAL_ERROR",
      "Remote Host returned an invalid Thread snapshot",
    );
  // JSON transport omits undefined properties; the schema validates every snapshot field.
  return { ...parsed.data, hostId } as DelegationThreadSnapshot;
}
