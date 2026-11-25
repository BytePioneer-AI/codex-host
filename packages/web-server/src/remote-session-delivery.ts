import { randomUUID } from "node:crypto";
import {
  remoteDeliveryReplySchema,
  type RemoteSessionOperation,
} from "@codexhost/shared-contracts";
import { z } from "zod";
import { RpcError } from "./transport.ts";

type Delivery = Extract<RemoteSessionOperation, { kind: "delivery" }>;
type LegacyPrompt = Extract<RemoteSessionOperation, { kind: "prompt" }>;
type Identity = Pick<Delivery, "hostId" | "threadId">;
export type RemoteSessionCall = (operation: RemoteSessionOperation) => Promise<unknown>;

interface RemoteInputReceipt {
  accepted: true;
  queueStartUnconfirmed?: true;
}

const statusSchema = z.object({
  threadId: z.string(),
  status: z.string(),
  turnId: z.string().min(1).nullable(),
  epoch: z.string().min(1),
  supportsDelivery: z.literal(true).optional(),
  supportsQueuedSteer: z.literal(true).optional(),
  readOnly: z.boolean().optional(),
});
const textParts = z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1);
const promptInput = z.object({
  mode: z.enum(["queue", "steer"]),
  requestId: z.string().optional(),
  expectedTurnId: z.string().min(1).nullable().optional(),
  sendWhenIdle: z.literal(true).optional(),
});
const queueUpdate = z.object({
  itemId: z.string().min(1),
  action: z.object({ kind: z.enum(["remove", "steer"]) }),
});
const legacyPromptReply = z.object({ turn: z.object({ id: z.string().min(1) }) });

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

async function sendLegacyPrompt(
  invoke: RemoteSessionCall,
  operation: LegacyPrompt,
): Promise<RemoteInputReceipt> {
  if (!legacyPromptReply.safeParse(await invoke(operation)).success) throw remoteOutcomeUnknown();
  return { accepted: true };
}

export async function deliverRemoteInput(
  invoke: RemoteSessionCall,
  identity: Identity,
  method: "session/prompt" | "session/updateQueue",
  request: Record<string, unknown>,
  readLegacyStatus: () => Promise<z.infer<typeof statusSchema>>,
): Promise<RemoteInputReceipt> {
  const prompt = method === "session/prompt" ? promptInput.safeParse(request) : undefined;
  if (prompt && !prompt.success)
    throw new RpcError("remote/invalid-request", "Invalid remote follow-up request.");
  const input = prompt?.data;
  const ordinaryIdleSend = input?.mode === "queue" && input.sendWhenIdle === true;
  const status = await readRemoteThreadStatus(invoke, identity).catch((error: unknown) => {
    if (
      ordinaryIdleSend &&
      error instanceof RpcError &&
      error.code === "remote/controller-rejected"
    )
      return readLegacyStatus();
    throw error;
  });
  if (status.readOnly)
    throw new RpcError("remote/send-rejected", "This remote Thread does not accept direct input.");
  const idle = status.status === "idle" || status.status === "notLoaded";
  const target = { ...identity, epoch: status.epoch };
  let action: Delivery["action"];
  let legacyPrompt: LegacyPrompt | undefined;
  if (input) {
    const text = remotePromptText(request.content);
    const requestId = input.requestId ?? randomUUID();
    if (input.mode === "steer") {
      const expectedTurnId =
        input.expectedTurnId === undefined ? status.turnId : input.expectedTurnId;
      if (status.status !== "active" || !expectedTurnId || expectedTurnId !== status.turnId)
        throw new RpcError("remote/turn-changed", "The selected Turn has ended or changed.");
      action = { kind: "steer", text, requestId, turnId: expectedTurnId };
    } else {
      action = { kind: "enqueue", text, requestId };
      if (ordinaryIdleSend && idle) legacyPrompt = { kind: "prompt", ...target, text, requestId };
    }
  } else {
    const parsed = queueUpdate.safeParse(request);
    if (!parsed.success)
      throw new RpcError("remote/unsupported", "This remote queue operation is unavailable.");
    const { action: update, itemId } = parsed.data;
    if (update.kind === "remove") {
      action = { kind: "remove", itemId };
    } else if (status.supportsQueuedSteer) {
      action = { kind: "sendNow", itemId };
    } else if (!idle) {
      throw new RpcError(
        "remote/steer-unavailable",
        "Use Codex Desktop to steer an already queued remote message.",
      );
    } else {
      action = { kind: "start", itemId };
    }
  }

  if (!status.supportsDelivery) {
    if (legacyPrompt) return sendLegacyPrompt(invoke, legacyPrompt);
    if (action.kind === "steer" || action.kind === "sendNow")
      throw new RpcError(
        "remote/steer-unavailable",
        "This Desktop Controller cannot steer remote Turns.",
      );
    throw new RpcError(
      "remote/queue-unavailable",
      "This Desktop Controller does not support remote message queues.",
    );
  }

  const raw = await invoke({ kind: "delivery", ...target, action });
  const result = remoteDeliveryReplySchema.safeParse(raw);
  if (!result.success) throw remoteOutcomeUnknown();
  if (!result.data.accepted) {
    if (legacyPrompt && result.data.code === "remote/queue-unavailable")
      return sendLegacyPrompt(invoke, legacyPrompt);
    throw new RpcError(result.data.code, result.data.message);
  }
  if (action.kind === "enqueue" && result.data.startQueuedItemId) {
    try {
      const started = remoteDeliveryReplySchema.safeParse(
        await invoke({
          kind: "delivery",
          ...target,
          action: { kind: "start", itemId: result.data.startQueuedItemId, onlyIfHead: true },
        }),
      );
      if (
        started.success &&
        (started.data.accepted ||
          started.data.code === "remote/turn-changed" ||
          started.data.code === "session/queue-item-not-found")
      )
        return { accepted: true };
    } catch {
      // The confirmed queue admission still stands after a lost start reply.
    }
    return { accepted: true, queueStartUnconfirmed: true };
  }
  return { accepted: true };
}
