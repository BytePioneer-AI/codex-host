import { randomUUID } from "node:crypto";
import {
  remoteDeliveryReplySchema,
  type RemoteSessionOperation,
} from "@codexhost/shared-contracts";
import { z } from "zod";
import { RpcError } from "./transport.ts";

type Delivery = Extract<RemoteSessionOperation, { kind: "delivery" }>;
type Identity = Pick<Delivery, "hostId" | "threadId">;
export type RemoteSessionCall = (operation: RemoteSessionOperation) => Promise<unknown>;

const statusSchema = z.object({
  threadId: z.string(),
  status: z.string(),
  turnId: z.string().min(1).nullable(),
  epoch: z.string().min(1),
  readOnly: z.literal(true).optional(),
});
const textParts = z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1);
const promptInput = z.object({
  mode: z.enum(["queue", "steer"]),
  requestId: z.string().optional(),
  expectedTurnId: z.string().min(1).nullable().optional(),
});
const queueUpdate = z.object({
  itemId: z.string().min(1),
  action: z.object({ kind: z.enum(["remove", "steer"]) }),
});

export async function readRemoteThreadStatus(invoke: RemoteSessionCall, identity: Identity) {
  const result = statusSchema.safeParse(await invoke({ kind: "status", ...identity }));
  if (!result.success || result.data.threadId !== identity.threadId)
    throw new RpcError("remote/read-failed", "Invalid remote Thread status.");
  return result.data;
}

export function remotePromptText(content: unknown): string {
  const parsed = textParts.safeParse(content);
  if (!parsed.success)
    throw new RpcError("remote/unsupported", "Remote follow-up accepts text only.");
  const text = parsed.data.map((part) => part.text).join("\n");
  if (!text.trim()) throw new RpcError("remote/invalid-request", "A remote message requires text.");
  return text;
}

export function remoteOutcomeUnknown(): RpcError {
  return new RpcError(
    "remote/outcome-unknown",
    "Remote operation was not confirmed; its outcome may be unknown. Refresh before deciding whether to retry.",
  );
}

export async function deliverRemoteInput(
  invoke: RemoteSessionCall,
  identity: Identity,
  method: "session/prompt" | "session/updateQueue",
  request: Record<string, unknown>,
): Promise<{ accepted: true }> {
  const status = await readRemoteThreadStatus(invoke, identity);
  if (status.readOnly)
    throw new RpcError("remote/send-rejected", "This remote Thread does not accept direct input.");
  const idle = status.status === "idle" || status.status === "notLoaded";
  const target = { ...identity, epoch: status.epoch };
  let action: Delivery["action"];
  if (method === "session/prompt") {
    const parsed = promptInput.safeParse(request);
    if (!parsed.success)
      throw new RpcError("remote/invalid-request", "Invalid remote follow-up request.");
    const text = remotePromptText(request.content);
    const requestId = parsed.data.requestId ?? randomUUID();
    if (parsed.data.mode === "steer") {
      const expectedTurnId =
        parsed.data.expectedTurnId === undefined ? status.turnId : parsed.data.expectedTurnId;
      if (status.status !== "active" || !expectedTurnId || expectedTurnId !== status.turnId)
        throw new RpcError("remote/turn-changed", "The selected Turn has ended or changed.");
      action = { kind: "steer", text, requestId, turnId: expectedTurnId };
    } else {
      action = { kind: "enqueue", text, requestId };
    }
  } else {
    const parsed = queueUpdate.safeParse(request);
    if (!parsed.success)
      throw new RpcError("remote/unsupported", "This remote queue operation is unavailable.");
    const { action: update, itemId } = parsed.data;
    if (update.kind === "steer" && !idle)
      throw new RpcError(
        "session/steer-unavailable",
        "Use Codex Desktop to steer an already queued remote message.",
      );
    action = { kind: update.kind === "remove" ? "remove" : "start", itemId };
  }

  const raw = await invoke({ kind: "delivery", ...target, action });
  const result = remoteDeliveryReplySchema.safeParse(raw);
  if (!result.success) throw remoteOutcomeUnknown();
  if (!result.data.accepted) throw new RpcError(result.data.code, result.data.message);
  return result.data;
}
