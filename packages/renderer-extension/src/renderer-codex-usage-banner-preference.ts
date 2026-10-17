export const CODEX_USAGE_BANNER_STORAGE_KEY = "codexhost.codex-usage-banner-hidden.v1";
export const CODEX_USAGE_BANNER_CHANGE_EVENT = "codexhost:codex-usage-banner-changed";

/** Hide the native Codex out-of-usage card on every Composer. Default on. */
export function readCodexUsageBannerPreference(owner: Window | null | undefined): boolean {
  if (!owner) return true;
  try {
    return owner.localStorage.getItem(CODEX_USAGE_BANNER_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeCodexUsageBannerPreference(owner: Window, enabled: boolean): boolean {
  try {
    owner.localStorage.setItem(CODEX_USAGE_BANNER_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    return false;
  }
  owner.dispatchEvent(new Event(CODEX_USAGE_BANNER_CHANGE_EVENT));
  return true;
}
