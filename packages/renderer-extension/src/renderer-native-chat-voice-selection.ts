import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import type { NativeChatVoiceBinding } from "./renderer-native-chat-voice.js";

type NativeModule = Record<string, unknown>;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

/** Select an adopted draft through the native page, which owns its canonical redirect.
 * An early voice server ID does not prove that the transcript store owns that Chat.
 */
export function nativeChatVoiceDraftSelection(
  binding: NativeChatVoiceBinding,
  initial: NativeModule,
  shared: NativeModule,
  origin: unknown,
  signal: AbortSignal,
): () => void {
  const draft = binding.props.conversationId;
  const navigate = initial.Nir;
  const conversationPath = shared.Vot;
  if (
    binding.backendConversationId !== undefined ||
    !draft.startsWith("local-chatgpt:") ||
    !UUID.test(draft.slice("local-chatgpt:".length)) ||
    origin == null ||
    initial.Ycr == null ||
    initial.n0n == null ||
    initial.Y1n == null ||
    typeof navigate !== "function" ||
    typeof conversationPath !== "function"
  )
    return () => {};
  const store = Reflect.apply(initial.SPn as (...args: unknown[]) => unknown, undefined, [
    binding.scope,
  ]) as {
    getState(): {
      isVoiceModeActive: boolean;
      isWorkMode: boolean;
      conversationId: unknown;
      voiceSessionId: unknown;
      hasVoiceSessionStarted: boolean;
      server: { connectionState: unknown };
    };
  };
  const stateAtStart = store.getState();
  const readIntentVersion =
    typeof initial.HJt === "function"
      ? () =>
          Reflect.apply(initial.HJt as (...args: unknown[]) => unknown, undefined, [binding.scope])
      : undefined;
  const version = readIntentVersion?.();
  const intentVersion =
    typeof version === "number" && Number.isSafeInteger(version) && version > 0
      ? version
      : undefined;
  let session = stateAtStart.voiceSessionId;
  let activeSeen = stateAtStart.isVoiceModeActive;
  let sessionStartedSeen = stateAtStart.hasVoiceSessionStarted;
  let finished = false;
  return () => {
    if (finished) return;
    try {
      const state = store.getState();
      if (
        signal.aborted ||
        binding.scope.get(initial.Ycr) !== origin ||
        (intentVersion !== undefined && readIntentVersion?.() !== intentVersion) ||
        (activeSeen &&
          (!state.isVoiceModeActive ||
            (state.voiceSessionId !== session &&
              (sessionStartedSeen || intentVersion === undefined))))
      ) {
        finished = true;
        return;
      }
      if (!state.isVoiceModeActive) return;
      if (!activeSeen) {
        session = state.voiceSessionId;
        activeSeen = true;
      }
      if (session !== state.voiceSessionId) {
        // Native prewarm adopts its cached ID within the same voice intent before
        // session startup. A new START increments HJt; established IDs stay fixed.
        session = state.voiceSessionId;
        chatVoiceDebug("native-chat-selection-startup-id-adopted");
      }
      sessionStartedSeen ||= state.hasVoiceSessionStarted;
      if (state.isWorkMode !== false || state.conversationId !== draft) {
        finished = true;
        return;
      }
      if (!state.hasVoiceSessionStarted || state.server.connectionState !== "connected") return;
      const backend = binding.scope.get(initial.B1n, draft);
      if (typeof backend !== "string" || !UUID.test(backend)) return;
      const mapping = binding.scope.get(initial.n0n, draft);
      const currentNode = binding.scope.get(initial.Y1n, draft);
      if (
        mapping == null ||
        typeof mapping !== "object" ||
        typeof currentNode !== "string" ||
        !(mapping as Record<string, { message?: unknown }>)[currentNode]?.message
      )
        return;
      // The voice navigation guard accepts its client draft. The page resolves the
      // adopted alias from the same store; never route using earlyServerThreadId.
      finished = true;
      const path = Reflect.apply(conversationPath, undefined, [draft]);
      const accepted = Reflect.apply(navigate, undefined, [binding.scope, path]);
      void Promise.resolve(accepted).then(
        (result) =>
          chatVoiceDebug(
            result === false
              ? "native-chat-selection-declined"
              : "native-chat-draft-selection-requested",
          ),
        () => chatVoiceDebug("native-chat-selection-failed"),
      );
    } catch {
      finished = true;
      chatVoiceDebug("native-chat-selection-failed");
    }
  };
}
