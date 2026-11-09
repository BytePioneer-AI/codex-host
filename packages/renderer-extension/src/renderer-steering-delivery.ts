import {
  threadOwnershipListResultSchema,
  threadSteeringInspectResultSchema,
} from "@codexhost/shared-contracts";
import { verifyNativeCodexThread } from "./renderer-native-thread.js";
import { isUnsupportedMethod } from "./renderer-request-sender.js";

type Send = (method: string, params: unknown) => unknown;

/** An unsupported Host extension is not evidence of external ownership. Stock
 * app-servers must still verify as native before their steering passes through. */
export async function inspectRendererSteeringDelivery(
  send: Send,
  threadId: string,
  text?: string,
): Promise<"official" | "activeTurn" | "newTurn"> {
  const inspect = "codexhost/thread/steering/inspect";
  try {
    const response = await send(inspect, { threadId, ...(text !== undefined ? { text } : {}) });
    return threadSteeringInspectResultSchema.parse(response).delivery;
  } catch (error) {
    if (!isUnsupportedMethod(error, inspect)) throw error;
  }
  const ownership = "codexhost/thread/ownership/list";
  let response: unknown;
  try {
    response = await send(ownership, { threadIds: [threadId] });
  } catch (error) {
    if (!isUnsupportedMethod(error, ownership)) throw error;
    await verifyNativeCodexThread(send, threadId);
    return "official";
  }
  const result = threadOwnershipListResultSchema.parse(response);
  const owner = result.threads.find((thread) => thread.threadId === threadId)?.owner;
  if (!owner) throw new Error("Thread ownership could not be resolved for steering");
  return owner === "codex" ? "official" : "newTurn";
}
