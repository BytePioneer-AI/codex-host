function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Desktop 26.1027 manages the follow-up queue in its main process and serves
 * Host-projected external Threads from the Host's native `thread/queue/*`
 * implementation. The legacy `serverQueue.isEnabled(threadId)` gate must let
 * those Threads through (the stock app-server cannot execute a Harness Turn,
 * but the codexhost Host answers the same protocol natively); excluding them
 * strands every follow-up in a queue Desktop can no longer execute locally.
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
        return true;
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
