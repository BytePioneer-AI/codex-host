import {
  THREAD_MANUAL_COMPACTION_STARTED_METHOD,
  threadManualCompactionStartedSchema,
} from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type RendererMethod = (...args: unknown[]) => unknown;

/**
 * Desktop 26.924.22138 holds a queued follow-up after a completed Turn unless
 * that Turn has an Agent Message or a contextCompaction whose source is
 * "manual". Desktop assigns that source from a client-side registration made
 * by its own compactThread; the compaction Item's wire fields cannot set it.
 *
 * Host sends THREAD_MANUAL_COMPACTION_STARTED_METHOD right before the
 * compaction Item of a user-invoked Harness command Turn. Registering it here
 * lets Desktop's next item/started for the Thread consume the registration,
 * exactly as it does for its own manual compaction.
 */
export function installRendererManualCompaction(target: unknown): (() => void) | null {
  if (
    !isRecord(target) ||
    typeof target.addNotificationCallback !== "function" ||
    typeof target.registerPendingManualContextCompaction !== "function" ||
    typeof target.getConversation !== "function"
  ) {
    // Older or changed Desktop builds keep their current queue behavior.
    return null;
  }
  const register = target.registerPendingManualContextCompaction as RendererMethod;
  const getConversation = target.getConversation as RendererMethod;
  const getStreamRole =
    typeof target.getStreamRole === "function" ? (target.getStreamRole as RendererMethod) : null;
  const removeCallback: unknown = (target.addNotificationCallback as RendererMethod).call(
    target,
    THREAD_MANUAL_COMPACTION_STARTED_METHOD,
    (notification: unknown) => {
      if (!isRecord(notification)) return;
      if (notification.method !== THREAD_MANUAL_COMPACTION_STARTED_METHOD) return;
      const params = threadManualCompactionStartedSchema.safeParse(notification.params);
      if (!params.success) return;
      const { threadId } = params.data;
      const conversation: unknown = getConversation.call(target, threadId);
      // Desktop drops Items of an unknown conversation, which would strand the
      // registration; only Host-projected external Threads are eligible.
      if (
        !isRecord(conversation) ||
        conversation.id !== threadId ||
        conversation.modelProvider !== "codexhost"
      ) {
        return;
      }
      // A follower window ignores the Item, so its registration would never be consumed.
      const role: unknown = getStreamRole?.call(target, threadId);
      if (isRecord(role) && role.role === "follower") return;
      register.call(target, threadId);
    },
  );
  if (typeof removeCallback !== "function") return null;
  return () => {
    (removeCallback as () => void)();
  };
}
