import { voiceRoutesSchema, type VoiceRoutes } from "@codexhost/shared-contracts";

const sharedRoutes = new WeakMap<object, VoiceRoutes>();
const SHARED_VOICE_CACHE = "codexhost.voice-routes-cache.v1";
function cachedRoutes(owner: object): VoiceRoutes | undefined {
  const memory = sharedRoutes.get(owner);
  if (memory) return memory;
  try {
    const storage = (owner as { localStorage?: Storage }).localStorage;
    const parsed = voiceRoutesSchema.safeParse(
      JSON.parse(storage?.getItem(SHARED_VOICE_CACHE) ?? "null"),
    ).data;
    if (parsed) sharedRoutes.set(owner, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}
export function applySharedVoiceRoutes(owner: object, routes: VoiceRoutes): void {
  const snapshot = voiceRoutesSchema.parse({
    chatExperience: routes.chatExperience,
    chatConnection: routes.chatConnection,
    workConnection: routes.workConnection,
  });
  sharedRoutes.set(owner, snapshot);
  try {
    (owner as { localStorage?: Storage }).localStorage?.setItem(
      SHARED_VOICE_CACHE,
      JSON.stringify(snapshot),
    );
  } catch {
    /* Memory retains the applied route if browser storage is unavailable. */
  }
}
export function nativeChatVoicePreferenceAllowsStart(owner: object): boolean {
  const routes = cachedRoutes(owner);
  return routes
    ? routes.chatExperience === "chatgpt"
    : !readFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, false);
}
export function legacyVoiceRoutes(owner: Window): VoiceRoutes {
  return {
    chatExperience: readFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, false) ? "codex" : "chatgpt",
    chatConnection: readFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, false) ? "gateway" : "desktop",
    workConnection: readFlag(owner, CPA_LIVE_VOICE_STORAGE_KEY, true) ? "gateway" : "desktop",
  };
}

export const CPA_LIVE_VOICE_STORAGE_KEY = "codexhost.cpa-live-voice.v1";
export const CHAT_LIVE_VOICE_STORAGE_KEY = "codexhost.chat-live-voice.v1";

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

/** Codex Work gateway choice; legacy storage is read only until shared migration. */
export function readCpaLiveVoicePreference(owner: Window): boolean {
  const routes = cachedRoutes(owner);
  return routes
    ? routes.workConnection === "gateway"
    : readFlag(owner, CPA_LIVE_VOICE_STORAGE_KEY, true);
}

/** Gateway is an explicit Codex Chat connection, independent of native ChatGPT. */
export function readChatLiveVoicePreference(owner: Window): boolean {
  const routes = cachedRoutes(owner);
  return routes
    ? routes.chatExperience === "codex" && routes.chatConnection === "gateway"
    : readFlag(owner, CHAT_LIVE_VOICE_STORAGE_KEY, false);
}

/** Work override state for the injected hook, which only exposes a global object. */
export function cpaLiveVoicePreferenceAllowsInstall(globalObject: object): boolean {
  return readCpaLiveVoicePreference(globalObject as Window);
}

/** Chat override state for the injected hook, which only exposes a global object. */
export function chatLiveVoicePreferenceAllowsOverride(globalObject: object): boolean {
  return readChatLiveVoicePreference(globalObject as Window);
}
