import type { NativeChatVoiceBinding } from "./renderer-native-chat-voice.js";

type NativeModule = Record<string, unknown>;

interface VoiceState {
  isVoiceModeActive: boolean;
  isWorkMode: boolean;
  conversationId: unknown;
  hasConnectedOnce: boolean;
}

/** START acknowledges its queued command before transport setup completes. */
async function waitForConnection(
  store: { getState(): VoiceState; subscribe(listener: () => void): () => void },
  current: () => boolean,
  signal: AbortSignal,
): Promise<boolean> {
  const ready = () => {
    const state = store.getState();
    if (signal.aborted || !current() || !state.isVoiceModeActive) return false;
    return state.hasConnectedOnce ? true : undefined;
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
  if (!(await waitForConnection(voiceStore, current, signal)) || signal.aborted || !current())
    return false;
  // xat formats a native Chat locator; uIr uses the AppScope navigation bridge.
  // The store owns mapping this draft to its server UUID and streaming transcript.
  const path = Reflect.apply(shared.xat as (...args: unknown[]) => unknown, undefined, [
    binding.props.conversationId,
  ]);
  await Reflect.apply(initial.uIr as (...args: unknown[]) => unknown, undefined, [
    binding.scope,
    path,
  ]);
  return true;
}
