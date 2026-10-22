import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import type { ChatVoiceScope } from "./renderer-native-chat-voice.js";

/** Observe only audited lifecycle flags; native errors and session payloads stay private. */
export function observeNativeChatVoiceState(
  scope: ChatVoiceScope,
  initial: Record<string, unknown>,
): () => void {
  const store = Reflect.apply(initial.SPn as (...args: unknown[]) => unknown, undefined, [
    scope,
  ]) as {
    getState(): {
      isVoiceModeActive?: boolean;
      hasConnectedOnce?: boolean;
      hasVoiceSessionStarted?: boolean;
      earlyServerThreadId?: unknown;
      server?: { connectionState?: unknown };
    };
    subscribe(listener: () => void): () => void;
  };
  let last = "";
  const report = () => {
    const state = store.getState();
    const connection = state.server?.connectionState;
    const detail = {
      active: state.isVoiceModeActive === true,
      connectedOnce: state.hasConnectedOnce === true,
      sessionStarted: state.hasVoiceSessionStarted === true,
      serverConversationReady:
        typeof state.earlyServerThreadId === "string" &&
        /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(state.earlyServerThreadId),
      connection:
        typeof connection === "string" &&
        ["disconnected", "connecting", "connected", "reconnecting", "signalReconnecting"].includes(
          connection,
        )
          ? connection
          : "unknown",
    };
    const next = JSON.stringify(detail);
    if (next === last) return;
    last = next;
    chatVoiceDebug("native-chat-state", detail);
  };
  const unsubscribe = store.subscribe(report);
  report();
  return unsubscribe;
}
