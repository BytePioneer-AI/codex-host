import {
  DelegationControlError,
  type DelegationControlApi,
  type ThreadSendInput,
  type ThreadSendResult,
} from "./delegation-types.js";

export const INTERRUPT_STOP_TIMEOUT_MS = 30_000;

/** Stop first, confirm idle, then send once. No retry or queue if another sender wins the gap. */
export async function interruptAndSend(
  api: Pick<DelegationControlApi, "read" | "cancel" | "wait" | "send">,
  input: ThreadSendInput,
): Promise<ThreadSendResult> {
  if (typeof input.message !== "string" || !input.message.trim())
    throw new DelegationControlError("INVALID_ARGUMENT", "Message must not be empty");
  const deadline = Date.now() + INTERRUPT_STOP_TIMEOUT_MS;
  const timeoutError = () =>
    new DelegationControlError(
      "DELEGATION_FAILED",
      `Interrupt timed out after ${INTERRUPT_STOP_TIMEOUT_MS} ms; no new message was sent`,
      { notStarted: true },
    );
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const snapshot = await bounded(() => api.read({ threadId: input.threadId, view: "result" }));
  if (snapshot.status === "running") {
    const cancelled = await bounded(() => api.cancel({ threadId: input.threadId }));
    if (!cancelled.cancelled)
      throw new DelegationControlError(
        "DELEGATION_FAILED",
        "Interrupt cancellation was not accepted; no new message was sent",
        { notStarted: true },
      );
    const stopped = await bounded(() =>
      api.wait({
        threadId: input.threadId,
        view: "result",
        timeoutMs: Math.max(1, deadline - Date.now()),
      }),
    );
    if (stopped.timedOut || stopped.status === "running" || stopped.status === "creating")
      throw timeoutError();
  }
  return api.send(input);
}
