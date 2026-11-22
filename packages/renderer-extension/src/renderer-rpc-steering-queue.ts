type Call = (method: string, ...args: unknown[]) => unknown;
const INTERRUPTED = "Interrupted before the steer was accepted.";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Native RPC exposes resume-all, not a selective queue mutation. Refuse a
 * replacement when it would also resume a different previously paused input. */
export async function prepareRpcSteeringQueue(
  hostId: string,
  threadId: string,
  manager: Call,
  coordinator: Call,
  messageId: string,
): Promise<(turnId: string) => Promise<void>> {
  const snapshot = Promise.withResolvers<unknown[]>();
  let lease: unknown;
  let released = false;
  const dispose = (value: unknown) => {
    if (value != null) (value as Partial<Disposable>)[Symbol.dispose]?.();
  };
  const pending = manager("subscribe", {
    type: "thread",
    key: { hostId, threadId },
    field: "queuedMessages",
    listener(value: unknown) {
      if (Array.isArray(value)) snapshot.resolve(value);
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let messages: unknown[];
  try {
    timeout = setTimeout(
      () => snapshot.reject(new Error("Native follow-up queue did not become ready")),
      5000,
    );
    const ready = Promise.resolve(pending).then((value) => {
      if (released) dispose(value);
      else lease = value;
    });
    [messages] = await Promise.all([snapshot.promise, ready]);
  } finally {
    released = true;
    clearTimeout(timeout);
    for (const value of new Set([pending, lease])) dispose(value);
  }
  if (
    messages.some(
      (message) =>
        record(message) && message.id !== messageId && message.pausedReason === INTERRUPTED,
    )
  )
    throw new Error(
      "Resume or remove the other previously paused messages before changing direction",
    );
  return async (turnId) => {
    // A successful native start already owns this input. Do not clear arbitrary
    // queue state, and do not turn a later cleanup failure into a delivery retry.
    await coordinator("removeQueuedMessage", threadId, messageId);
    const state = await manager("getThreadExecutionState", threadId);
    const stillRunning =
      record(state) && state.inProgress === true && state.activeTurnId === turnId;
    // An explicit stop or failure after acceptance must keep the queue paused.
    const turn = stillRunning ? null : await manager("getTurnById", threadId, turnId);
    if (stillRunning || (record(turn) && turn.status === "completed"))
      await coordinator("resumeInterruptedQueuedMessages", threadId);
  };
}
