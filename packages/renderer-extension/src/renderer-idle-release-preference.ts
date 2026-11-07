import {
  DEFAULT_IDLE_RELEASE_SETTINGS,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  HARNESS_PREFERENCES_UPDATED_EVENT,
  rendererHarnessPreferences,
  rendererHarnessPreferenceStatus,
  writeRendererHarnessPreferences,
} from "./renderer-harness-preferences.js";

/** Legacy key is read by the one-time migration only. */
export const IDLE_RELEASE_STORAGE_KEY = "codexhost.idle-release.v1";
export const IDLE_RELEASE_CHANGE_EVENT = "codexhost:idle-release-changed";
export const IDLE_RELEASE_STATUS_EVENT = "codexhost:idle-release-status";
export type IdleReleaseSyncStatus = "pending" | "applied" | "unavailable" | "failed";
export function readIdleReleasePreference(owner: Window): IdleReleaseSettings {
  void owner;
  return { ...(rendererHarnessPreferences()?.values.idleRelease ?? DEFAULT_IDLE_RELEASE_SETTINGS) };
}
export function writeIdleReleasePreference(owner: Window, value: IdleReleaseSettings): boolean {
  const parsed = idleReleaseSettingsSchema.safeParse(value);
  if (
    !parsed.success ||
    !rendererHarnessPreferences() ||
    rendererHarnessPreferenceStatus() === "unavailable"
  )
    return false;
  void writeRendererHarnessPreferences(owner, "local", [
    { kind: "idleRelease", value: parsed.data },
  ]).catch(() => {});
  return true;
}
/** Settings controls observe confirmed Host policy; reconnect never pushes a browser cache. */
export function installIdleReleasePreferenceSync(owner: Window) {
  let disposed = false;
  const publish = () => {
    if (disposed) return;
    owner.dispatchEvent(
      new CustomEvent(IDLE_RELEASE_STATUS_EVENT, { detail: rendererHarnessPreferenceStatus() }),
    );
    owner.dispatchEvent(new Event(IDLE_RELEASE_CHANGE_EVENT));
  };
  const changed = () => publish();
  owner.addEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, changed);
  return {
    connect(client: RendererModelClient | null) {
      void client;
      publish();
    },
    dispose() {
      disposed = true;
      owner.removeEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, changed);
    },
  };
}
