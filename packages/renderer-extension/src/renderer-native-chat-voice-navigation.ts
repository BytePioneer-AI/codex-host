import type { NativeChatVoiceBinding } from "./renderer-native-chat-voice.js";

type NativeModule = Record<string, unknown>;

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
    getState(): { isVoiceModeActive: boolean; isWorkMode: boolean; conversationId: unknown };
  };
  const state = voiceStore.getState();
  if (
    !state.isVoiceModeActive ||
    state.isWorkMode !== false ||
    state.conversationId !== binding.props.conversationId
  )
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
