function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * External Threads now use the Shared Host's canonical app-server queue.
 * Keep this binding probe so unsupported Desktop versions still fail closed,
 * but do not override `serverQueue.isEnabled`: the Host implements the native
 * thread/queue protocol for both Desktop and Web clients.
 */
export function installRendererExternalQueue(target: unknown): (() => void) | null {
  if (!isRecord(target) || typeof target.getTurnCoordinator !== "function") return null;
  const coordinator: unknown = target.getTurnCoordinator();
  const queue = isRecord(coordinator) ? coordinator.serverQueue : null;
  if (!isRecord(queue) || typeof queue.isEnabled !== "function") return null;
  return () => undefined;
}
