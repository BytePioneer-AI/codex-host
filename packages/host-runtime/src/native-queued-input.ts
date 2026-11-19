import type { JsonObject } from "@codexhost/protocol-core";
import type { NativeClientReply } from "./native-client-channel.js";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Submit through the native queue; only its idle-only start may begin execution. */
export async function submitNativeQueuedInput(
  request: (method: string, params: JsonObject) => Promise<NativeClientReply>,
  params: JsonObject,
): Promise<NativeClientReply> {
  const threadId = params.threadId;
  if (typeof threadId !== "string")
    return { error: { code: -32602, message: "threadId is required" } };
  const read = await request("thread/read", { threadId, includeTurns: false });
  if ("error" in read) return read;
  const thread = object(read.result) ? read.result.thread : undefined;
  if (!object(thread) || thread.id !== threadId || !object(thread.status))
    return { error: { code: -32603, message: "Codex did not confirm the Thread runtime state" } };
  const idle = thread.status.type === "idle";
  const added = await request("thread/queue/add", params);
  if ("error" in added) return added;
  const item = object(added.result) ? added.result.queuedSubmission : undefined;
  if (!object(item) || typeof item.id !== "string")
    return {
      error: { code: -32090, message: "Codex did not confirm the queued input. Do not resend." },
    };

  // Only confirmed idle input is eligible for automatic start. Input submitted
  // during an active Turn stays queued even if that Turn is stopped during admission.
  if (!idle) return added;

  // Input is already accepted. A failed start must never invite resubmission.
  const unconfirmed = (): NativeClientReply => ({
    error: {
      code: -32095,
      message:
        "Codex accepted the queued input, but its start was not confirmed. Check the queue; do not resend.",
    },
  });
  try {
    const queue = await request("thread/queue/list", { threadId, limit: 1 });
    if ("error" in queue || !object(queue.result) || !Array.isArray(queue.result.data))
      return unconfirmed();
    const head = queue.result.data[0];
    // Automatic advancement or another client may already have claimed it.
    if (!object(head) || head.id !== item.id) return added;
    const started = await request("thread/queue/start", {
      threadId,
      queuedSubmissionId: item.id,
    });
    if ("error" in started) {
      // Native start rejects concurrent Desktop work without steering it.
      if (
        started.error.message === "thread already has an active or pending turn" ||
        started.error.message === `queued submission not found: ${item.id}`
      )
        return added;
      return unconfirmed();
    }
    const turn = object(started.result) ? started.result.turn : undefined;
    return object(turn) && typeof turn.id === "string" ? started : unconfirmed();
  } catch {
    return unconfirmed();
  }
}
