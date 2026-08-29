export const RENDERER_REASONING_DISPLAY_PREFERENCE_KEY = "codexhost.renderer.reasoning-display.v1";
export const RENDERER_REASONING_DISPLAY_PREFERENCE_EVENT = "codexhost:reasoning-display-preference";

export interface RendererReasoningPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function rendererStorage(): RendererReasoningPreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function storageForWindow(ownerWindow: Window | null): RendererReasoningPreferenceStorage | null {
  if (!ownerWindow) return null;
  try {
    return ownerWindow.localStorage;
  } catch {
    return null;
  }
}

export function readRendererReasoningDisplayPreference(
  storage: RendererReasoningPreferenceStorage | null = rendererStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeRendererReasoningDisplayPreference(
  enabled: boolean,
  storage: RendererReasoningPreferenceStorage | null = rendererStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY, String(enabled));
  } catch {
    // An unavailable preference store must not affect Harness routing or turns.
  }
}

export function setRendererReasoningDisplayPreference(
  enabled: boolean,
  ownerWindow: Window | null = typeof window === "undefined" ? null : window,
): void {
  writeRendererReasoningDisplayPreference(enabled, storageForWindow(ownerWindow));
  ownerWindow?.dispatchEvent(
    new CustomEvent(RENDERER_REASONING_DISPLAY_PREFERENCE_EVENT, {
      detail: { enabled },
    }),
  );
}
