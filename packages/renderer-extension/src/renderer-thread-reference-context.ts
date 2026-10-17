import { THREAD_REFERENCE_SOURCE_HOST_PARAM } from "@codexhost/shared-contracts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Capture the submitting connection, not the selected Composer or another window. */
export function createThreadReferenceContext(
  manager: unknown,
  hostId: string,
  isCurrent: () => boolean,
): (params: unknown) => unknown {
  const prepared = new WeakMap<object, Record<string, unknown>>();
  return (params) => {
    if (
      hostId === "local" ||
      !record(manager) ||
      typeof manager.getConversation !== "function" ||
      !record(params) ||
      typeof params.threadId !== "string"
    )
      return params;
    const conversation: unknown = manager.getConversation.call(manager, params.threadId);
    if (
      !record(conversation) ||
      conversation.id !== params.threadId ||
      conversation.modelProvider !== "codexhost"
    )
      return params;
    if (!isCurrent()) throw new Error("Thread reference connection is no longer available");
    const cached = prepared.get(params);
    if (cached) return cached;
    const result = { ...params, [THREAD_REFERENCE_SOURCE_HOST_PARAM]: hostId };
    prepared.set(params, result);
    return result;
  };
}
