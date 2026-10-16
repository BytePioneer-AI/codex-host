export const CPA_LIVE_VOICE_STORAGE_KEY = "codexhost.cpa-live-voice.v1";
export const CPA_LIVE_VOICE_CHANGE_EVENT = "codexhost:cpa-live-voice-changed";

export function readCpaLiveVoicePreference(owner: Window): boolean {
  try {
    return owner.localStorage.getItem(CPA_LIVE_VOICE_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeCpaLiveVoicePreference(owner: Window, enabled: boolean): boolean {
  try {
    owner.localStorage.setItem(CPA_LIVE_VOICE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    return false;
  }
  owner.dispatchEvent(new Event(CPA_LIVE_VOICE_CHANGE_EVENT));
  return true;
}

export function cpaLiveVoicePreferenceAllowsInstall(globalObject: object): boolean {
  const storage = (globalObject as { localStorage?: Storage }).localStorage;
  if (!storage) return true;
  try {
    return storage.getItem(CPA_LIVE_VOICE_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}
