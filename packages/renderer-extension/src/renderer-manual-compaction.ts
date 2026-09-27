import {
  THREAD_MANUAL_COMPACTION_STARTED_METHOD,
  threadManualCompactionStartedSchema,
} from "@codexhost/shared-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type RendererMethod = (...args: unknown[]) => unknown;
type RendererMessageListener = (event: { data?: unknown; source?: unknown }) => void;

/** The Renderer window, which receives every Host message Desktop posts to it. */
export interface RendererMessageTarget {
  addEventListener(type: "message", listener: RendererMessageListener): void;
  removeEventListener(type: "message", listener: RendererMessageListener): void;
}

/**
 * Desktop 26.924 holds a queued follow-up after a completed Turn unless that
 * Turn has an Agent Message or a contextCompaction whose source is "manual".
 * Desktop assigns that source from a client-side registration made by its own
 * compactThread; the compaction Item's wire fields cannot set it.
 *
 * Host sends THREAD_MANUAL_COMPACTION_STARTED_METHOD right before the
 * compaction Item of a user-invoked Harness command Turn. Registering it here
 * lets Desktop's next item/started for the Thread consume the registration,
 * exactly as it does for its own manual compaction.
 *
 * Desktop's Renderer passes a Host notification on to the Manager, and so to
 * addNotificationCallback, only when the method is in its own app-server
 * notification table, which drops codexhost methods. The Electron main process
 * still posts every Host notification to the window as an `mcp-notification`
 * message, so this binding reads that message. Window messages are dispatched
 * in arrival order, so the registration exists before Desktop handles the
 * item/started message that follows it.
 */
export function installRendererManualCompaction(
  target: unknown,
  hostId: string,
  messages: RendererMessageTarget | null,
): (() => void) | null {
  if (
    !messages ||
    typeof messages.addEventListener !== "function" ||
    typeof messages.removeEventListener !== "function" ||
    !isRecord(target) ||
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
  const listener: RendererMessageListener = (event) => {
    // Desktop accepts Host messages only from its own window; so does this binding.
    if (event.source != null && event.source !== messages) return;
    const message = event.data;
    if (
      !isRecord(message) ||
      message.type !== "mcp-notification" ||
      message.hostId !== hostId ||
      message.method !== THREAD_MANUAL_COMPACTION_STARTED_METHOD
    ) {
      return;
    }
    const params = threadManualCompactionStartedSchema.safeParse(message.params);
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
  };
  messages.addEventListener("message", listener);
  return () => {
    messages.removeEventListener("message", listener);
  };
}
