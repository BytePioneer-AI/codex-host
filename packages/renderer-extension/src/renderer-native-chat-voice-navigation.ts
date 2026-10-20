import type { NativeChatVoiceBinding } from "./renderer-native-chat-voice.js";

type NativeModule = Record<string, unknown>;

interface VoiceState {
  isVoiceModeActive: boolean;
  isWorkMode: boolean;
  conversationId: unknown;
  hasVoiceSessionStarted: boolean;
  earlyServerThreadId?: unknown;
  server: { connectionState: unknown };
}

const CONVERSATION_UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

/** The conversation page needs a server-owned Chat, beyond a connected transport. */
async function waitForConversation(
  store: { getState(): VoiceState; subscribe(listener: () => void): () => void },
  current: () => boolean,
  backendId: () => unknown,
  signal: AbortSignal,
): Promise<string | false> {
  const ready = () => {
    const state = store.getState();
    if (signal.aborted || !current() || !state.isVoiceModeActive) return false;
    if (!state.hasVoiceSessionStarted || state.server.connectionState !== "connected") return;
    const mapped = backendId();
    const id = mapped ?? state.earlyServerThreadId;
    if (
      typeof id === "string" &&
      CONVERSATION_UUID.test(id) &&
      (state.earlyServerThreadId == null || state.earlyServerThreadId === id)
    )
      return id;
  };
  const initial = ready();
  if (initial !== undefined) return initial;
  return new Promise((resolve) => {
    const check = () => {
      const result = ready();
      if (result === undefined) return;
      unsubscribe();
      signal.removeEventListener("abort", check);
      resolve(result);
    };
    const unsubscribe = store.subscribe(check);
    signal.addEventListener("abort", check, { once: true });
    check();
  });
}

/** Native START stores draft voice messages without selecting the conversation page. */
export async function navigateNativeChatVoiceDraft(
  binding: NativeChatVoiceBinding,
  initial: NativeModule,
  shared: NativeModule,
  origin: unknown,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    signal.aborted ||
    binding.backendConversationId !== undefined ||
    !binding.props.conversationId.startsWith("local-chatgpt:") ||
    origin == null ||
    binding.scope.get(initial.FFr) !== origin
  )
    return false;
  const voiceStore = Reflect.apply(initial.ejn as (...args: unknown[]) => unknown, undefined, [
    binding.scope,
  ]) as {
    getState(): VoiceState;
    subscribe(listener: () => void): () => void;
  };
  const current = () => {
    const state = voiceStore.getState();
    return (
      binding.scope.get(initial.FFr) === origin &&
      state.isWorkMode === false &&
      state.conversationId === binding.props.conversationId
    );
  };
  const id = await waitForConversation(
    voiceStore,
    current,
    () => binding.scope.get(initial.pZn, binding.props.conversationId),
    signal,
  );
  if (id === false || signal.aborted || !current() || !voiceStore.getState().isVoiceModeActive)
    return false;
  // Both IDs come from this native session's store. A draft locator is never a page ID.
  const path = Reflect.apply(shared.xat as (...args: unknown[]) => unknown, undefined, [id]);
  const accepted = await Reflect.apply(initial.uIr as (...args: unknown[]) => unknown, undefined, [
    binding.scope,
    path,
  ]);
  return accepted !== false;
}
