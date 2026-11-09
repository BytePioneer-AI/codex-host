import type { JsonObject } from "@codexhost/protocol-core";
import type { NativeClientReply } from "./native-client-channel.js";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Match the native Desktop queue operation: start while idle, steer while active,
 * and remove the queued entry only after native acceptance. */
export async function sendNativeQueuedMessage(
  request: (method: string, params: JsonObject) => Promise<NativeClientReply>,
  threadId: string,
  itemId: string,
): Promise<NativeClientReply> {
  const turns = await request("thread/turns/list", {
    threadId,
    limit: 5,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
  if ("error" in turns) return turns;
  if (!object(turns.result) || !Array.isArray(turns.result.data))
    return { error: { code: -32603, message: "Codex returned an invalid Turn page" } };
  const active = turns.result.data.find(
    (turn) => object(turn) && turn.status === "inProgress" && typeof turn.id === "string",
  );
  if (!object(active) || typeof active.id !== "string")
    return request("thread/queue/start", { threadId, queuedSubmissionId: itemId });

  let cursor: string | undefined;
  const cursors = new Set<string>();
  let item: JsonObject | undefined;
  do {
    const page = await request("thread/queue/list", {
      threadId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if ("error" in page) return page;
    if (!object(page.result) || !Array.isArray(page.result.data))
      return { error: { code: -32603, message: "Codex returned an invalid queue page" } };
    const found = page.result.data.find((entry) => object(entry) && entry.id === itemId);
    if (object(found)) {
      item = found;
      break;
    }
    cursor = typeof page.result.nextCursor === "string" ? page.result.nextCursor : undefined;
    if (cursor && cursors.has(cursor))
      return { error: { code: -32603, message: "Codex repeated a queue cursor" } };
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (!item || !Array.isArray(item.input) || typeof item.clientUserMessageId !== "string")
    return { error: { code: -32602, message: "Queued message is no longer available" } };

  const steered = await request("turn/steer", {
    threadId,
    expectedTurnId: active.id,
    input: item.input,
    clientUserMessageId: item.clientUserMessageId,
  });
  // A stale target, compaction refusal or uncertain outcome must not become a new Turn.
  if ("error" in steered) return steered;
  if (!object(steered.result) || steered.result.turnId !== active.id)
    return {
      error: { code: -32090, message: "Codex did not confirm the steered Turn. Do not resend." },
    };
  try {
    const deleted = await request("thread/queue/delete", { threadId, queuedSubmissionId: itemId });
    if ("result" in deleted && object(deleted.result) && deleted.result.deleted === true)
      return steered;
  } catch {
    // Acceptance is already confirmed; retrying the steer would duplicate input.
  }
  return {
    error: {
      code: -32095,
      message: "Codex accepted the steer, but queue removal was not confirmed. Do not resend.",
    },
  };
}
