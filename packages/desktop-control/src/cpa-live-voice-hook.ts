export const CPA_LIVE_VOICE_ENV = "CODEXHOST_CPA_LIVE_VOICE";
export const CPA_LIVE_VOICE_HOOK_GLOBAL = "__codexhostCpaLiveVoiceHookV1";
export const AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION = "26.1007.30912";
export const AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET = "app-initial-6350d04672d0.js";

export function cpaLiveVoiceHookEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[CPA_LIVE_VOICE_ENV] !== "0";
}

export function cpaLiveVoiceHookBootstrap(environment: NodeJS.ProcessEnv = process.env): string {
  if (!cpaLiveVoiceHookEnabled(environment)) return "";
  return `globalThis.${CPA_LIVE_VOICE_HOOK_GLOBAL} = Object.freeze(${JSON.stringify({
    enabled: true,
    auditedDesktopVersion: AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
    auditedAppInitialAsset: AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  })});\n`;
}
