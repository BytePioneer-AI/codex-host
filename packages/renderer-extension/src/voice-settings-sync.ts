import { VOICE_SETTINGS_METHOD, voiceSettingsStateSchema } from "@codexhost/shared-contracts";
import { applySharedVoiceRoutes, legacyVoiceRoutes } from "./renderer-cpa-live-voice-preference.js";

export function desktopVoiceCallActive(owner: Window): boolean {
  const hook = Reflect.get(owner, "__codexhostNativeChatVoiceV1") as
    { activeCall?: boolean } | undefined;
  if (hook?.activeCall) return true;
  return [
    ...owner.document.querySelectorAll(
      'button[aria-label="End Voice"],button[aria-label="End voice"],button[aria-label="End voice chat"]',
    ),
  ].some((button) => button.getBoundingClientRect().width > 0);
}

/** Runtime polls the same console-owned snapshot as the two settings surfaces. */
export function startVoiceSettingsSync(
  owner: Window,
  request: (method: string, params: unknown) => Promise<unknown>,
  intervalMs = 2_000,
): () => void {
  let disposed = false;
  let busy = false;
  let revision = "";
  const id = crypto.randomUUID();
  const refresh = async () => {
    if (busy || disposed) return;
    busy = true;
    try {
      let state = voiceSettingsStateSchema.parse(
        await request(VOICE_SETTINGS_METHOD, {
          operation: "get",
          runtime: { id, revision, activeCall: desktopVoiceCallActive(owner) },
        }),
      );
      if (disposed) return;
      if (!state.initialized)
        state = voiceSettingsStateSchema.parse(
          await request(VOICE_SETTINGS_METHOD, {
            operation: "migrate",
            routes: legacyVoiceRoutes(owner),
          }),
        );
      if (!disposed && !desktopVoiceCallActive(owner)) {
        applySharedVoiceRoutes(owner, state.settings);
        revision = state.revision;
      }
    } catch {
      /* Retain the last applied route while the local Host reconnects. */
    } finally {
      busy = false;
    }
  };
  void refresh();
  const timer = owner.setInterval(() => void refresh(), intervalMs);
  return () => {
    disposed = true;
    owner.clearInterval(timer);
  };
}
