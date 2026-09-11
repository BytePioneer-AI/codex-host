function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Desktop 26.903.61454 still owns the local follow-up queue and its execution.
 * Its serverQueue.isEnabled(threadId) gate must exclude Host-projected external
 * Threads: the official app-server queue cannot execute a Harness Turn.
 */
export function installRendererExternalQueue(target: unknown): (() => void) | null {
  if (
    !isRecord(target) ||
    typeof target.getTurnCoordinator !== "function" ||
    typeof target.getConversation !== "function"
  ) {
    return null;
  }
  const coordinator: unknown = target.getTurnCoordinator();
  const queue = isRecord(coordinator) ? coordinator.serverQueue : null;
  if (!isRecord(queue) || typeof queue.isEnabled !== "function") return null;
  // This is Desktop's plain queue backend object, not a RpcTarget. Do not shadow
  // inherited methods or guess at a different private API shape.
  const descriptor = Object.getOwnPropertyDescriptor(queue, "isEnabled");
  if (!descriptor?.writable) return null;
  const original = queue.isEnabled;
  const getConversation = target.getConversation;
  const isEnabled = (...args: unknown[]): unknown => {
    const threadId = args[0];
    if (typeof threadId === "string") {
      const conversation: unknown = getConversation.call(target, threadId);
      if (
        isRecord(conversation) &&
        conversation.id === threadId &&
        // Reserved transport marker from externalThreadValue, retained by
        // Desktop in both newly created and hydrated conversation metadata.
        conversation.modelProvider === "codexhost"
      ) {
        return false;
      }
    }
    // Preserve native/unknown Threads, feature flags, and no-argument probes.
    // No selected-Agent state, ownership cache, or additional RPC is needed.
    return original.apply(queue, args);
  };
  queue.isEnabled = isEnabled;
  return () => {
    if (queue.isEnabled === isEnabled) Object.defineProperty(queue, "isEnabled", descriptor);
  };
}
