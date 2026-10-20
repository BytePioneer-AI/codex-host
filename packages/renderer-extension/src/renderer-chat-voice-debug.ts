const CHAT_VOICE_DEBUG_GLOBAL = "__codexhostChatVoiceDebug";
const CHAT_VOICE_DEBUG_STORAGE_KEY = "codexhost.chat-voice-debug.v1";

export function chatVoiceDebug(
  event: string,
  detail: Record<string, string | number | boolean> = {},
): void {
  const entry = { t: Date.now(), event, ...detail };
  const owner = globalThis as unknown as {
    console?: { info?: (...args: unknown[]) => void };
    localStorage?: Storage;
  } & Record<string, unknown>;
  const log = Array.isArray(owner[CHAT_VOICE_DEBUG_GLOBAL])
    ? (owner[CHAT_VOICE_DEBUG_GLOBAL] as unknown[])
    : [];
  log.push(entry);
  while (log.length > 40) log.shift();
  owner[CHAT_VOICE_DEBUG_GLOBAL] = log;
  try {
    owner.localStorage?.setItem(CHAT_VOICE_DEBUG_STORAGE_KEY, JSON.stringify(log));
  } catch {
    /* Overlay storage can be quota-limited. */
  }
  owner.console?.info?.("[codexhost-chat-voice]", event, detail);
}
