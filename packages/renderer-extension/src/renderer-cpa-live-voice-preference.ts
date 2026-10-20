export const CPA_LIVE_VOICE_STORAGE_KEY = "codexhost.cpa-live-voice.v1";
export const CPA_LIVE_VOICE_CHANGE_EVENT = "codexhost:cpa-live-voice-changed";
export const CHAT_LIVE_VOICE_STORAGE_KEY = "codexhost.chat-live-voice.v1";
export const CHAT_LIVE_VOICE_CHANGE_EVENT = "codexhost:chat-live-voice-changed";

function readFlag(owner: object, key: string, enabledWhenUnset: boolean): boolean {
  const storage = (owner as { localStorage?: Storage }).localStorage;
  if (!storage) return enabledWhenUnset;
  try {
    const value = storage.getItem(key);
    return enabledWhenUnset ? value !== "0" : value === "1";
  } catch {
    return enabledWhenUnset;
  }
}

function writeFlag(owner: Window, key: string, event: string, enabled: boolean): boolean {
  try {
    owner.localStorage.setItem(key, enabled ? "1" : "0");
  } catch {
    return false;
  }
  owner.dispatchEvent(new Event(event));
  return true;
}

/** Work, Codex and external Harness voice. On unless the stored value is "0". */
export function readCpaLiveVoicePreference(owner: Window): boolean {
  return readFlag(owner, CPA_LIVE_VOICE_STORAGE_KEY, true);
}

export function writeCpaLiveVoicePreference(owner: Window, enabled: boolean): boolean {
  return writeFlag(owner, CPA_LIVE_VOICE_STORAGE_KEY, CPA_LIVE_VOICE_CHANGE_EVENT, enabled);
}

/** Chat-mode voice. Off unless the stored value is exactly "1". */
export function readChatLiveVoicePreference(owner: Window): boolean {
  return readFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, false);
}

export function writeChatLiveVoicePreference(owner: Window, enabled: boolean): boolean {
  return writeFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, CHAT_LIVE_VOICE_CHANGE_EVENT, enabled);
}

/** Work override state for the injected hook, which only exposes a global object. */
export function cpaLiveVoicePreferenceAllowsInstall(globalObject: object): boolean {
  return readFlag(globalObject, CPA_LIVE_VOICE_STORAGE_KEY, true);
}

/** Chat override state for the injected hook, which only exposes a global object. */
export function chatLiveVoicePreferenceAllowsOverride(globalObject: object): boolean {
  return readFlag(globalObject, CHAT_LIVE_VOICE_STORAGE_KEY, false);
}
